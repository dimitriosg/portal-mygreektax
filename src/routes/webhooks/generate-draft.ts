import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /webhooks/generate-draft
//
// The on-demand Brain trigger. The /drafts workspace calls this when Jim
// clicks "Generate draft" on a case. It is the ONLY way the Brain runs now:
// the old automatic Supabase database webhook (trigger_tax_brain) is being
// retired, so drafting happens when, and only when, Jim asks for it. That is
// the cost control -- no lead ever spends AI budget until this route is hit.
//
// Flow: verify the caller is an authenticated admin session, look up the
// case's conversation id, then call the same Brain API Gateway endpoint the
// old webhook used, with the same x-brain-secret header. The Brain reads the
// conversation, drafts, and writes the result back to the database. This
// route waits for that to finish and returns success or a real error, so the
// UI can show "draft ready" or "generation failed: <reason>" immediately
// instead of a silent spinner.
//
// Env (Cloudflare Worker secrets, set in the dashboard so a config deploy
// cannot wipe them):
//   BRAIN_ORCHESTRATE_URL  -- the API Gateway URL ending /orchestrate
//   BRAIN_WEBHOOK_SECRET   -- the x-brain-secret value the Lambda checks
//
// Both already exist inside the Supabase database webhook trigger_tax_brain;
// copy the same two values into the portal's Cloudflare secrets.

type GenerateBody = {
  // Either identifier works. case_serial_id is what the UI has on hand.
  case_serial_id?: unknown;
  conversation_id?: unknown;
};

function readString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export const Route = createFileRoute("/webhooks/generate-draft")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const orchestrateUrl = process.env.BRAIN_ORCHESTRATE_URL;
        const brainSecret = process.env.BRAIN_WEBHOOK_SECRET;

        if (!orchestrateUrl || !brainSecret) {
          console.error("[generate-draft] BRAIN_ORCHESTRATE_URL or BRAIN_WEBHOOK_SECRET not set");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        // This route is admin-only. Unlike the machine-to-machine lead-intake
        // route, this one is triggered by a logged-in human, so it must carry
        // a valid Supabase session. We verify the bearer token the browser
        // client sends and confirm the user exists. (If the portal has a
        // shared requireSupabaseAuth helper, swap this block for it -- kept
        // self-contained here so the file drops in without extra wiring.)
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

        let body: GenerateBody;
        try {
          body = (await request.json()) as GenerateBody;
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const caseSerialId = readString(body.case_serial_id);
        const conversationIdInput = readString(body.conversation_id);

        if (!caseSerialId && !conversationIdInput) {
          return Response.json(
            { error: "case_serial_id or conversation_id is required" },
            { status: 400 },
          );
        }

        // Resolve to the conversation row so we can hand the Brain a stable
        // case_id and confirm the case actually exists before spending a call.
        const lookup = supabaseAdmin
          .from("brain_conversations")
          .select("id, case_serial_id, customer_email, client_id")
          .limit(1);

        const { data: convRows, error: convError } = conversationIdInput
          ? await lookup.eq("id", conversationIdInput)
          : await lookup.eq("case_serial_id", caseSerialId!);

        if (convError) {
          console.error("[generate-draft] conversation lookup failed", { convError });
          return Response.json({ error: "Lookup failed", detail: convError.message }, { status: 500 });
        }

        const conversation = convRows?.[0];
        if (!conversation) {
          return Response.json({ error: "Case not found" }, { status: 404 });
        }

        // Call the Brain. Same endpoint and header the old auto-trigger used.
        // The Brain expects the shape { record: { case_id, sender, ... } }.
        // We send sender "portal_generate" so it is clearly an on-demand,
        // human-initiated draft in the timeline, and it is not on the Lambda's
        // non-triggering-sender list, so it will draft.
        try {
          const brainResponse = await fetch(orchestrateUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-brain-secret": brainSecret,
            },
            body: JSON.stringify({
              record: {
                case_id: conversation.id,
                case_serial_id: conversation.case_serial_id,
                sender: "portal_generate",
                event_type: "generate_requested",
              },
            }),
          });

          const rawText = await brainResponse.text();
          let parsed: unknown = null;
          try {
            parsed = rawText ? JSON.parse(rawText) : null;
          } catch {
            parsed = rawText;
          }

          if (!brainResponse.ok) {
            console.error("[generate-draft] Brain returned non-2xx", {
              status: brainResponse.status,
              body: parsed,
            });
            return Response.json(
              {
                error: "Draft generation failed",
                status: brainResponse.status,
                detail:
                  typeof parsed === "object" && parsed !== null && "error" in parsed
                    ? (parsed as Record<string, unknown>).error
                    : rawText.slice(0, 500),
              },
              { status: 502 },
            );
          }

          return Response.json({
            ok: true,
            caseSerialId: conversation.case_serial_id,
            conversationId: conversation.id,
            brain: parsed,
          });
        } catch (error) {
          console.error("[generate-draft] call to Brain failed", { error });
          return Response.json(
            {
              error: "Could not reach the Brain",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 502 },
          );
        }
      },
    },
  },
});
