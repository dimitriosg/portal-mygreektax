import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivityEvent } from "@/lib/activity.server";
import { LEAD_URGENCY_OPTIONS } from "@/lib/leads-shared";

// WebhookLeadIntake -- Make's "Incoming Form" scenario POSTs the Tally
// payload here. As of the identity-linking work (Jul 2026) this route no
// longer calls createClientWithCode directly. Instead it calls the single
// database function resolve_case_for_inbound, which is now the ONE authority
// for both customer numbering AND case numbering.
//
// WHY THE CHANGE: customer identity used to be resolved in TypeScript
// (createClientWithCode) while case identity did not exist at all -- a lead
// created a customer row and nothing else, so the Brain had no case to work
// on. Email replies and partner replies arrive at Make's mailhook, not this
// route, so the "which case does this email belong to" logic MUST live in
// the database where every channel can reach it. Having it in one SQL
// function means the portal, the inbound mailhook, and the partner-reply
// logger all resolve cases the same way, with no risk of two numbering
// systems drifting apart.
//
// WHAT resolve_case_for_inbound DOES (all in one atomic, race-safe call):
//   1. Find the customer by email, or create one with the next CLT####-XX
//      code (same -XX-on-creation convention the portal already uses;
//      nationality is still set manually on review).
//   2. Find that customer's open case (stage not in Complete/Lost), or open
//      the next one, producing the MGT-CSxxx-CLTxxxx serial id.
//   3. Log the lead's message onto the case as a customer_email_received
//      event, so the case is ready to draft from.
// It deliberately does NOT trigger the Brain. Drafting is on-demand, from
// the /drafts workspace, so a new lead costs zero AI spend until Jim asks
// for a draft.
//
// Auth: unchanged. This route is machine-to-machine (Make), so it can't use
// the requireSupabaseAuth middleware. It is gated by the LEAD_INTAKE_SECRET
// Cloudflare Workers secret, sent as the X-Lead-Intake-Secret header.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

// Shape returned by the resolve_case_for_inbound SQL function (one row).
type ResolvedCase = {
  out_conversation_id: string;
  out_client_id: string;
  out_client_code: string | null;
  out_case_serial_id: string | null;
  out_case_number: number | null;
  out_is_new_customer: boolean;
  out_is_new_case: boolean;
};

export const Route = createFileRoute("/webhooks/lead-intake")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.LEAD_INTAKE_SECRET;
        if (!secret) {
          console.error("[lead-intake] LEAD_INTAKE_SECRET not configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const provided = request.headers.get("x-lead-intake-secret");
        if (!provided || provided !== secret) {
          console.error("[lead-intake] rejected: missing or invalid shared secret");
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (typeof body !== "object" || body === null) {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const b = body as Record<string, unknown>;

        const name = readString(b.name, 200);
        const email = readString(b.email, 200);
        if (!name || !email) {
          return Response.json({ error: "name and email are required" }, { status: 400 });
        }
        if (!EMAIL_PATTERN.test(email)) {
          return Response.json({ error: "Invalid email" }, { status: 400 });
        }

        const phone = readString(b.phone, 50);
        const situation = readString(b.situation, 4000);
        const source = readString(b.source, 100) ?? "Tally webhook";
        const rawUrgency = readString(b.urgency, 50);
        const urgency =
          rawUrgency && (LEAD_URGENCY_OPTIONS as readonly string[]).includes(rawUrgency)
            ? rawUrgency
            : undefined;

        // A stable external id for this submission, so a Make replay of the
        // same lead does not double-log the message (the SQL function dedups
        // on external_event_id). If Make ever forwards its own execution id
        // as b.event_id we prefer that; otherwise we build one from email +
        // a coarse timestamp bucket so genuine resubmissions minutes apart
        // still register while an immediate replay does not.
        const providedEventId = readString(b.event_id, 200);
        const externalEventId =
          providedEventId ?? `form:${email.toLowerCase()}:${Math.floor(Date.now() / 1000)}`;

        try {
          // THE single numbering + case-resolution authority. One atomic,
          // race-safe call does customer, case, and message logging. It does
          // NOT trigger the Brain -- drafting stays on-demand.
          const { data, error } = await supabaseAdmin
            .rpc("resolve_case_for_inbound", {
              p_email: email,
              p_name: name,
              p_nationality: null,
              p_message: situation ?? null,
              p_external_event_id: externalEventId,
              p_provider: "form",
              p_subject: "New consultation request",
            })
            .single<ResolvedCase>();

          if (error || !data) {
            throw new Error(error?.message ?? "resolve_case_for_inbound returned no row");
          }

          // Persist the lead's phone/urgency/source/notes onto the customer
          // record. resolve_case_for_inbound intentionally does not take
          // these (it only needs identity fields), so we patch them here in
          // the same request. Best-effort: a failure here must not fail the
          // whole intake, the case already exists.
          if (phone || urgency || situation || source) {
            const patch: Record<string, unknown> = {};
            if (phone) patch.phone = phone;
            if (urgency) patch.urgency = urgency;
            if (source) patch.source = source;
            if (situation) patch.notes = situation;

            const { error: patchError } = await supabaseAdmin
              .from("clients")
              .update(patch)
              .eq("id", data.out_client_id);

            if (patchError) {
              console.error("[lead-intake] customer detail patch failed", { patchError });
            }
          }

          await logActivityEvent({
            eventType: "lead_created",
            actorName: "Tally webhook (Make)",
            subjectLabel: name,
            metadata: {
              clientId: data.out_client_id,
              clientCode: data.out_client_code,
              caseSerialId: data.out_case_serial_id,
              caseNumber: data.out_case_number,
              isNewCustomer: data.out_is_new_customer,
              isNewCase: data.out_is_new_case,
              source: "tally_webhook",
            },
          });

          return Response.json({
            ok: true,
            id: data.out_client_id,
            clientCode: data.out_client_code,
            caseSerialId: data.out_case_serial_id,
            isNewCustomer: data.out_is_new_customer,
            isNewCase: data.out_is_new_case,
          });
        } catch (error) {
          console.error("[lead-intake] resolve_case_for_inbound failed", { error });
          return Response.json(
            {
              error: "Failed to create lead",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
