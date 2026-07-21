import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Case reply box, server side.
//
// Sends a customer reply through Mailgun's EU API (from hello@mygreektax.eu) and
// logs it to case_timeline as an outbound_message, in one call. No Make involved.
//
// Auth: the browser sends the caller's Supabase access token as a Bearer header.
// The route verifies it and checks the caller has the 'admin' role before sending,
// so this endpoint can't be used to send mail anonymously.
//
// Env (already present, except MAILGUN_DOMAIN which defaults):
//   SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
//   MAILGUN_API_KEY                 (the same key used by mailgun-events)
//   MAILGUN_DOMAIN                  (optional; defaults to mygreektax.eu)
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

// Escape HTML, then turn newlines into <br> so the plain-text body renders.
function bodyToHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(/\r?\n/g, "<br>");
}

// Standing signature. No em/en dashes anywhere.
const SIGNATURE_HTML =
  '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6; margin-top: 16px;">' +
  "Με εκτίμηση,<br>Δημήτρης<br>MyGreekTax</div>";

export const Route = createFileRoute("/api/case-reply")({
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
        const userId = userData.user.id;

        // Require admin role (relax this if your role model differs).
        const { data: roleRow } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId)
          .eq("role", "admin")
          .limit(1);
        if (!roleRow || roleRow.length === 0) {
          return Response.json({ error: "Not authorized" }, { status: 403 });
        }

        // 2. Read and validate input.
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const b = (body ?? {}) as Record<string, unknown>;
        const toEmail = readString(b.toEmail, 200);
        const clientName = readString(b.clientName, 200) || "";
        const subject = readString(b.subject, 500) || "(no subject)";
        const messageText = readString(b.body, 100000);
        const caseSerialId = readString(b.caseSerialId, 100); // e.g. MGT-CS001-CLT0028

        if (!toEmail || !EMAIL_RE.test(toEmail)) {
          return Response.json({ error: "Valid recipient email required" }, { status: 400 });
        }
        if (!messageText) {
          return Response.json({ error: "Message body required" }, { status: 400 });
        }

        const domain = process.env.MAILGUN_DOMAIN || "mygreektax.eu";
        const mailgunKey = process.env.MAILGUN_API_KEY;
        if (!mailgunKey) {
          return Response.json({ error: "MAILGUN_API_KEY not set" }, { status: 500 });
        }

        // Ref line carries the case token so replies from the customer thread back.
        // MGT-CS001-CLT0028 -> "MGT-REF-ID: [CS001-CLT0028]"
        const refCore = caseSerialId ? caseSerialId.replace(/^MGT-/i, "") : "";
        const refLineHtml = refCore
          ? '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #9ca3af; margin-top: 16px;">MGT-REF-ID: [' +
            refCore +
            "]</div>"
          : "";

        const html =
          '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6;">' +
          bodyToHtml(messageText) +
          "</div>" +
          SIGNATURE_HTML +
          refLineHtml;

        try {
          // 3. Send via Mailgun (EU).
          const form = new URLSearchParams();
          form.set("from", "MyGreekTax <hello@mygreektax.eu>");
          form.set("to", clientName ? `${clientName} <${toEmail}>` : toEmail);
          form.set("bcc", "hello@mygreektax.eu");
          form.set("subject", subject);
          form.set("html", html);
          // Tag as portal-origin so the (dormant) capture route would skip it.
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

          // 4. Log to case_timeline (match client by recipient, like conversation-log).
          const { data: matches } = await supabase
            .from("clients")
            .select("id, full_name")
            .ilike("email", toEmail)
            .limit(1);
          const client = matches?.[0];

          if (client) {
            let targetCaseId = client.id as string;
            if (caseSerialId) {
              const { data: dir } = await supabase
                .from("cases_directory")
                .select("id")
                .eq("case_serial_id", caseSerialId)
                .single();
              if (dir) targetCaseId = dir.id as string;
            }
            const row: Record<string, unknown> = {
              case_id: targetCaseId,
              case_serial_id: caseSerialId || null,
              event_type: "outbound_message",
              sender: "internal",
              payload: { text: messageText, subject },
            };
            if (mgId) row.source_message_id = mgId;
            const { error: insErr } = await supabase.from("case_timeline").insert(row);
            if (insErr) console.error("[case-reply] timeline insert failed:", insErr.message);

            return Response.json({ ok: true, messageId: mgId ?? null, caseId: targetCaseId });
          }

          // Sent, but recipient isn't a known client, so nothing to attach.
          return Response.json({ ok: true, messageId: mgId ?? null, caseId: null, logged: false });
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
