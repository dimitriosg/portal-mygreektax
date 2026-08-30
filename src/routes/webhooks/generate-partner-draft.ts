import { waitUntil } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /webhooks/generate-partner-draft
//
// The partner twin of generate-draft.ts. The "Follow up with partner" box calls
// this when Jim clicks "Draft with Brain" on a case. It runs the Brain in
// mode "partner", which drafts in Greek to the accountant partner and writes
// the result to case_partner_drafts. Nothing is sent: the draft loads back into
// the compose box, and the existing two step Send / Confirm send still applies.
//
// Async for the same reason as generate-draft and summarize-case: API Gateway
// caps the response at 30s and the Brain takes longer. Fire it, keep the
// isolate alive with waitUntil, return 202 with a baseline timestamp, and let
// the browser poll case_partner_drafts.
//
// Authorization is deliberately STRICTER than generate-draft.ts. That route
// verifies the bearer token identifies a user but never checks a role, despite
// its own comment claiming it is admin only, so any logged in account
// (including a partner's) passes it. This route drafts internal case reasoning
// addressed to a business counterparty, so it uses the user_roles check that
// the partner send path already does. Fixing generate-draft.ts is a separate
// change.
//
// Env (Cloudflare Worker secrets, already set for generate-draft.ts):
//   BRAIN_ORCHESTRATE_URL  -- the API Gateway URL ending /orchestrate
//   BRAIN_WEBHOOK_SECRET   -- the x-brain-secret value the Lambda checks

type GenerateBody = {
  // Either identifier works. conversation_id is what the case desk has on hand.
  case_serial_id?: unknown;
  conversation_id?: unknown;
  // Which partner the draft is for. Required: the Brain filters the case
  // timeline to this partner's correspondence (R6) and addresses the draft to
  // them, so drafting without knowing the recipient produces a draft that can
  // carry another partner's context.
  partner_email?: unknown;
};

function readString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const Route = createFileRoute("/webhooks/generate-partner-draft")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const orchestrateUrl = process.env.BRAIN_ORCHESTRATE_URL;
        const brainSecret = process.env.BRAIN_WEBHOOK_SECRET;

        if (!orchestrateUrl || !brainSecret) {
          console.error(
            "[generate-partner-draft] BRAIN_ORCHESTRATE_URL or BRAIN_WEBHOOK_SECRET not set",
          );
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
        if (userError || !userData?.user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        // getUser() authenticates the caller; it does not authorize them. Same
        // check, and the same reasoning, as the partner send path in
        // send-approved.ts.
        const { data: roleRows, error: roleError } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "admin")
          .limit(1);
        if (roleError) {
          console.error("[generate-partner-draft] role check failed:", roleError.message);
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        if (!roleRows || roleRows.length === 0) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body: GenerateBody;
        try {
          body = (await request.json()) as GenerateBody;
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const caseSerialId = readString(body.case_serial_id);
        const conversationIdInput = readString(body.conversation_id);
        const partnerEmailInput = readString(body.partner_email);

        if (!caseSerialId && !conversationIdInput) {
          return Response.json(
            { error: "case_serial_id or conversation_id is required" },
            { status: 400 },
          );
        }

        if (!partnerEmailInput || !EMAIL_RE.test(partnerEmailInput)) {
          return Response.json({ error: "Valid partner_email is required" }, { status: 400 });
        }

        // The recipient must be an ACTIVE partner, checked here rather than
        // trusted from the browser. Same guard, and the same ILIKE-wildcard
        // escaping, as lib/partner-recipient.server.ts: EMAIL_RE permits %
        // and _, so without escaping a crafted address could pattern-match a
        // real partner.
        const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

        const { data: partnerRows, error: partnerError } = await supabaseAdmin
          .from("partner_profiles")
          .select("email, full_name")
          .is("disabled_at", null)
          .ilike("email", escapeLike(partnerEmailInput))
          .limit(1);

        if (partnerError) {
          console.error("[generate-partner-draft] partner lookup failed", { partnerError });
          return Response.json(
            { error: "Lookup failed", detail: partnerError.message },
            { status: 500 },
          );
        }
        if (!partnerRows || partnerRows.length === 0) {
          return Response.json(
            {
              error: "Recipient is not an active partner",
              detail: `${partnerEmailInput} is not in partner_profiles or is disabled.`,
            },
            { status: 422 },
          );
        }

        // Use the canonical address from the database, never the raw request
        // value, so what the Brain filters on matches what the send path will
        // accept.
        const partnerEmail = partnerRows[0].email as string;
        const partnerName = (partnerRows[0].full_name as string | null) ?? null;

        // Resolve to the conversation row so the Brain gets a stable case_id
        // and the case is known to exist before an AI call is spent.
        const lookup = supabaseAdmin
          .from("brain_conversations")
          .select("id, case_serial_id")
          .limit(1);

        const { data: convRows, error: convError } = conversationIdInput
          ? await lookup.eq("id", conversationIdInput)
          : await lookup.eq("case_serial_id", caseSerialId!);

        if (convError) {
          console.error("[generate-partner-draft] conversation lookup failed", { convError });
          return Response.json(
            { error: "Lookup failed", detail: convError.message },
            { status: 500 },
          );
        }

        const conversation = convRows?.[0];
        if (!conversation) {
          return Response.json({ error: "Case not found" }, { status: 404 });
        }

        // The partner send path refuses a case with no serial, because the
        // MGT-REF-ID line is what routes the partner's reply back here. Fail
        // now rather than spending an AI call on a draft that cannot be sent.
        if (!conversation.case_serial_id) {
          return Response.json(
            {
              error: "Conversation has no case serial",
              detail:
                "A partner email needs a matchable MGT-REF-ID line, so the reply would be unroutable. Assign a case code first.",
            },
            { status: 422 },
          );
        }

        // Baseline so the client can tell when a genuinely new draft lands.
        const { data: existingDraft } = await supabaseAdmin
          .from("case_partner_drafts")
          .select("last_updated")
          .eq("case_id", conversation.id)
          .maybeSingle();

        const previousUpdatedAt =
          (existingDraft as { last_updated: string | null } | null)?.last_updated ?? null;

        // Fire and do NOT await. API Gateway invokes the Lambda synchronously,
        // so it runs to completion even once we drop the connection. The catch
        // is required: an unhandled rejection would take down the isolate.
        waitUntil(
          fetch(orchestrateUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-brain-secret": brainSecret,
            },
            body: JSON.stringify({
              record: {
                case_id: conversation.id,
                case_serial_id: conversation.case_serial_id,
                sender: "portal_partner_generate",
                mode: "partner",
                event_type: "partner_draft_requested",
                partner_email: partnerEmail,
                partner_name: partnerName,
              },
            }),
          }).catch((error) => {
            console.error("[generate-partner-draft] background call to Brain failed", { error });
          }),
        );

        return Response.json(
          {
            ok: true,
            accepted: true,
            caseSerialId: conversation.case_serial_id,
            conversationId: conversation.id,
            previousUpdatedAt,
          },
          { status: 202 },
        );
      },
    },
  },
});
