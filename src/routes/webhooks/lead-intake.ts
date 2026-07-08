import { createFileRoute } from "@tanstack/react-router";
import { createClientWithCode } from "@/lib/client-code.server";
import { logActivityEvent } from "@/lib/activity.server";
import { LEAD_URGENCY_OPTIONS } from "@/lib/leads-shared";

// WebhookLeadIntake ticket -- fixes the "blank Client Code" bug: leads
// created straight in Airtable by the Make "Incoming Form" scenario never
// went through client-code.server.ts, so they landed uncoded. Make now
// POSTs the Tally payload here instead of writing to Airtable directly.
//
// This is the ONLY new thing this ticket adds. Client Code numbering itself
// is NOT reimplemented here -- createClientWithCode (client-code.server.ts)
// stays the single numbering authority, called exactly like the portal's
// own createLead server fn calls it. Two callers, one generator, no risk of
// duplicate codes between a Tally-submitted lead and a portal-created one.
//
// MIGRATION NOTE (Jul 2026): createClientWithCode now writes to Supabase's
// "clients" table via the supabaseAdmin (service-role) client -- see
// client-code.server.ts header for why: public.clients has RLS enabled
// with zero policies, so only a service-role client can read/write it.
// Field keys below are the CONFIRMED real Supabase column names (checked
// live via SQL): full_name, email, phone, status, stage, source, urgency,
// notes -- all nullable text columns, no CHECK constraints, so
// "Prospect"/"Potential" are valid values as-is.
//
// Auth: this route is reachable with no Supabase session (Make is a
// machine, not a logged-in admin), so it can't use the requireSupabaseAuth
// middleware every other lead endpoint uses. Instead it's gated by a shared
// secret in the LEAD_INTAKE_SECRET Cloudflare Workers variable, sent by
// Make as the X-Lead-Intake-Secret header. Never logged, never in the repo.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export const Route = createFileRoute("/webhooks/lead-intake")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.LEAD_INTAKE_SECRET;
        if (!secret) {
          console.error("[lead-intake] LEAD_INTAKE_SECRET not configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const provided = request.headers.get("x_lead_intake_secret");
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
        const situation = readString(b.situation, 2000);
        const source = readString(b.source, 100) ?? "Tally webhook";
        const rawUrgency = readString(b.urgency, 50);
        const urgency =
          rawUrgency && (LEAD_URGENCY_OPTIONS as readonly string[]).includes(rawUrgency)
            ? rawUrgency
            : undefined;

        try {
          // THE single numbering authority (see file header) -- same
          // function, same call shape as leads.functions.ts's createLead.
          // Keys below are confirmed live Supabase column names. Writes
          // go through supabaseAdmin (service role) inside
          // createClientWithCode, which is required since public.clients
          // has RLS enabled with no policies.
          const created = await createClientWithCode({
            full_name: name,
            email: email,
            phone: phone,
            urgency: urgency,
            notes: situation,
            stage: "Potential",
            status: "Prospect",
            source: source,
          });

          // Best-effort -- same activity_events stream every other lead
          // create/edit writes to (Ticket C), so a Tally-submitted lead
          // shows up in that client's History exactly like a portal one.
          // Confirmed live columns: event_type, actor_name, subject_label,
          // metadata (jsonb), occurred_at (defaults handled by helper).
          await logActivityEvent({
            eventType: "lead_created",
            actorName: "Tally webhook (Make)",
            subjectLabel: name,
            metadata: { leadId: created.id, source: "tally_webhook" },
          });

          return Response.json({
            ok: true,
            id: created.id,
            clientCode: created["client_code"] ?? null,
          });
        } catch (error) {
          // Surface the real reason instead of a blanket message -- this is
          // what showed up as "Failed to create lead" with no detail before;
          // now Make's own execution log will show the actual cause.
          console.error("[lead-intake] createClientWithCode failed", { error });
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
