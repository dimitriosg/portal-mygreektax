import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Case reply box, server side.
//
// Sends a customer reply through Mailgun's EU API (from hello@mygreektax.eu) and
// logs it into brain_events so it appears in the case conversation on the review
// page. One call, no Make.
//
// The reply box (case-reply-box.tsx) posts the finished email as `bodyHtml`:
// already DOMPurify-sanitized and already carrying the signature (body + sig
// were stitched and cleaned on the client, mirroring AiReviewDesk). So the
// server does NOT escape it and does NOT append its own signature; it just
// wraps it in the base font div and appends the ref line. A plaintext `body`
// fallback is kept for any legacy caller: that path still escapes and appends
// the standing signature.
//
// Env (already present):
//   SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
//   MAILGUN_API_KEY, MAILGUN_DOMAIN (optional, defaults to mygreektax.eu)
// -----------------------------------------------------------------------------

let cachedClient: SupabaseClient | undefined;
function getSupabase(): { client: SupabaseClient } | { configError: string } {
  if (cachedClient) return { client: cachedClient };
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { configError: "Supabase env not configured" };
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client: cachedClient };
}

function readString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Legacy plaintext path only: escape and turn newlines into <br>.
function bodyToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\r?\n/g, "<br>");
}

// For the conversation log: reduce sent HTML to readable text, since the review
// page renders body_text as plain, pre-wrapped text.
function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BASE_FONT_OPEN =
  '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6;">';

// Standing signature, legacy plaintext path only. No em/en dashes anywhere.
const SIGNATURE_HTML =
  '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6; margin-top: 16px;">' +
  "Με εκτίμηση,<br>Δημήτρης<br>MyGreekTax</div>";

export const Route = createFileRoute("/webhooks/case-reply")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supa = getSupabase();
        if ("configError" in supa) {
          return Response.json(
            { error: "Server misconfigured", detail: supa.configError },
            { status: 500 },
          );
        }
        const supabase = supa.client;

        // 1. Read and validate input.
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const b = (raw ?? {}) as Record<string, unknown>;
        const conversationId = readString(b.conversationId, 100);
        const toEmail = readString(b.toEmail, 200);
        const subject = readString(b.subject, 500) || "(no subject)";
        const caseSerialId = readString(b.caseSerialId, 100);

        // Primary: sanitized HTML from the box (signature already included).
        // Fallback: legacy plaintext under `body`.
        const bodyHtmlInput = readString(b.bodyHtml, 100000);
        const bodyTextInput = readString(b.body, 100000);

        if (!conversationId || !UUID_RE.test(conversationId)) {
          return Response.json({ error: "Valid conversationId required" }, { status: 400 });
        }
        if (!toEmail || !EMAIL_RE.test(toEmail)) {
          return Response.json({ error: "Valid recipient email required" }, { status: 400 });
        }
        if (!bodyHtmlInput && !bodyTextInput) {
          return Response.json({ error: "Message body required" }, { status: 400 });
        }

        const domain = process.env.MAILGUN_DOMAIN || "mygreektax.eu";
        const mailgunKey = process.env.MAILGUN_API_KEY;
        if (!mailgunKey) return Response.json({ error: "MAILGUN_API_KEY not set" }, { status: 500 });

        // Ref line so the customer's reply threads back to this case.
        const refCore = caseSerialId ? caseSerialId.replace(/^MGT-/i, "") : "";
        const refLineHtml = refCore
          ? '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #9ca3af; margin-top: 16px;">MGT-REF-ID: [' +
            refCore +
            "]</div>"
          : "";

        // Build the email HTML and the text to log.
        let html: string;
        let logText: string;
        if (bodyHtmlInput) {
          // HTML path: trust the client's sanitized HTML (signature already in
          // it). Wrap once in the base font div, append the ref line. No extra
          // signature.
          html = BASE_FONT_OPEN + bodyHtmlInput + "</div>" + refLineHtml;
          logText = htmlToText(bodyHtmlInput);
        } else {
          // Legacy plaintext path: escape, then append the standing signature.
          html =
            BASE_FONT_OPEN +
            bodyToHtml(bodyTextInput as string) +
            "</div>" +
            SIGNATURE_HTML +
            refLineHtml;
          logText = bodyTextInput as string;
        }

        try {
          // 2. Send via Mailgun (EU).
          const form = new URLSearchParams();
          form.set("from", "MyGreekTax <hello@mygreektax.eu>");
          form.set("to", toEmail);
          form.set("bcc", "hello@mygreektax.eu");
          form.set("subject", subject);
          form.set("html", html);
          form.set("h:X-Mailgun-Variables", JSON.stringify({ src: "portal" }));

          const mgRes = await fetch(`https://api.eu.mailgun.net/v3/${domain}/messages`, {
            method: "POST",
            headers: {
              Authorization: "Basic " + btoa("api:" + mailgunKey),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
          });
          const mgText = await mgRes.text();
          if (!mgRes.ok) {
            console.error("[case-reply] mailgun send failed:", mgRes.status, mgText);
            return Response.json({ error: "Send failed", detail: mgText }, { status: 502 });
          }
          let mgId: string | undefined;
          try {
            mgId = (JSON.parse(mgText) as { id?: string }).id;
          } catch {
            /* ignore */
          }

          // 3. Log into brain_events so it shows in the case conversation.
          const externalEventId = mgId || `portal-reply-${crypto.randomUUID()}`;
          const { error: insErr } = await supabase.from("brain_events").insert({
            conversation_id: conversationId,
            external_event_id: externalEventId,
            event_type: "customer_email_sent",
            actor: "dimitris",
            direction: "outbound",
            provider: "mailgun",
            provider_message_id: mgId || null,
            from_email: "hello@mygreektax.eu",
            to_emails: [toEmail],
            subject,
            body_text: logText,
            metadata: { via: "portal_reply_box" },
          });
          if (insErr) {
            // Email already went out; surface the logging error but don't fail hard.
            console.error("[case-reply] brain_events insert failed:", insErr.message);
            return Response.json({
              ok: true,
              messageId: mgId ?? null,
              logged: false,
              logError: insErr.message,
            });
          }

          return Response.json({ ok: true, messageId: mgId ?? null, logged: true });
        } catch (error) {
          console.error("[case-reply] error", { error });
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      },
    },
  },
});
