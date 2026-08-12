import { createFileRoute } from "@tanstack/react-router";
import { mailgunFailureResponse } from "@/lib/mailgun-error.server";
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
// Auth: the browser sends the caller's Supabase access token as a Bearer
// header. The route verifies it and requires the 'admin' role, same as
// case-create.ts and partner-reply.ts. See the block in the handler for why it
// is a user JWT and not a shared secret.
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

        // 1. Authenticate and authorise the caller.
        //
        // This route shipped with NO guard of any kind. It takes the
        // recipient, the subject and raw HTML straight from the request body
        // and sends them through Mailgun as hello@mygreektax.eu, so an
        // anonymous POST was a send-anything-as-us primitive. The only check
        // was that conversationId looked like a UUID, and nothing confirmed
        // the UUID belonged to a case, so any random v4 sent mail.
        //
        // A USER JWT, NOT A SHARED SECRET. The only caller is the browser
        // (case-reply-box.tsx), which already sends the signed-in user's
        // Supabase access token. A shared secret would have to be shipped
        // inside client JS to work from there, which is worse than no secret:
        // it looks like authentication while being readable by anyone who
        // opens devtools. Machine callers get secrets (see conversation-log.ts
        // and lead-intake.ts); browser callers get the session they already
        // hold.
        const authHeader = request.headers.get("authorization") || "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) return Response.json({ error: "Not authenticated" }, { status: 401 });

        const { data: userData, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !userData?.user) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        // getUser() authenticates the caller; it does not authorise them.
        // Sending client correspondence as the business is admin work, and a
        // partner account holds a perfectly valid session, so the role is
        // checked explicitly. Same query as case-create.ts and partner-reply.ts.
        const { data: roleRows, error: roleErr } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "admin")
          .limit(1);
        if (roleErr) {
          console.error("[case-reply] role check failed:", roleErr.message);
          return Response.json({ error: "Authorization check failed" }, { status: 500 });
        }
        if (!roleRows || roleRows.length === 0) {
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

        // 3. Bind the recipient to the case.
        //
        // The UUID test above proves only that conversationId is well formed.
        // Without a lookup the case is never confirmed to exist and the
        // recipient is free text, so an admin session (or a stolen one) could
        // mail any address in the world from hello@mygreektax.eu with a
        // made-up case id attached. Resolving the row and matching the address
        // against it means this endpoint can only write to a real case, and
        // only to the client that case belongs to.
        //
        // Both sides of the address the UI shows are accepted: review.$caseId
        // passes `client?.email || conversation?.customer_email`, so accepting
        // either keeps the reply box working when the two have drifted apart.
        const { data: convRow, error: convErr } = await supabase
          .from("brain_conversations")
          .select("id, customer_email, client_id")
          .eq("id", conversationId)
          .maybeSingle();
        if (convErr) {
          console.error("[case-reply] conversation lookup failed:", convErr.message);
          return Response.json(
            { error: "Lookup failed", detail: convErr.message },
            { status: 500 },
          );
        }
        if (!convRow) {
          return Response.json({ error: "Case not found" }, { status: 404 });
        }

        const allowedRecipients = new Set<string>();
        if (typeof convRow.customer_email === "string" && convRow.customer_email) {
          allowedRecipients.add(convRow.customer_email.toLowerCase());
        }
        if (typeof convRow.client_id === "string" && convRow.client_id) {
          // The error MUST be handled, not discarded. Dropping it would let a
          // transient failure on this lookup shrink allowedRecipients, and the
          // check below would then reject a perfectly legitimate reply as
          // "Recipient does not belong to this case" -- a server fault reported
          // as an authorization decision, which is both wrong and the kind of
          // thing that gets debugged in the wrong place for an hour. Fail loud
          // with a 500, same as the conversation lookup above.
          const { data: clientRow, error: clientErr } = await supabase
            .from("clients")
            .select("email")
            .eq("id", convRow.client_id)
            .maybeSingle();
          if (clientErr) {
            console.error("[case-reply] client lookup failed:", clientErr.message);
            return Response.json(
              { error: "Lookup failed", detail: clientErr.message },
              { status: 500 },
            );
          }
          if (typeof clientRow?.email === "string" && clientRow.email) {
            allowedRecipients.add(clientRow.email.toLowerCase());
          }
        }
        if (!allowedRecipients.has(toEmail.toLowerCase())) {
          console.error("[case-reply] recipient does not belong to conversation", {
            conversationId,
          });
          return Response.json(
            { error: "Recipient does not belong to this case" },
            { status: 403 },
          );
        }

        const domain = process.env.MAILGUN_DOMAIN || "mygreektax.eu";
        const mailgunKey = process.env.MAILGUN_API_KEY;
        if (!mailgunKey)
          return Response.json({ error: "MAILGUN_API_KEY not set" }, { status: 500 });

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
          // 4. Send via Mailgun (EU).
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
            return mailgunFailureResponse(
              "case-reply",
              mgRes.status,
              mgText,
              mgRes.headers.get("retry-after"),
            );
          }
          let mgId: string | undefined;
          try {
            mgId = (JSON.parse(mgText) as { id?: string }).id;
          } catch {
            /* ignore */
          }

          // 5. Log into brain_events so it shows in the case conversation.
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
