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
// It ALSO owns bounce and complaint handling. A permanent failure or a spam
// complaint writes public.suppressed_emails, which is the single authority the
// newsletter send query consults before mailing anyone. A temporary failure is
// logged and never suppresses: soft-bouncing a working mailbox out of the list
// is the classic way to lose a real subscriber.
//
// SECURITY: signature verification is MANDATORY. It used to be conditional on
// the signing key being present, which meant an unset key silently turned this
// into an open endpoint, and an open endpoint that writes suppressed_emails is
// a way for anyone to unsubscribe any address. The timestamp is checked as well
// as the signature, because Mailgun signs timestamp + token and an HMAC check
// on its own passes forever on a captured payload.
//
// Env (Cloudflare Worker vars / secrets):
//   SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY  -> already set
//   MAILGUN_API_KEY                 -> Mailgun private API key, used to fetch the stored message
//                                      and to send the complaint alert
//   MAILGUN_WEBHOOK_SIGNING_KEY     -> REQUIRED. Mailgun's HTTP webhook signing key, which is a
//                                      different secret from MAILGUN_API_KEY. Without it this
//                                      route refuses every request rather than accepting unverified ones.
//   MAILGUN_DOMAIN                  -> optional, defaults to mygreektax.eu. Same variable the
//                                      other send routes use.
//   MAILGUN_ALERT_TO                -> optional, defaults to jim@mygreektax.eu
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
    for (let i = 0; i < expected.length; i++)
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

// Mailgun replays are only possible inside this window, because the signature
// covers the timestamp. Five minutes is Mailgun's own documented tolerance and
// leaves room for clock skew without leaving a captured event useful for long.
const MAX_SIGNATURE_AGE_SECONDS = 300;

// The n8n send node records Mailgun's message id with angle brackets,
// <2026...@mygreektax.eu>, while the webhook reports message.headers.message-id
// without them. Comparing the two raw would silently never match and every
// delivery update would quietly do nothing, so normalise both sides.
function normalizeMessageId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const bare = trimmed.replace(/^<+/, "").replace(/>+$/, "");
  return bare || undefined;
}

type EventOutcome = {
  // Status written to email_send_log for this event.
  logStatus?: "delivered" | "failed" | "bounced" | "complained";
  // Reason written to suppressed_emails, when the address should never be mailed again.
  suppressReason?: "bounce" | "complaint" | "unsubscribe";
  // Whether this one is worth waking Jim for.
  alert?: boolean;
};

