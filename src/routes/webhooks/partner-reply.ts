import { createFileRoute } from "@tanstack/react-router";
import { mailgunFailureResponse } from "@/lib/mailgun-error.server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// POST /webhooks/partner-reply
//
// Sends a follow-up to an accountant partner and logs it as partner_email_sent,
// so it lands in the partner pane, never the client one.
//
// Mirrors case-reply.ts with three deliberate differences:
//
// 1. The recipient MUST be an active partner. The address is validated against
//    partner_profiles (disabled_at null) server-side, so this endpoint cannot
//    be used to mail a client, or anyone else, whatever the browser sends.
//
// 2. No BCC to hello@mygreektax.eu. The client path BCCs for a mailbox record,
//    but hello@ forwards into the same Gmail the partner sync searches, and the
//    BCC copy would match (to: partner + ref core) and re-import as a duplicate
//    with a different provider id. The portal log written here is the record.
//
// 3. The MGT-REF-ID line is kept. It is the matching mechanism: the partner's
//    reply quotes it, and the Gmail sync finds the case by that core.
//
// 4. No signature. Partner mail carries none, deliberately: these are working
//    exchanges with counterparties we correspond with daily, not client
//    correspondence. The body ends where the writer ended it. The MGT-REF-ID
//    line below is routing metadata, not a sign-off, and stays.
//
// Plain text body in, HTML out. The body may be typed by hand in the case desk
// or loaded from the Brain's Greek partner draft (case_partner_drafts, written
// by the Lambda in mode "partner"); either way a human presses Confirm send.
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

function bodyToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\r?\n/g, "<br>");
}

const BASE_FONT_OPEN =
  '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6;">';

