import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Conversation Log webhook -- replaces the Airtable "Find Client" / "Create
// Message" / "Stamp Last activity" steps that the Conversation Logger
// (INBOUND) and (OUTBOUND) Make scenarios used to run directly against
// Airtable (base appBJ9yHC38YHvvSw, table tbl70xa6gossiWTMg).
//
// WHY THIS EXISTS (Jul 2026): since the Tally webhook lead-intake fix,
// NEW leads are created ONLY in Supabase's public.clients table -- they
// never touch Airtable. The old Conversation Logger scenarios searched
// Airtable directly for a matching client by email/thread ID, so for any
// lead created after the fix, that search silently finds nothing: no
// "Lead replied" Telegram ping, no last-activity stamp. This route gives
// Make a single place to look up a client that matches BOTH legacy
// Airtable-origin clients (which have airtable_id set) and Supabase-native
// clients (Tally leads), by searching Supabase directly.
//
// SCOPE (deliberately minimal): this route only (1) finds the client by
// email and (2) stamps last_activity. It does NOT persist full message
// bodies -- the old Airtable "Messages" table is not replicated here. If
// full inbound/outbound message history in the portal is wanted later,
// add a Supabase "messages" table and extend this route to insert into it
// (see TODO below). For now, Make's own execution log is g the audit trail
// for message content, same as any other webhook call.
//
// Auth: same shared-secret pattern as lead-intake.ts. Reuses
// LEAD_INTAKE_SECRET rather than adding a second Cloudflare Worker
// variable -- both routes are Make-to-portal machine calls with the same
// trust boundary. Split this into its own secret later if that stops
// being true (e.g. if Make's permissions ever need to differ per-route).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export const Route = createFileRoute("/webhooks/conversation-log")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.LEAD_INTAKE_SECRET;
        if (!secret) {
          console.error("[conversation-log] LEAD_INTAKE_SECRET not configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const provided = request.headers.get("x-lead-intake-secret");
        if (!provided || provided !== secret) {
          console.error("[conversation-log] rejected: missing or invalid shared secret");
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

        const email = readString(b.email, 200);
        const direction = readString(b.direction, 20); // "Inbound" | "Outbound", informational only
        if (!email || !EMAIL_PATTERN.test(email)) {
          return Response.json({ error: "Valid email is required" }, { status: 400 });
        }

        try {
          // Case-insensitive match, same intent as Airtable's {Email}='...'
          // formula. clients.email has an existing index (clients_email_idx
          // on lower(email)), so this is cheap.
          const { data: matches, error: findError } = await supabaseAdmin
            .from("clients")
            .select("id, full_name, email")
            .ilike("email", email)
            .limit(1);

          if (findError) {
            throw new Error(`client lookup failed: ${findError.message}`);
          }

          const client = matches?.[0];
          if (!client) {
            // Not an error -- plenty of inbound/outbound mail isn't tied to
            // an existing client (e.g. spam, non-lead correspondence).
            // Make's "Client found" filter reads this `found: false` and
            // skips the Telegram ping accordingly.
            return Response.json({ found: false });
          }

          const { error: updateError } = await supabaseAdmin
            .from("clients")
            .update({ last_activity: new Date().toISOString() })
            .eq("id", client.id);

          if (updateError) {
            throw new Error(`last_activity stamp failed: ${updateError.message}`);
          }

          // TODO (optional future work): insert into a Supabase "messages"
          // table here if full conversation history in the portal becomes
          // a requirement again, e.g.:
          //   await supabaseAdmin.from("messages").insert({
          //     client_id: client.id, direction, ...
          //   });

          return Response.json({
            found: true,
            clientId: client.id,
            clientName: client.full_name,
            direction: direction ?? null,
          });
        } catch (error) {
          console.error("[conversation-log] failed", { error });
          return Response.json(
            {
              error: "Failed to process conversation log",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