// Classify a Mailgun event. The severity split is the important part: only a
// PERMANENT failure suppresses. Mailgun reports both under event "failed" and
// distinguishes them with severity, and also still emits the older
// permanent_fail / temporary_fail event names, so both spellings are handled.
function classifyEvent(event: string | undefined, severity: string | undefined): EventOutcome {
  switch (event) {
    case "delivered":
      return { logStatus: "delivered" };
    case "complained":
      return { logStatus: "complained", suppressReason: "complaint", alert: true };
    case "unsubscribed":
      return { suppressReason: "unsubscribe" };
    case "permanent_fail":
      return { logStatus: "bounced", suppressReason: "bounce" };
    case "temporary_fail":
      return { logStatus: "failed" };
    case "failed":
      return severity === "permanent"
        ? { logStatus: "bounced", suppressReason: "bounce" }
        : { logStatus: "failed" };
    default:
      return {};
  }
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

// Alerts go through Mailgun's EU host, the same one the storage fetch uses.
// Never throws into the request path; callers catch.
async function sendAlert(subject: string, lines: string[]): Promise<void> {
  const apiKey = process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    console.error("[mailgun-events] MAILGUN_API_KEY not set; cannot send alert", { subject });
    return;
  }
  const to = process.env.MAILGUN_ALERT_TO || "jim@mygreektax.eu";
  // Same convention as send-approved, case-reply and partner-reply, rather than
  // a hardcoded domain: all four send through the one variable so a domain
  // change is a single edit instead of a hunt for the site that was missed.
  const domain = process.env.MAILGUN_DOMAIN || "mygreektax.eu";

  const form = new FormData();
  form.append("from", "MyGreekTax portal <hello@mygreektax.eu>");
  form.append("to", to);
  form.append("subject", subject);
  form.append("text", lines.join("\n"));

  // Bounded, because this runs on the webhook request path. The suppression
  // failure alert is awaited immediately before returning 500, so a stalled
  // Mailgun API would otherwise hang the handler until Mailgun times the
  // webhook out, and the retry would arrive having already committed writes.
  const response = await fetch(`https://api.eu.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa("api:" + apiKey) },
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    console.error("[mailgun-events] alert send failed", { subject, status: response.status });
  }
}

// A spam complaint is worth an interruption rather than a log line.
//
// complainantEmail, not "recipient": this file already uses `recipient` for the
// Mailgun event's recipient field, and sendAlert has its own `to`, so a third
// meaning of the same word here would be actively misleading.
async function sendComplaintAlert(
  complainantEmail: string,
  event: string | undefined,
  reason: string | undefined,
): Promise<void> {
  await sendAlert(`Spam complaint from ${complainantEmail}`, [
    `${complainantEmail} marked a MyGreekTax email as spam.`,
    "",
    `Event: ${event ?? "complained"}`,
    `Reason: ${reason ?? "not given"}`,
    "",
    "The address is now in suppressed_emails and will be excluded from every",
    "future send. No action is required to stop mailing them.",
    "",
    "Worth a look at what was sent to them, since complaints are the metric",
    "mailbox providers weigh most heavily.",
  ]);
}

// A suppression that could not be written is the failure most likely to go
// unnoticed. Answering 500 buys a Mailgun retry, but retries are finite: if
// Supabase is down long enough, Mailgun gives up and the suppression is lost
// with nothing to show for it but a Worker log nobody is reading. This is also
// the only warning you would get for a code bug that throws on every
// suppression, where the alternative is finding out when Mailgun disables the
// endpoint.
//
// Deliberately not rate limited. During an outage every retry of every event
// alerts, which is noisy, but the noise is proportional to how much is being
// lost and under-reporting this failure is far worse than over-reporting it.
async function sendSuppressionFailureAlert(
  suppressedEmail: string,
  suppressReason: string,
  detail: string,
): Promise<void> {
  await sendAlert(`Suppression FAILED for ${suppressedEmail}`, [
    `Could not write a suppression for ${suppressedEmail}.`,
    "",
    `Intended reason: ${suppressReason}`,
    `Database error: ${detail}`,
    "",
    "This address should never be mailed again but is NOT currently suppressed,",
    "so the next newsletter send would still include it.",
    "",
    "The route answered 500, so Mailgun will retry on a backoff and may still",
    "succeed on its own. Mailgun does give up eventually, so if these keep",
    "arriving the suppression needs writing by hand:",
    "",
    `  insert into public.suppressed_emails (email, reason)`,
    `  values ('${suppressedEmail}', '${suppressReason}')`,
    `  on conflict (email) do nothing;`,
  ]);
}

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

        // Signature verification, mandatory. A missing key is a configuration
        // fault, not a reason to accept the request: this route can suppress an
        // address, so failing open would let anyone unsubscribe anyone.
        const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
        if (!signingKey) {
          console.error("[mailgun-events] MAILGUN_WEBHOOK_SIGNING_KEY not configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const ts = readString(get(body, "signature", "timestamp"), 64);
        const tok = readString(get(body, "signature", "token"), 256);
        const sig = readString(get(body, "signature", "signature"), 256);
        if (!ts || !tok || !sig || !(await verifyMailgunSignature(signingKey, ts, tok, sig))) {
          console.error("[mailgun-events] rejected: bad signature");
          return Response.json({ error: "Bad signature" }, { status: 401 });
        }

        // Freshness. The signature covers timestamp + token and nothing else, so
        // it stays valid forever on a captured payload. Without this check a
        // single intercepted permanent-bounce event is a reusable suppression
        // weapon against any address it names.
        const signedAt = Number(ts);
        if (!Number.isFinite(signedAt)) {
          console.error("[mailgun-events] rejected: unparseable signature timestamp");
          return Response.json({ error: "Bad signature" }, { status: 401 });
        }
        const ageSeconds = Math.abs(Date.now() / 1000 - signedAt);
        if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) {
          console.error("[mailgun-events] rejected: stale signature", {
            age_seconds: Math.round(ageSeconds),
          });
          return Response.json({ error: "Stale signature" }, { status: 401 });
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
        // Lowercased for the same reason `event` is: classifyEvent compares
        // severity to "permanent", and a capitalised "Permanent" would fall
        // through to the temporary branch and skip the suppression entirely.
        // The failure direction matters, it silently drops a real bounce.
        const severity = readString(get(ed, "severity"), 40)?.toLowerCase();
        const reason =
          readString(get(ed, "reason"), 200) ??
          readString(get(ed, "delivery-status", "message"), 200);
        const src = readString(get(ed, "user-variables", "src"), 40)?.toLowerCase();

        const supa = getSupabase();
        if ("configError" in supa) {
          console.error("[mailgun-events] config error:", supa.configError);
          return Response.json(
            { error: "Server misconfigured", detail: supa.configError },
            { status: 500 },
          );
        }
        const supabase = supa.client;

        const result: Record<string, unknown> = { ok: true, event };

        try {
          // -------------------------------------------------------------------
          // 1. Delivery status on email_send_log, and suppression when the event
          //    means this address must never be mailed again.
          // -------------------------------------------------------------------
          const outcome = classifyEvent(event, severity);
          const detail = [severity, reason].filter(Boolean).join(" / ") || null;
          result.classified = {
            logStatus: outcome.logStatus ?? null,
            suppressReason: outcome.suppressReason ?? null,
          };

          // Suppression first. It is the write that actually protects the list,
          // so it must not be skipped if the status update below fails.
          //
          // ignoreDuplicates makes this an ON CONFLICT DO NOTHING, not the
          // update an upsert normally implies. That is deliberate: the first
          // reason an address was suppressed is the true one, and letting a
          // later bounce overwrite it would erase the fact that someone
          // reported spam, which is the more serious signal of the two.
          if (outcome.suppressReason && recipient) {
            const normalizedRecipient = recipient.toLowerCase();
            const { error: suppressError } = await supabase.from("suppressed_emails").upsert(
              {
                email: normalizedRecipient,
                reason: outcome.suppressReason,
                metadata: {
                  source: "mailgun-webhook",
                  event: event ?? null,
                  severity: severity ?? null,
                  reason: reason ?? null,
                  message_id: messageId ?? null,
                },
              },
              { onConflict: "email", ignoreDuplicates: true },
            );
            if (suppressError) {
              console.error("[mailgun-events] suppression write failed:", suppressError.message, {
                email_redacted: redactEmail(normalizedRecipient),
                reason: outcome.suppressReason,
              });
              // Ask Mailgun to retry. Everything else on this route answers 200
              // even on failure, to avoid a retry storm over best-effort logging,
              // but suppression is not best-effort: swallowing this would mean a
              // transient database error silently leaves a bounced or complaining
              // address on the list forever.
              //
              // IDEMPOTENCY IS LOAD BEARING IN TWO DIRECTIONS, AND THEY ARE THE
              // SAME ARGUMENT. Retrying is safe only because these writes are
              // idempotent: suppressed_emails.email is UNIQUE, setting a status
              // to 'bounced' twice matches setting it once, and the conversation
              // capture below dedupes on source_message_id. That same property is
              // why there is no seen-token replay store here, because a replay
              // can only repeat work that costs nothing to repeat.
              //
              // So if you ever make one of these writes non-idempotent, you
              // invalidate BOTH decisions at once: retries start duplicating
              // real effects, and replay protection stops being optional. Do not
              // change one without revisiting the other.
              result.suppressed = false;
              result.suppressError = suppressError.message;

              // Awaited, not fire-and-forget: the response is returned on the
              // next line and the isolate may stop executing after that.
              await sendSuppressionFailureAlert(
                normalizedRecipient,
                outcome.suppressReason,
                suppressError.message,
              ).catch((alertError: unknown) => {
                console.error("[mailgun-events] suppression failure alert failed", {
                  error: alertError,
                });
              });

              return Response.json(result, { status: 500 });
            } else {
              console.log("[mailgun-events] suppressed", {
                email_redacted: redactEmail(normalizedRecipient),
                reason: outcome.suppressReason,
              });
              result.suppressed = true;
            }
          } else if (outcome.suppressReason) {
            // An event that should suppress but names nobody. Rare and probably
            // malformed, but it would otherwise skip the write, answer 200, and
            // leave no trace that an address escaped suppression.
            //
            // Answers 200 rather than 500 on purpose. A retry cannot help: the
            // event will arrive without a recipient every time, so asking
            // Mailgun to resend it only burns its retry budget before it gives
            // up. The alert is the useful action, not the retry.
            console.error("[mailgun-events] suppression event carries no recipient", {
              event: event ?? null,
              reason: outcome.suppressReason,
            });
            result.suppressed = false;
            result.suppressError = "no recipient on event";

            await sendAlert("Suppression event with no recipient", [
              "A Mailgun event that should have suppressed an address arrived",
              "without a recipient, so nothing could be written.",
              "",
              `Event: ${event ?? "unknown"}`,
              `Intended reason: ${outcome.suppressReason}`,
              `Message id: ${messageId ?? "none"}`,
              "",
              "Not retried, because the event would arrive the same way again.",
              "Worth checking the Mailgun logs for that message id to find out",
              "which address it concerned.",
            ]).catch((alertError: unknown) => {
              console.error("[mailgun-events] no-recipient alert failed", { error: alertError });
            });
          }

          // Status update. Matched on the normalised message id, because the
          // sender stores it bracketed and the webhook reports it bare.
          const normalizedMessageId = normalizeMessageId(messageId);
          if (normalizedMessageId && outcome.logStatus) {
            const patch: Record<string, unknown> = { status: outcome.logStatus };
            if (outcome.logStatus !== "delivered") patch.error_message = detail;

            // .in() rather than .or() with an interpolated value: message_id
            // comes off the request body, and building a PostgREST filter string
            // out of caller-supplied text is a filter-injection shape even behind
            // a verified signature. .in() is escaped by the client.
            const { data: updated, error } = await supabase
              .from("email_send_log")
              .update(patch)
              .in("message_id", [normalizedMessageId, `<${normalizedMessageId}>`])
              .select("id");

            if (error) {
              console.error("[mailgun-events] email_send_log update:", error.message);
            } else if (!updated || updated.length === 0) {
              // Not an error: transactional mail and Gmail-alias sends are not
              // all logged here. Recorded so a systematic mismatch is visible
              // rather than silent.
              console.log("[mailgun-events] no email_send_log row matched", {
                status: outcome.logStatus,
              });
            }
            result.delivery = outcome.logStatus;
            result.logRowsUpdated = updated?.length ?? 0;
          }

          // A spam complaint against a list this small is worth interrupting for.
          // Non-fatal: the suppression above is what matters, the alert is courtesy.
          if (outcome.alert && recipient) {
            await sendComplaintAlert(recipient, event, reason).catch((alertError: unknown) => {
              console.error("[mailgun-events] complaint alert failed", { error: alertError });
            });
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
              console.error(
                "[mailgun-events] MAILGUN_API_KEY not set; cannot fetch stored message",
              );
              result.captured = false;
              result.captureError = "MAILGUN_API_KEY missing";
              return Response.json(result);
            }

            // Fetch the stored message (raw MIME parsed to JSON).
            //
            // Bounded for the same reason the alert send is. This one is
            // pre-existing rather than new, but it is the same hang on the same
            // request path, and fixing one of the two would leave the class only
            // half closed. Longer than the alert timeout because it pulls a
            // whole stored message rather than posting a short form.
            const auth = "Basic " + btoa("api:" + mailgunKey);
            const stored = await fetch(storageUrl as string, {
              headers: { Authorization: auth, Accept: "application/json" },
              signal: AbortSignal.timeout(20_000),
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
          // 200 for anything that did not need to suppress, so a failure in the
          // best-effort conversation capture does not provoke a retry storm.
          //
          // 500 when this event was supposed to suppress and we cannot prove it
          // did, so Mailgun retries rather than dropping a bounce or a complaint
          // on the floor. Erring towards a duplicate delivery is right here: the
          // writes are idempotent, and the alternative is an address that should
          // never be mailed again quietly staying on the list.
          const classified = result.classified as { suppressReason?: string | null } | undefined;
          const suppressReason = classified?.suppressReason;
          const confirmedSuppressed = result.suppressed === true;
          const lostSuppression = Boolean(suppressReason) && !confirmedSuppressed;
          const message = error instanceof Error ? error.message : String(error);

          // Same reasoning as the explicit failure path above: a suppression we
          // cannot confirm is the one failure that must not stay quiet, whether
          // it arrived as an error return or as a thrown exception.
          if (lostSuppression && recipient) {
            await sendSuppressionFailureAlert(
              recipient.toLowerCase(),
              suppressReason as string,
              message,
            ).catch((alertError: unknown) => {
              console.error("[mailgun-events] suppression failure alert failed", {
                error: alertError,
              });
            });
          }

          return Response.json(
            { ok: false, error: message },
            { status: lostSuppression ? 500 : 200 },
          );
        }
      },
    },
  },
});