export const Route = createFileRoute("/webhooks/partner-reply")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const mailgunKey = process.env.MAILGUN_API_KEY;
        const domain = process.env.MAILGUN_DOMAIN || "mygreektax.eu";
        if (!mailgunKey) {
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const supabaseResult = getSupabase();
        if ("configError" in supabaseResult) {
          return Response.json(
            { error: "Server misconfigured", detail: supabaseResult.configError },
            { status: 500 },
          );
        }
        const supabase = supabaseResult.client;

        // Admin session required: a human presses send.
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        // getUser() only authenticates the caller; it does not authorize them.
        // This route sends mail on the business's behalf, so it must be admin
        // only, not just any logged-in session (a partner account would also
        // pass the check above). Queried directly against user_roles, with the
        // same service-role client already in scope, rather than assuming the
        // shape of a shared helper.
        const { data: roleRows, error: roleError } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "admin")
          .limit(1);
        if (roleError) {
          console.error("[partner-reply] role check failed:", roleError.message);
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        if (!roleRows || roleRows.length === 0) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const conversationId = readString(body.conversation_id, 60);
        const toEmail = readString(body.to_email, 200);
        const subject = readString(body.subject, 500);
        const bodyText = readString(body.body, 50000);

        if (!conversationId) {
          return Response.json({ error: "conversation_id is required" }, { status: 400 });
        }
        if (!toEmail || !EMAIL_RE.test(toEmail)) {
          return Response.json({ error: "Valid to_email is required" }, { status: 400 });
        }
        if (!subject || !bodyText) {
          return Response.json({ error: "subject and body are required" }, { status: 400 });
        }

        try {
          // 1. The recipient must be an ACTIVE partner. This is the guard that
          //    keeps this endpoint partner-only regardless of what the UI sends.
          // Escape ILIKE wildcards (% and _, both of which EMAIL_RE permits) so a
          // crafted address cannot pattern-match an active partner without being
          // an exact match.
          const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

          const { data: partnerRows, error: partnerError } = await supabase
            .from("partner_profiles")
            .select("email, full_name")
            .is("disabled_at", null)
            .ilike("email", escapeLike(toEmail))
            .limit(1);
          if (partnerError) {
            throw new Error(`partner lookup failed: ${partnerError.message}`);
          }
          if (!partnerRows || partnerRows.length === 0) {
            return Response.json(
              {
                error: "Recipient is not an active partner",
                detail: `${toEmail} is not in partner_profiles or is disabled.`,
              },
              { status: 422 },
            );
          }

          // From here on, use the canonical address from the database, never the
          // raw request value, for both delivery and logging.
          const partnerEmail = partnerRows[0].email as string;

          // 2. Resolve the case and its serial for the ref line.
          const { data: convRows, error: convError } = await supabase
            .from("brain_conversations")
            .select("id, case_serial_id")
            .eq("id", conversationId)
            .limit(1);
          if (convError) throw new Error(`conversation lookup failed: ${convError.message}`);
          const conversation = convRows?.[0];
          if (!conversation) {
            return Response.json({ error: "Case not found" }, { status: 404 });
          }

          const serial = (conversation.case_serial_id as string | null) ?? "";
          if (!serial) {
            return Response.json(
              {
                error: "Conversation has no case serial",
                detail:
                  "Cannot build a matchable MGT-REF-ID line, so the reply would be unroutable. Assign a case code first.",
              },
              { status: 422 },
            );
          }
          const refCore = serial.replace(/^MGT-/i, "");
          const refLineHtml = refCore
            ? '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #9ca3af; margin-top: 16px;">MGT-REF-ID: [' +
              refCore +
              "]</div>"
            : "";

          // Body, then the ref line. No signature: see note 4 in the header.
          const html = BASE_FONT_OPEN + bodyToHtml(bodyText) + "</div>" + refLineHtml;

          // 3. Send via Mailgun EU. No BCC, see header comment.
          const form = new URLSearchParams();
          form.set("from", "MyGreekTax <hello@mygreektax.eu>");
          form.set("to", partnerEmail);
          form.set("subject", subject);
          form.set("html", html);
          form.set("h:X-Mailgun-Variables", JSON.stringify({ src: "portal" }));

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          let mgRes: Response;
          try {
            mgRes = await fetch(`https://api.eu.mailgun.net/v3/${domain}/messages`, {
              method: "POST",
              headers: {
                Authorization: "Basic " + btoa("api:" + mailgunKey),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: form.toString(),
              signal: controller.signal,
            });
          } catch (fetchError) {
            const isAbort = fetchError instanceof Error && fetchError.name === "AbortError";
            console.error("[partner-reply] mailgun fetch failed:", fetchError);
            return Response.json(
              {
                error: isAbort ? "Mailgun timed out" : "Could not reach Mailgun",
                detail: fetchError instanceof Error ? fetchError.message : String(fetchError),
              },
              { status: 502 },
            );
          } finally {
            clearTimeout(timeoutId);
          }
          const mgText = await mgRes.text();
          if (!mgRes.ok) {
            return mailgunFailureResponse(
              "partner-reply",
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

          // 4. Log as a PARTNER event, so it renders in the partner pane.
          const externalEventId = mgId || `portal-partner-reply-${crypto.randomUUID()}`;
          const { error: insErr } = await supabase.from("brain_events").insert({
            conversation_id: conversationId,
            external_event_id: externalEventId,
            event_type: "partner_email_sent",
            actor: "dimitris",
            direction: "outbound",
            provider: "mailgun",
            provider_message_id: mgId || null,
            from_email: "hello@mygreektax.eu",
            to_emails: [partnerEmail],
            subject,
            body_text: bodyText,
            metadata: { via: "portal_partner_box" },
          });
          if (insErr) {
            console.error("[partner-reply] brain_events insert failed:", insErr.message);
            return Response.json({
              ok: true,
              messageId: mgId ?? null,
              logged: false,
              logError: insErr.message,
            });
          }

          return Response.json({ ok: true, messageId: mgId ?? null, logged: true });
        } catch (error) {
          console.error("[partner-reply] error", { error });
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      },
    },
  },
});
