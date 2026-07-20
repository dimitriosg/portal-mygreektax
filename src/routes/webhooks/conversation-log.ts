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
          // 1. Locate the client row by email
          const { data: matches, error: findError } = await supabase
            .from("clients")
            .select("id, full_name, email")
            .ilike("email", email)
            .limit(1);

          if (findError) {
            throw new Error(`client lookup failed: ${findError.message}`);
          }

          const client = matches?.[0];
          if (!client) {
            // Unknown recipient: HTTP 200 so the Make scenario does not error
            return Response.json({ found: false });
          }

          // 2. Dedupe. If this Gmail message was already logged (a re-sync of an
          //    overlapping window), skip everything, including the activity bump.
          if (sourceMessageId) {
            const { data: dupes, error: dupeError } = await supabase
              .from("case_timeline")
              .select("id")
              .eq("source_message_id", sourceMessageId)
              .limit(1);

            if (dupeError) {
              throw new Error(`dedupe lookup failed: ${dupeError.message}`);
            }
            if (dupes && dupes.length > 0) {
              return Response.json({ found: true, clientId: client.id, duplicate: true });
            }
          }

          // 3. Stamp last activity on the client row
          const { error: updateError } = await supabase
            .from("clients")
            .update({ last_activity: new Date().toISOString() })
            .eq("id", client.id);

          if (updateError) {
            throw new Error(`last_activity stamp failed: ${updateError.message}`);
          }

          // 4. Populate the case timeline (AI engine entrypoint)
          if (textContent) {
            const isPartner = caseSerialId ? true : false;
            const isOutbound = (direction ?? "").toLowerCase() === "outbound";
            let targetCaseId = client.id;

            if (caseSerialId) {
              const { data: directoryRow } = await supabase
                .from("cases_directory")
                .select("id")
                .eq("case_serial_id", caseSerialId)
                .single();

              if (directoryRow) {
                targetCaseId = directoryRow.id;
              }
            }

            const payload: Record<string, unknown> = { text: textContent };
            if (subject) payload.subject = subject;

            const row: Record<string, unknown> = {
              case_id: targetCaseId,
              case_serial_id: caseSerialId || null,
              event_type: isOutbound
                ? "outbound_message"
                : isPartner
                  ? "partner_reply"
                  : "lead_received",
              sender: isOutbound ? "internal" : isPartner ? "partner" : "customer",
              payload,
            };
            // Backfilled Gmail messages must land at their real send time, not now(),
            // or the case history reads out of order.
            if (sentAt) row.created_at = sentAt;
            if (sourceMessageId) row.source_message_id = sourceMessageId;

            const { error: timelineError } = await supabase
              .from("case_timeline")
              .insert(row);

            if (timelineError) {
              console.error("[conversation-log] Supabase timeline insert failed:", timelineError);
            } else {
              console.log(`[conversation-log] logged interaction for case ID: ${targetCaseId}`);
            }
          }

          return Response.json({
            found: true,
            clientId: client.id,
            clientName: client.full_name,
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
