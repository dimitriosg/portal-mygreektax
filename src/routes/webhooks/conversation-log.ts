import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lazy, request-time client creation. Nothing touches the database or the
// environment at module load, so a missing variable can never crash the
// whole route module again. A misconfiguration returns a readable JSON
// error to Make instead of an HTML error page.
let cachedClient: SupabaseClient | undefined;

function getSupabase(): { client: SupabaseClient } | { configError: string } {
  if (cachedClient) return { client: cachedClient };

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    const missing = [
      ...(!url ? ["SUPABASE_URL (or VITE_SUPABASE_URL)"] : []),
      ...(!key ? ["SUPABASE_SERVICE_ROLE_KEY"] : []),
    ];
    return {
      configError: `Missing environment variable(s): ${missing.join(", ")}. Set SUPABASE_URL in wrangler.jsonc vars and SUPABASE_SERVICE_ROLE_KEY as a Secret in the Cloudflare dashboard, then redeploy.`,
    };
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client: cachedClient };
}

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

// Turn whatever Make sends for sent_at into an ISO timestamp. Falls back to
// null (endpoint then uses the DB default of now()) if it is unparseable.
function parseSentAt(value: unknown): string | undefined {
  const raw = readString(value, 40);
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export const Route = createFileRoute("/webhooks/conversation-log")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Optional shared secret. Enforced only when MGT_WEBHOOK_SECRET is
        // set on the Worker, so this file can be deployed first and the
        // secret added to Cloudflare and Make later without breaking runs.
        const expectedSecret = process.env.MGT_WEBHOOK_SECRET;
        if (expectedSecret) {
          const provided = request.headers.get("x-mgt-webhook-secret");
          if (provided !== expectedSecret) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
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
        const direction = readString(b.direction, 20);
        const caseSerialId = readString(b.case_serial_id, 100);
        const textContent = readString(b.text_content, 100000);
        const subject = readString(b.subject, 500);
        const sentAt = parseSentAt(b.sent_at);
        const sourceMessageId = readString(b.source_message_id, 200);

        if (!email || !EMAIL_PATTERN.test(email)) {
          return Response.json({ error: "Valid email is required" }, { status: 400 });
        }

        const supabaseResult = getSupabase();
        if ("configError" in supabaseResult) {
          console.error("[conversation-log] configuration error:", supabaseResult.configError);
          return Response.json(
            { error: "Server misconfigured", detail: supabaseResult.configError },
            { status: 500 },
          );
        }
        const supabase = supabaseResult.client;

        try {
          const isOutbound = (direction ?? "").toLowerCase() === "outbound";
          const isInternal = (direction ?? "").toLowerCase() === "internal";

          // 1. Resolve the conversation this event belongs to. The serial is the
          //    authority (it comes straight from the case), so try it first via
          //    brain_conversations. Fall back to the customer email if no serial
          //    was supplied. cases_directory is not used: it does not carry these
          //    rows. Everything writes to brain_events, the live spine the portal
          //    and the Brain both read.
          let conversationId: string | undefined;

          if (caseSerialId) {
            const { data: convRows, error: convError } = await supabase
              .from("brain_conversations")
              .select("id")
              .eq("case_serial_id", caseSerialId)
              .limit(1);
            if (convError) {
              throw new Error(`conversation lookup by serial failed: ${convError.message}`);
            }
            conversationId = convRows?.[0]?.id;
          }

          if (!conversationId) {
            const { data: convRows, error: convError } = await supabase
              .from("brain_conversations")
              .select("id")
              .ilike("customer_email", email)
              .order("created_at", { ascending: false })
              .limit(1);
            if (convError) {
              throw new Error(`conversation lookup by email failed: ${convError.message}`);
            }
            conversationId = convRows?.[0]?.id;
          }

          if (!conversationId) {
            // Nothing to attach to: 200 so the Make scenario does not error.
            return Response.json({ found: false });
          }

          // 2. Dedupe. A provider message id (Gmail/Mailgun) keeps re-syncs of an
          //    overlapping window from double-logging. The unique key on
          //    brain_events.external_event_id is the real guard; this is a cheap
          //    pre-check so a duplicate returns cleanly instead of throwing.
          const externalEventId = sourceMessageId
            ? `mg:${sourceMessageId}`
            : `${isOutbound ? "outbound" : isInternal ? "internal" : "inbound"}:${email}:${Date.now()}`;

          if (sourceMessageId) {
            const { data: dupes, error: dupeError } = await supabase
              .from("brain_events")
              .select("id")
              .eq("external_event_id", externalEventId)
              .limit(1);
            if (dupeError) {
              throw new Error(`dedupe lookup failed: ${dupeError.message}`);
            }
            if (dupes && dupes.length > 0) {
              return Response.json({ found: true, conversationId, duplicate: true });
            }
          }

          // 3. Write the event into brain_events with constraint-valid values.
          //    actor is one of customer/partner/dimitris/system; direction is
          //    inbound/outbound/internal; event_type is from the fixed enum.
          if (textContent) {
            const row: Record<string, unknown> = {
              conversation_id: conversationId,
              external_event_id: externalEventId,
              event_type: isOutbound
                ? "customer_email_sent"
                : isInternal
                  ? "internal_note"
                  : "customer_email_received",
              actor: isOutbound || isInternal ? "dimitris" : "customer",
              direction: isOutbound ? "outbound" : isInternal ? "internal" : "inbound",
              from_email: isOutbound || isInternal ? "hello@mygreektax.eu" : email,
              to_emails: isOutbound ? [email] : [],
              subject: subject ?? null,
              body_text: textContent,
            };
            // Backfilled messages must land at their real send time, not now(),
            // or the case history reads out of order.
            if (sentAt) row.occurred_at = sentAt;

            const { error: eventError } = await supabase
              .from("brain_events")
              .insert(row);

            if (eventError) {
              console.error("[conversation-log] brain_events insert failed:", eventError);
              throw new Error(`event insert failed: ${eventError.message}`);
            }
            console.log(`[conversation-log] logged ${direction ?? "event"} for conversation ${conversationId}`);
          }

          // 4. Best-effort activity stamp on the client row. Never fail the whole
          //    request over this: the event is already logged, which is the point.
          const { data: clientRows } = await supabase
            .from("clients")
            .select("id")
            .ilike("email", email)
            .limit(1);
          const clientId = clientRows?.[0]?.id;
          if (clientId) {
            await supabase
              .from("clients")
              .update({ last_activity: new Date().toISOString() })
              .eq("id", clientId);
          }

          return Response.json({
            found: true,
            conversationId,
            clientId: clientId ?? null,
            direction: direction ?? null,
          });
        } catch (error) {
          console.error("[conversation-log] failed processing event", { error });
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
