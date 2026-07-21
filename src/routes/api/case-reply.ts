import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Case reply box, server side.
//
// Sends a customer reply through Mailgun's EU API (from hello@mygreektax.eu) and
// logs it into brain_events so it appears in the case conversation on the review
// page. One call, no Make.
//
// Auth: the browser sends the caller's Supabase access token as a Bearer header.
// The route verifies it and requires the 'admin' role before sending.
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

function bodyToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\r?\n/g, "<br>");
}

// Standing signature. No em/en dashes anywhere.
const SIGNATURE_HTML =
  '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6; margin-top: 16px;">' +
  "Με εκτίμηση,<br>Δημήτρης<br>MyGreekTax</div>";

export const Route = createFileRoute("/webhooks/case-reply")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 1. Authenticate the caller.
        const authHeader = request.headers.get("authorization") || "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) return Response.json({ error: "Not authenticated" }, { status: 401 });

        const supa = getSupabase();
        if ("configError" in supa) {
          return Response.json({ error: "Server misconfigured", detail: supa.configError }, { status: 500 });
        }
        const supabase = supa.client;

        const { data: userData, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !userData?.user) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }
        const { data: roleRow } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "admin")
          .limit(1);
        if (!roleRow || roleRow.length === 0) {
          return Response.json({ error: "Not authorized (admin role required)" }, { status: 403 });
        }

        // 2. Read and validate input.
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
        const messageText = readString(b.body, 100000);
        const caseSerialId = readString(b.caseSerialId, 100);

        if (!conversationId || !UUID_RE.test(conversationId)) {
          return Response.json({ error: "Valid conversationId required" }, { status: 400 });
        }
        if (!toEmail || !EMAIL_RE.test(toEmail)) {
          return Response.json({ error: "Valid recipient email required" }, { status: 400 });
        }
        if (!messageText) {
          return Response.json({ error: "Message body required" }, { status: 400 });
        }

        const domain = process.env.MAILGUN_DOMAIN || "mygreektax.eu";
        const mailgunKey = process.env.MAILGUN_API_KEY;
        if (!mailgunKey) return Response.json({ error: "MAILGUN_API_KEY not set" }, { status: 500 });

        // Ref line so the customer's reply threads back to this case.
        const refCore = caseSerialId ? caseSerialId.replace(/^MGT-/i, "") : "";
        const refLineHtml = refCore
          ? '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #9ca3af; margin-top: 16px;">MGT-REF-ID: [' +
            refCore + "]</div>"
          : "";
        const html =
          '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6;">' +
          bodyToHtml(messageText) + "</div>" + SIGNATURE_HTML + refLineHtml;

        try {
          // 3. Send via Mailgun (EU).
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
          } catch { /* ignore */ }

          // 4. Log into brain_events so it shows in the case conversation.
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
            body_text: messageText,
            metadata: { via: "portal_reply_box" },
          });
          if (insErr) {
            // Email already went out; surface the logging error but don't fail hard.
            console.error("[case-reply] brain_events insert failed:", insErr.message);
            return Response.json({ ok: true, messageId: mgId ?? null, logged: false, logError: insErr.message });
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
