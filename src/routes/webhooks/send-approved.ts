import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /webhooks/send-approved
//
// Called by the AiReviewDesk button. Marks the draft approved, resolves the
// recipient server side, sends via Mailgun's EU API directly (same path as
// case-reply.ts, no Make hop), then logs the outbound message.
//
// The Make relay was removed: it ACKed the webhook instantly and sent the mail
// afterwards, so a Mailgun failure inside Make surfaced as a success here. One
// path and one set of credentials now.
//
// Env: SUPABASE_*, MAILGUN_API_KEY, MAILGUN_DOMAIN (defaults to mygreektax.eu)

const DEFAULT_SUBJECT = "Update on your MyGreekTax request";

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

const BASE_FONT_OPEN =
  '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6;">';

// The desk posts final_text as sanitized HTML with the signature already in it,
// so we never append a signature here.
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

export const Route = createFileRoute("/webhooks/send-approved")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const mailgunKey = process.env.MAILGUN_API_KEY;
        if (!mailgunKey) {
          return Response.json(
            { error: "Server misconfigured", detail: "MAILGUN_API_KEY is not set." },
            { status: 500 },
          );
        }
        const domain = process.env.MAILGUN_DOMAIN || "mygreektax.eu";

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

        const caseId = readString(b.case_id, 100);
        const finalText = readString(b.final_text, 100000);
        const subject = readString(b.subject, 500) || DEFAULT_SUBJECT;

        if (!caseId || !finalText) {
          return Response.json(
            { error: "case_id and final_text are required" },
            { status: 400 },
          );
        }

        try {
          // 1. The draft must exist before anything is sent.
          const { data: draftRow, error: draftError } = await supabaseAdmin
            .from("case_drafts")
            .select("case_id, is_approved")
            .eq("case_id", caseId)
            .maybeSingle();

          if (draftError) throw draftError;
          if (!draftRow) {
            return Response.json({ error: "No draft found for this case" }, { status: 404 });
          }

          // 2. Resolve the recipient. Unchanged from the Make version.
          let clientRow: { id: string; full_name: string | null; email: string | null } | null = null;
          let caseSerialId: string | null = null;
          let isNewSpine = false;

          const { data: convRow } = await supabaseAdmin
            .from("brain_conversations")
            .select("id, client_id, customer_email, case_serial_id")
            .eq("id", caseId)
            .maybeSingle();

          if (convRow) {
            isNewSpine = true;
            caseSerialId =
              typeof convRow.case_serial_id === "string" ? convRow.case_serial_id : null;

            if (typeof convRow.client_id === "string" && convRow.client_id) {
              const { data: linkedClient } = await supabaseAdmin
                .from("clients")
                .select("id, full_name, email")
                .eq("id", convRow.client_id)
                .maybeSingle();
              if (linkedClient) clientRow = linkedClient;
            }

            if ((!clientRow || !clientRow.email) && typeof convRow.customer_email === "string") {
              clientRow = {
                id: (convRow.client_id as string) ?? caseId,
                full_name: clientRow?.full_name ?? null,
                email: convRow.customer_email,
              };
            }
          }

          if (!clientRow || !clientRow.email) {
            const { data: directClient } = await supabaseAdmin
              .from("clients")
              .select("id, full_name, email")
              .eq("id", caseId)
              .maybeSingle();

            if (directClient) {
              clientRow = directClient;
            } else {
              const { data: directoryRow } = await supabaseAdmin
                .from("cases_directory")
                .select("*")
                .eq("id", caseId)
                .maybeSingle();

              if (directoryRow) {
                caseSerialId =
                  typeof directoryRow.case_serial_id === "string"
                    ? directoryRow.case_serial_id
                    : caseSerialId;
                const linkedClientId =
                  typeof directoryRow.client_id === "string" ? directoryRow.client_id : null;
                if (linkedClientId) {
                  const { data: linkedClient } = await supabaseAdmin
                    .from("clients")
                    .select("id, full_name, email")
                    .eq("id", linkedClientId)
                    .maybeSingle();
                  if (linkedClient) clientRow = linkedClient;
                }
              }
            }
          }

          if (!clientRow || !clientRow.email) {
            return Response.json(
              {
                error: "Recipient not found",
                detail: "Could not resolve a client email for this case id.",
                case_id: caseId,
              },
              { status: 422 },
            );
          }

          // 3. Build the email. final_text is already sanitized HTML carrying
          // the signature, so wrap once and append the ref line only.
          const refCore = caseSerialId ? caseSerialId.replace(/^MGT-/i, "") : "";
          const refLineHtml = refCore
            ? '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #9ca3af; margin-top: 16px;">MGT-REF-ID: [' +
              refCore +
              "]</div>"
            : "";

          const html = BASE_FONT_OPEN + finalText + "</div>" + refLineHtml;
          const logText = htmlToText(finalText);

          // 4. Send via Mailgun (EU), BCC to hello@ so there is always a copy.
          const form = new URLSearchParams();
          form.set("from", "MyGreekTax <hello@mygreektax.eu>");
          form.set("to", clientRow.email);
          form.set("bcc", "hello@mygreektax.eu");
          form.set("subject", subject);
          form.set("html", html);
          form.set("h:X-Mailgun-Variables", JSON.stringify({ src: "portal_desk" }));

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
            console.error("[send-approved] mailgun send failed:", mgRes.status, mgText);
            return Response.json({ error: "Send failed", detail: mgText }, { status: 502 });
          }

          let mgId: string | undefined;
          try {
            mgId = (JSON.parse(mgText) as { id?: string }).id;
          } catch {
            /* ignore */
          }

          // 5. Only now mark the draft approved. The send succeeded, so this
          // can no longer claim success for a mail that never left.
          const { error: updateError } = await supabaseAdmin
            .from("case_drafts")
            .update({
              is_approved: true,
              proposed_draft: finalText,
              last_updated: new Date().toISOString(),
            })
            .eq("case_id", caseId);

          if (updateError) {
            console.error("[send-approved] approval update failed (mail already sent):", updateError);
          }

          // 6. Log it onto the case.
          if (isNewSpine) {
            const { error: eventError } = await supabaseAdmin.from("brain_events").insert({
              conversation_id: caseId,
              external_event_id: mgId || `sent:${caseId}:${Date.now()}`,
              event_type: "customer_email_sent",
              actor: "internal",
              direction: "outbound",
              provider: "mailgun",
              provider_message_id: mgId || null,
              from_email: "hello@mygreektax.eu",
              to_emails: [clientRow.email],
              subject,
              body_text: logText,
              metadata: { via: "portal_desk" },
            });

            if (eventError) {
              console.error("[send-approved] brain_events log failed (mail already sent):", eventError);
            }
          } else {
            const { error: timelineError } = await supabaseAdmin.from("case_timeline").insert({
              case_id: caseId,
              case_serial_id: caseSerialId,
              event_type: "outbound_sent",
              sender: "internal",
              payload: { text: logText },
            });

            if (timelineError) {
              console.error("[send-approved] timeline log failed (mail already sent):", timelineError);
            }
          }

          console.log(`[send-approved] sent for case ${caseId} to ${clientRow.email}`);
          return Response.json({
            ok: true,
            sent_to: clientRow.email,
            client_name: clientRow.full_name ?? "",
            messageId: mgId ?? null,
          });
        } catch (error) {
          console.error("[send-approved] failed", { error });
          return Response.json(
            {
              error: "Failed to process approval",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
