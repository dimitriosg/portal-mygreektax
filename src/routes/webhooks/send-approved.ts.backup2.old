import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /webhooks/send-approved
// Called by the AiReviewDesk button. Marks the draft approved, resolves the
// recipient server side, logs the outbound message onto the case timeline,
// then forwards the payload to the Make outbound webhook whose URL lives in
// the MAKE_OUTBOUND_WEBHOOK_URL secret. The Make URL and all database access
// stay on the server; the browser only ever talks to this same origin route.

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export const Route = createFileRoute("/webhooks/send-approved")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const webhookUrl = process.env.MAKE_OUTBOUND_WEBHOOK_URL;
        if (!webhookUrl) {
          return Response.json(
            {
              error: "Server misconfigured",
              detail:
                "MAKE_OUTBOUND_WEBHOOK_URL is not set. Add it as a Secret in Cloudflare, then redeploy.",
            },
            { status: 500 },
          );
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

        const caseId = readString(b.case_id, 100);
        const finalText = readString(b.final_text, 100000);

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
            return Response.json(
              { error: "No draft found for this case" },
              { status: 404 },
            );
          }

          // 2. Resolve the recipient. case_id here is a brain_conversations
          // id (new spine). We read the case row for its client_id,
          // customer_email, and case_serial_id, then prefer the linked
          // clients row for the name/email, falling back to the email stored
          // directly on the conversation. Legacy fallbacks (a bare client id,
          // or a cases_directory id) are kept last so old drafts still send.
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

            // Fall back to the email captured on the conversation itself.
            if ((!clientRow || !clientRow.email) && typeof convRow.customer_email === "string") {
              clientRow = {
                id: (convRow.client_id as string) ?? caseId,
                full_name: clientRow?.full_name ?? null,
                email: convRow.customer_email,
              };
            }
          }

          // Legacy fallbacks for any pre-existing case_drafts not on the new spine.
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
                detail:
                  "Could not resolve a client email for this case id. Check the cases_directory schema.",
                case_id: caseId,
              },
              { status: 422 },
            );
          }

          // 3. Mark approved and store the human edited final text.
          const { error: updateError } = await supabaseAdmin
            .from("case_drafts")
            .update({
              is_approved: true,
              proposed_draft: finalText,
              last_updated: new Date().toISOString(),
            })
            .eq("case_id", caseId);

          if (updateError) throw updateError;

          // 4. Log the outbound message. For new-spine cases this goes to
          // brain_events (so the case page conversation shows the sent
          // reply); actor "internal" keeps it off the Brain's triggering
          // path. Legacy cases still log to case_timeline.
          if (isNewSpine) {
            const { error: eventError } = await supabaseAdmin
              .from("brain_events")
              .insert({
                conversation_id: caseId,
                external_event_id: `sent:${caseId}:${Date.now()}`,
                event_type: "customer_email_sent",
                actor: "internal",
                direction: "outbound",
                provider: "make",
                to_emails: [clientRow.email],
                subject: "Update on your MyGreekTax request",
                body_text: finalText,
              });

            if (eventError) {
              console.error(
                "[send-approved] brain_events log failed (send continues):",
                eventError,
              );
            }
          } else {
            const { error: timelineError } = await supabaseAdmin
              .from("case_timeline")
              .insert({
                case_id: caseId,
                case_serial_id: caseSerialId,
                event_type: "outbound_sent",
                sender: "internal",
                payload: { text: finalText },
              });

            if (timelineError) {
              console.error(
                "[send-approved] timeline log failed (send continues):",
                timelineError,
              );
            }
          }

          // 5. Forward to Make. The scenario only formats and sends email;
          // it needs no database access and no keys.
          const refLine = caseSerialId ? `MGT-REF-ID: [${caseSerialId}]` : "";
          const subject = "Update on your MyGreekTax request";

          /* BEFORE THE SUGGESTED CHANGE, CODE BELOW:
          --------------------------------------------------------
          const makeResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          --------------------------------------------------------
          */
          
          // Modified after Claude's suggestion for MAKE_OUTBOUND_WEBHOOK_KEY on Cloudflare
          const makeHeaders: Record<string, string> = {
            "Content-Type": "application/json",
          };
          
          const makeKey = process.env.MAKE_OUTBOUND_WEBHOOK_KEY;
          if (makeKey) makeHeaders["x-make-apikey"] = makeKey;
          const makeResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: makeHeaders, // <---- the change ended at this point.
            body: JSON.stringify({
              case_id: caseId,
              case_serial_id: caseSerialId,
              to_email: clientRow.email,
              client_name: clientRow.full_name ?? "",
              subject,
              body_text: finalText,
              ref_line: refLine,
            }),
          });

          if (!makeResponse.ok) {
            return Response.json(
              {
                error: "Make webhook rejected the send",
                detail: `Make responded ${makeResponse.status}`,
              },
              { status: 502 },
            );
          }

          console.log(
            `[send-approved] draft approved and forwarded for case ${caseId} to ${clientRow.email}`,
          );
          return Response.json({
            ok: true,
            sent_to: clientRow.email,
            client_name: clientRow.full_name ?? "",
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
