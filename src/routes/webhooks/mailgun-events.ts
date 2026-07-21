import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Mailgun events webhook.
//
// Purpose: whenever you send a customer reply from the Gmail alias (which relays
// through Mailgun), Mailgun fires a `delivered` event carrying a storage URL.
// This route fetches the stored message from that URL, pulls the MGT-REF-ID
// token out of the body, and logs the reply into case_timeline as an outbound
// message, the same way conversation-log.ts logs inbound mail. It also updates
// email_send_log delivery status (delivered / failed).
//
// It captures ONLY Gmail-alias sends. Portal drafts already log themselves, and
// are tagged with the Mailgun variable src=portal so they are skipped here (see
// the companion note). That is what prevents double-logging.
//
// Env (Cloudflare Worker vars / secrets):
//   SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY  -> already set
//   MAILGUN_API_KEY                 -> Mailgun private API key, used to fetch the stored message
//   MAILGUN_WEBHOOK_SIGNING_KEY     -> optional; when set, incoming events are signature-verified
// -----------------------------------------------------------------------------

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
    return { configError: `Missing environment variable(s): ${missing.join(", ")}.` };
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

// Safe nested lookup: get(obj, "message", "headers", "message-id")
function get(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// Mailgun timestamps are Unix epoch seconds (float). Convert to ISO, or undefined.
function mailgunTsToIso(value: unknown): string | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const TOKEN_RE = /MGT-REF-ID:\s*\[(CS\d+-CLT\d+)\]/i;

function extractToken(...texts: (string | undefined)[]): string | undefined {
  for (const t of texts) {
    if (!t) continue;
    const m = t.match(TOKEN_RE);
    if (m) return m[1];
  }
  return undefined;
}

// Verify Mailgun's webhook signature: HMAC-SHA256(signing_key, timestamp + token).
async function verifyMailgunSignature(
  signingKey: string,
  timestamp: string,
  token: string,
  signature: string,
): Promise<boolean> {
  try {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(timestamp + token));
    const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    // constant-time-ish compare
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

const FAILURE_EVENTS = new Set(["failed", "permanent_fail", "temporary_fail"]);

export const Route = createFileRoute("/webhooks/mailgun-events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (typeof body !== "object" || body === null) {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        // Optional signature verification. Enforced only when the signing key is set,
        // so the route can ship before the key is configured.
        const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
        if (signingKey) {
          const ts = readString(get(body, "signature", "timestamp"), 64);
          const tok = readString(get(body, "signature", "token"), 256);
          const sig = readString(get(body, "signature", "signature"), 256);
          if (!ts || !tok || !sig || !(await verifyMailgunSignature(signingKey, ts, tok, sig))) {
            return Response.json({ error: "Bad signature" }, { status: 401 });
          }
        }

        const ed = get(body, "event-data");
        if (typeof ed !== "object" || ed === null) {
          // Not a Mailgun event we understand; ack so Mailgun does not retry.
          return Response.json({ ok: true, ignored: "no event-data" });
        }

        const event = readString(get(ed, "event"), 40)?.toLowerCase();
        const recipient = readString(get(ed, "recipient"), 200);
        const messageId = readString(get(ed, "message", "headers", "message-id"), 400);
        // Retrieve the stored message via the stable EU API host using storage.key.
        // The regional host in storage.url (storage-europe-west1.api.mailgun.net)
        // returns 530 / "Message not found" when fetched directly; api.eu.mailgun.net
        // with the storage key is the reliable retrieval endpoint for EU domains.
        const storageKey = readString(get(ed, "storage", "key"), 300);
        const domainName = readString(get(ed, "domain", "name"), 200) || "mygreektax.eu";
        const storageRaw = get(ed, "storage", "url");
        const storageUrl = storageKey
          ? `https://api.eu.mailgun.net/v3/domains/${domainName}/messages/${storageKey}`
          : Array.isArray(storageRaw)
            ? readString(storageRaw[0], 2000)
            : readString(storageRaw, 2000);
        const headerSubject = readString(get(ed, "message", "headers", "subject"), 500);
        const occurredAt = mailgunTsToIso(get(ed, "timestamp"));
        const severity = readString(get(ed, "severity"), 40);
        const reason =
          readString(get(ed, "reason"), 200) ??
          readString(get(ed, "delivery-status", "message"), 200);
        const src = readString(get(ed, "user-variables", "src"), 40)?.toLowerCase();

        const supa = getSupabase();
        if ("configError" in supa) {
          console.error("[mailgun-events] config error:", supa.configError);
          return Response.json({ error: "Server misconfigured", detail: supa.configError }, { status: 500 });
        }
        const supabase = supa.client;

        const result: Record<string, unknown> = { ok: true, event };

        try {
          // -------------------------------------------------------------------
          // 1. Delivery status on email_send_log (best-effort, matches by message_id).
          // -------------------------------------------------------------------
          if (messageId && event === "delivered") {
            const { error } = await supabase
              .from("email_send_log")
              .update({ status: "delivered" })
              .eq("message_id", messageId);
            if (error) console.error("[mailgun-events] email_send_log delivered update:", error.message);
            result.delivery = "delivered";
          } else if (messageId && event && FAILURE_EVENTS.has(event)) {
            const { error } = await supabase
              .from("email_send_log")
              .update({
                status: "failed",
                error_message: [severity, reason].filter(Boolean).join(" / ") || null,
              })
              .eq("message_id", messageId);
            if (error) console.error("[mailgun-events] email_send_log failed update:", error.message);
            result.delivery = "failed";
          }

          // -------------------------------------------------------------------
          // 2. Conversation capture: log the outbound reply into case_timeline.
          //    Only for delivered Gmail-alias sends that carry a storage URL.
          //    Portal sends (src=portal) already self-log, so they are skipped.
          // -------------------------------------------------------------------
          const shouldCapture = event === "delivered" && !!storageUrl && src !== "portal";
          if (shouldCapture) {
            const mailgunKey = process.env.MAILGUN_API_KEY;
            if (!mailgunKey) {
              console.error("[mailgun-events] MAILGUN_API_KEY not set; cannot fetch stored message");
              result.captured = false;
              result.captureError = "MAILGUN_API_KEY missing";
              return Response.json(result);
            }

            // Fetch the stored message (raw MIME parsed to JSON).
            const auth = "Basic " + btoa("api:" + mailgunKey);
            const stored = await fetch(storageUrl as string, {
              headers: { Authorization: auth, Accept: "application/json" },
            });
            if (!stored.ok) {
              console.error("[mailgun-events] storage fetch failed:", stored.status);
              result.captured = false;
              result.captureError = `storage fetch ${stored.status}`;
              return Response.json(result);
            }
            const msg = (await stored.json()) as Record<string, unknown>;
            const bodyPlain = readString(msg["body-plain"], 100000);
            const subject = readString(msg["subject"], 500) ?? headerSubject;
            const token = extractToken(bodyPlain, subject);

            if (!recipient) {
              result.captured = false;
              result.captureError = "no recipient on event";
              return Response.json(result);
            }

            // Match the client by recipient (the customer). Same as conversation-log.
            const { data: matches, error: findErr } = await supabase
              .from("clients")
              .select("id, full_name, email")
              .ilike("email", recipient)
              .limit(1);
            if (findErr) throw new Error(`client lookup failed: ${findErr.message}`);

            const client = matches?.[0];
            if (!client) {
              result.captured = false;
              result.captureReason = "recipient is not a client";
              return Response.json(result);
            }

            // Dedupe: skip if this Mailgun message id was already logged.
            if (messageId) {
              const { data: dupes, error: dupeErr } = await supabase
                .from("case_timeline")
                .select("id")
                .eq("source_message_id", messageId)
                .limit(1);
              if (dupeErr) throw new Error(`dedupe lookup failed: ${dupeErr.message}`);
              if (dupes && dupes.length > 0) {
                result.captured = false;
                result.duplicate = true;
                return Response.json(result);
              }
            }

            // Resolve case id: cases_directory by token, else the client row.
            let targetCaseId: string = client.id as string;
            if (token) {
              const { data: dir } = await supabase
                .from("cases_directory")
                .select("id")
                .eq("case_serial_id", token)
                .single();
              if (dir) targetCaseId = dir.id as string;
            }

            const payload: Record<string, unknown> = {};
            if (bodyPlain) payload.text = bodyPlain;
            if (subject) payload.subject = subject;

            const row: Record<string, unknown> = {
              case_id: targetCaseId,
              case_serial_id: token || null,
              event_type: "outbound_message",
              sender: "internal",
              payload,
            };
            if (occurredAt) row.created_at = occurredAt;
            if (messageId) row.source_message_id = messageId;

            const { error: insErr } = await supabase.from("case_timeline").insert(row);
            if (insErr) {
              console.error("[mailgun-events] timeline insert failed:", insErr.message);
              result.captured = false;
              result.captureError = insErr.message;
            } else {
              result.captured = true;
              result.caseId = targetCaseId;
              result.token = token ?? null;
            }
          }

          return Response.json(result);
        } catch (error) {
          console.error("[mailgun-events] processing error", { error });
          // Still return 200 so Mailgun does not retry-storm; the error is logged.
          return Response.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  },
});
