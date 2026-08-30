import { createFileRoute } from "@tanstack/react-router";
import { mailgunFailureResponse } from "@/lib/mailgun-error.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveActivePartner } from "@/lib/partner-recipient.server";
import { isBeforeDeposit, reviewBody, visibleText } from "@/lib/case-composer";

// POST /webhooks/send-approved
//
// Called by the case composer (and still by the AiReviewDesk button). Marks
// the draft approved, resolves the recipient server side, sends via Mailgun's
// EU API directly (same path as case-reply.ts, no Make hop), then logs the
// outbound message and stamps the draft version history.
//
// TARGET. The composer can write to the client or to the partner, so the body
// carries `target`. It defaults to "client", which is what every existing
// caller posts, so their contract is unchanged.
//
// The partner branch is not the client branch with a different address. Four
// things differ, each deliberately, and each matching /webhooks/partner-reply:
//
//   1. The recipient must be an ACTIVE PARTNER, checked against
//      partner_profiles by resolveActivePartner(). That check is what keeps a
//      partner send from being pointed at a client, and it lives in a shared
//      module precisely so the two endpoints cannot drift apart on it.
//   2. NO BCC to hello@. hello@ forwards into the same Gmail the partner sync
//      searches, so a BCC would re-import as a duplicate of the message.
//   3. NO SIGNATURE. Partner mail carries none: these are working exchanges
//      with a counterparty, not client correspondence.
//   4. The body arrives as PLAIN TEXT and is escaped here, where client mail
//      arrives as sanitized HTML with the signature already stitched in.
//
// The MGT-REF-ID line is appended in both directions: it is the token the
// inbound sync matches a reply back to the case with.
//
// The Make relay was removed: it ACKed the webhook instantly and sent the mail
// afterwards, so a Mailgun failure inside Make surfaced as a success here. One
// path and one set of credentials now.
//
// Auth: admin session required, as a Bearer access token. The desk is the only
// caller and it already holds one. See the block in the handler.
//
// Env: SUPABASE_*, MAILGUN_API_KEY, MAILGUN_DOMAIN (defaults to mygreektax.eu)

const DEFAULT_SUBJECT = "Update on your MyGreekTax request";

// The only two answers the quality metric accepts. Anything else, including a
// missing field from an older client, is recorded as null rather than guessed:
// a wrong reading is worse than no reading, and guessing is exactly how the
// previous implementation ended up calling every send "edited".
const SENT_MODES = ["as_is", "edited"] as const;
type SentMode = (typeof SENT_MODES)[number];

// Returned as `logError` when the mail went out but the case log write did
// not. Fixed text on purpose: the caller needs to know the log is missing,
// not which table refused the row. The database's own message is written to
// console.error and goes no further.
const LOG_FAILURE_MESSAGE =
  "The email was sent, but it could not be written to the case. The reason is in the server log.";

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function readSentMode(value: unknown): SentMode | null {
  return typeof value === "string" && (SENT_MODES as readonly string[]).includes(value)
    ? (value as SentMode)
    : null;
}

const BASE_FONT_OPEN =
  '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1E2A3A; line-height: 1.6;">';

const TARGETS = ["client", "partner"] as const;
type Target = (typeof TARGETS)[number];

/**
 * The target, or null when one was supplied that is not a target.
 *
 * Absent means "client", because every caller that predates the composer posts
 * no target at all. A value that is present but unrecognised is an error and
 * not a client send: coercing "Partner" to the client branch would put Greek
 * partner text, unescaped and with a client's address resolved for it, into a
 * client's inbox.
 */
function readTarget(value: unknown): Target | null {
  if (value === undefined || value === null) return "client";
  return typeof value === "string" && (TARGETS as readonly string[]).includes(value)
    ? (value as Target)
    : null;
}

/** Partner bodies arrive as plain text, so they are escaped, never trusted. */
function bodyToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
}

/** What the deposit gate needs to know about a case, read from the database. */
interface CaseGateFacts {
  stage: string | null;
  /** clients.deposit > 0, which is how the portal records a confirmed deposit. */
  depositRecorded: boolean;
  /**
   * False when a lookup errored, as opposed to returning no row.
   *
   * The difference decides whether the send may proceed. A case with no row
   * genuinely has no stage, and R7 does not gate on absent data. A failed read
   * looks identical from here and must not: it would report "not before the
   * deposit" for a case that is, and open the gate exactly when the database
   * is least able to say otherwise.
   */
  readOk: boolean;
}

/**
 * The stage and the deposit, read on the server rather than taken from the
 * caller.
 *
 * R7 turns on these values, so they are looked up here: a body posted directly
 * could otherwise carry any stage it liked, and the rule would hold only for
 * callers that chose to respect it. clients.stage first, the conversation's
 * own stage second, which is the precedence the case list already uses.
 *
 * The deposit is read alongside it because the stage alone cannot answer the
 * question for a case in a side state: Parked and Lost are reachable from
 * Quoted, so they gate, and clients.deposit is what says this particular
 * parked case had already paid.
 */
async function readCaseGateFacts(caseId: string): Promise<CaseGateFacts> {
  const { data: conv, error: convError } = await supabaseAdmin
    .from("brain_conversations")
    .select("stage, client_id")
    .eq("id", caseId)
    .maybeSingle();
  if (convError) {
    console.error("[send-approved] case lookup failed:", convError.message);
    return { stage: null, depositRecorded: false, readOk: false };
  }
  if (!conv) return { stage: null, depositRecorded: false, readOk: true };

  const convStage = typeof conv.stage === "string" ? conv.stage : null;

  if (typeof conv.client_id === "string" && conv.client_id) {
    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("stage, deposit")
      .eq("id", conv.client_id)
      .maybeSingle();
    if (clientError) {
      console.error("[send-approved] client lookup failed:", clientError.message);
      return { stage: null, depositRecorded: false, readOk: false };
    }
    if (client) {
      const depositRecorded = typeof client.deposit === "number" && client.deposit > 0;
      const stage = typeof client.stage === "string" && client.stage ? client.stage : convStage;
      return { stage, depositRecorded, readOk: true };
    }
  }
  return { stage: convStage, depositRecorded: false, readOk: true };
}

/**
 * One bounded Mailgun send, used by both targets.
 *
 * Without the bound a stalled Mailgun holds the worker until the platform
 * kills it and the operator is told nothing about whether the mail went. That
 * reasoning is not specific to either recipient, so neither is this: the
 * client branch carries most of the traffic and had no timeout at all while
 * the partner branch did.
 *
 * Throws what fetch throws, including an AbortError on timeout, so each caller
 * keeps its own wording for the failure.
 */
async function sendViaMailgun(
  domain: string,
  mailgunKey: string,
  form: URLSearchParams,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(`https://api.eu.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa("api:" + mailgunKey),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The MGT-REF-ID footer, which is how a partner's reply finds its way back.
 *
 * Partner mail goes to the partner's own mailbox and comes back through the
 * sync with no thread the portal owns, so the case code travels in the body
 * and is read back out of the reply. Byte for byte the same line
 * /webhooks/partner-reply already emits, "MGT-" prefix stripped and all: two
 * endpoints writing the marker two ways is how one of them stops matching.
 * Returns "" for a case with no serial, and the partner branch refuses to
 * send in that state rather than mailing an unmatchable message.
 */
function refLine(caseSerialId: string | null): string {
  const refCore = caseSerialId ? caseSerialId.replace(/^MGT-/i, "") : "";
  return refCore
    ? '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #9ca3af; margin-top: 16px;">MGT-REF-ID: [' +
        refCore +
        "]</div>"
    : "";
}

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
        // Admin session required.
        //
        // This route shipped with no guard at all: an anonymous POST carrying
        // a case id and final_text marked a draft approved and sent it to that
        // case's client as hello@mygreektax.eu. The recipient is resolved
        // server side, so it could not be pointed at an arbitrary address, but
        // the body could be anything and the send was real.
        //
        // A USER JWT, NOT A SHARED SECRET. The only caller is the browser
        // (AiReviewDesk.tsx), which already sends the signed-in user's
        // Supabase access token. A shared secret would have to ship inside
        // client JS to be usable from there, which is worse than none.
        //
        // The check runs before the MAILGUN_API_KEY read below so an
        // unauthenticated caller cannot use the 500 to learn whether the key
        // is configured.
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
        if (userError || !userData?.user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        // getUser() authenticates the caller; it does not authorize them. A
        // partner account holds a valid session and must not be able to send
        // client mail, so the admin role is checked explicitly, same as
        // /webhooks/case-action and /webhooks/partner-reply.
        const { data: roleRow, error: roleError } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "admin")
          .limit(1);
        if (roleError) {
          console.error("[send-approved] role check failed:", roleError.message);
          return Response.json({ error: "Authorization check failed" }, { status: 500 });
        }
        if (!roleRow || roleRow.length === 0) {
          return Response.json({ error: "Not authorized (admin role required)" }, { status: 403 });
        }

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
        const sentMode = readSentMode(b.sent_mode);
        const target = readTarget(b.target);
        if (target === null) {
          return Response.json(
            { error: "Unknown target", detail: 'target must be "client" or "partner".' },
            { status: 400 },
          );
        }
        // The version this send corresponds to, chosen by the composer. See
        // the stamping step for why the server no longer picks one itself.
        const draftVersionId = readString(b.draft_version_id, 100);

        if (!caseId || !finalText) {
          return Response.json({ error: "case_id and final_text are required" }, { status: 400 });
        }

        // ---------------------------------------------------------------
        // R2 AND R7, ON THE SERVER.
        //
        // The composer applies these before it lets the button light up, but
        // a rule that only exists in the browser is advice, not a rule: this
        // endpoint takes final_text from the caller and would otherwise send
        // whatever arrived. R2 in particular is written as having no
        // exceptions, so it is enforced where it cannot be skipped.
        //
        // The stage comes from the database, never from the request, and the
        // body is read the way the recipient will read it. A currency figure
        // needs the caller to have confirmed it (pricing_ack), which is the
        // server-side form of the confirmation the composer asks for.
        // ---------------------------------------------------------------
        const { stage, depositRecorded, readOk } = await readCaseGateFacts(caseId);
        if (!readOk) {
          // Refuse rather than send. R7 cannot be applied without knowing the
          // stage, and guessing in the permissive direction here would mean the
          // gate fails open on precisely the requests it cannot evaluate.
          return Response.json(
            {
              error: "Case stage could not be read",
              detail:
                "The deposit gate cannot be checked right now, so nothing is sent. Try again in a moment. The reason is in the server log.",
            },
            { status: 503 },
          );
        }
        const beforeDeposit = isBeforeDeposit(stage, depositRecorded);
        // Read the body the way its recipient will, which is not the same
        // reading for the two targets. Client mail is HTML and has to be
        // stripped to its words. Partner mail is plain text and is escaped on
        // delivery by bodyToHtml, so stripping it would delete every span
        // between a "<" and the next ">" from the check while the partner
        // still receives it: "η τιμή πελάτη <249 EUR> ok" would be reviewed as
        // "η τιμή πελάτη ok". A stray "less than" sign was enough.
        const bodyForReview = target === "partner" ? finalText : visibleText(finalText);
        // The subject is sent in the same message and is read first, so it is
        // judged with the body. A retail figure in a partner subject line is
        // exactly as much an R2 breach as one in the body.
        const verdict = reviewBody(`${subject}\n${bodyForReview}`, target, beforeDeposit);

        if (verdict.blocking.length > 0) {
          return Response.json(
            {
              error: "Blocked by the case rules",
              detail: verdict.blocking.join(" "),
              blocking: verdict.blocking,
            },
            { status: 422 },
          );
        }
        if (verdict.confirmations.length > 0 && b.pricing_ack !== true) {
          return Response.json(
            {
              error: "Confirmation required before sending",
              detail: verdict.confirmations.join(" "),
              confirmations: verdict.confirmations,
            },
            { status: 422 },
          );
        }

        // ---------------------------------------------------------------
        // PARTNER TARGET. Handled entirely here and returned, so none of the
        // client-only steps below (draft row required, client recipient
        // resolution, BCC, version stamping) can run against partner mail.
        // ---------------------------------------------------------------
        if (target === "partner") {
          try {
            const partnerLookup = await resolveActivePartner(
              supabaseAdmin,
              readString(b.partner_email, 320) ?? "",
            );
            if (!partnerLookup.ok) {
              return Response.json(
                { error: partnerLookup.error, detail: partnerLookup.detail },
                { status: partnerLookup.status },
              );
            }
            const partnerEmail = partnerLookup.partner.email;

            const { data: convRow } = await supabaseAdmin
              .from("brain_conversations")
              .select("id, case_serial_id")
              .eq("id", caseId)
              .maybeSingle();
            if (!convRow) {
              return Response.json({ error: "Case not found" }, { status: 404 });
            }
            const serial =
              typeof convRow.case_serial_id === "string" ? convRow.case_serial_id : null;
            if (!serial) {
              return Response.json(
                {
                  error: "Conversation has no case serial",
                  detail:
                    "Without a MGT-REF-ID line the partner's reply cannot be matched back to this case. Assign a case code first.",
                },
                { status: 422 },
              );
            }

            // No signature, by design. Body, then the ref line.
            const html = BASE_FONT_OPEN + bodyToHtml(finalText) + "</div>" + refLine(serial);

            // No BCC: hello@ feeds the same mailbox the partner sync reads, and
            // the copy would re-import as a duplicate of this message.
            const form = new URLSearchParams();
            form.set("from", "MyGreekTax <hello@mygreektax.eu>");
            form.set("to", partnerEmail);
            form.set("subject", subject);
            form.set("html", html);
            form.set("h:X-Mailgun-Variables", JSON.stringify({ src: "portal_composer" }));

            let mgRes: Response;
            try {
              mgRes = await sendViaMailgun(domain, mailgunKey, form);
            } catch (sendError) {
              const aborted = sendError instanceof Error && sendError.name === "AbortError";
              console.error("[send-approved] partner send failed:", sendError);
              return Response.json(
                {
                  error: aborted ? "Mailgun timed out" : "Mailgun unreachable",
                  detail: aborted
                    ? "The send did not complete within 10 seconds. Check the partner thread before retrying."
                    : "The mail server could not be reached.",
                },
                { status: 502 },
              );
            }
            const mgText = await mgRes.text();
            if (!mgRes.ok) {
              return mailgunFailureResponse(
                "send-approved(partner)",
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

            // Logged as a PARTNER event so it renders in the partner pane and
            // never in the client one.
            let logged = true;
            let logError: string | null = null;
            const { error: insErr } = await supabaseAdmin.from("brain_events").insert({
              conversation_id: caseId,
              external_event_id: mgId || `portal-composer-partner-${crypto.randomUUID()}`,
              event_type: "partner_email_sent",
              actor: "dimitris",
              direction: "outbound",
              provider: "mailgun",
              provider_message_id: mgId || null,
              from_email: "hello@mygreektax.eu",
              to_emails: [partnerEmail],
              subject,
              body_text: finalText,
              metadata: { via: "portal_composer" },
            });
            if (insErr) {
              console.error("[send-approved] partner log failed (mail already sent):", insErr);
              logged = false;
              logError = LOG_FAILURE_MESSAGE;
            }

            console.log(`[send-approved] partner send for case ${caseId} to ${partnerEmail}`);
            return Response.json({
              ok: true,
              target: "partner",
              sent_to: partnerEmail,
              messageId: mgId ?? null,
              logged,
              logError,
            });
          } catch (error) {
            console.error("[send-approved] partner send failed", { error });
            return Response.json(
              {
                error: "Failed to send to partner",
                detail: error instanceof Error ? error.message : String(error),
              },
              { status: 500 },
            );
          }
        }

        try {
          // 1. A draft row is no longer required to send.
          //
          // This used to 404 without one, which was right while the only
          // caller was the approve button on a generated draft. The composer
          // is now the only way to write to a client from the case page, and
          // it replaced a reply box that never needed a draft, so refusing
          // here would mean a case the Brain has never drafted for cannot be
          // replied to at all.
          //
          // What the row still decides is whether this send is APPROVING a
          // draft: the approval flag and the version stamp below only apply
          // when there is one and the caller says the draft is what it sent.
          const { data: draftRow, error: draftError } = await supabaseAdmin
            .from("case_drafts")
            .select("case_id, is_approved")
            .eq("case_id", caseId)
            .maybeSingle();

          if (draftError) throw draftError;

          // An ad-hoc reply is not an approval. The composer posts a version
          // id (or a sent_mode) only when the body it is sending came from the
          // draft; without either, this is a message the operator wrote, and
          // marking the Brain's draft approved and sent for it would put a
          // send into the quality metric that never happened.
          const approvesDraft = !!draftRow && (!!draftVersionId || sentMode !== null);

          // 2. Resolve the recipient. Unchanged from the Make version.
          let clientRow: { id: string; full_name: string | null; email: string | null } | null =
            null;
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
                // cases_directory carries the client's serial code
                // (client_serial_id), not a UUID, so resolve the client by
                // client_code. An exact-code miss yields no row (and the 422
                // below), never a wrong recipient.
                const linkedClientCode =
                  typeof directoryRow.client_serial_id === "string"
                    ? directoryRow.client_serial_id
                    : null;
                if (linkedClientCode) {
                  const { data: linkedClient } = await supabaseAdmin
                    .from("clients")
                    .select("id, full_name, email")
                    .eq("client_code", linkedClientCode)
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

          let mgRes: Response;
          try {
            mgRes = await sendViaMailgun(domain, mailgunKey, form);
          } catch (sendError) {
            const aborted = sendError instanceof Error && sendError.name === "AbortError";
            console.error("[send-approved] client send failed:", sendError);
            return Response.json(
              {
                error: aborted ? "Mailgun timed out" : "Mailgun unreachable",
                detail: aborted
                  ? "The send did not complete within 10 seconds. Check the client thread before retrying."
                  : "The mail server could not be reached.",
              },
              { status: 502 },
            );
          }
          const mgText = await mgRes.text();

          if (!mgRes.ok) {
            return mailgunFailureResponse(
              "send-approved",
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

          // 5. Only now mark the draft approved. The send succeeded, so this
          // can no longer claim success for a mail that never left.
          //
          // proposed_draft IS DELIBERATELY NOT REWRITTEN HERE. It used to be
          // overwritten with final_text, which caused two problems:
          //
          //   a) final_text is HTML with the signature already stitched on.
          //      Reopening the case loaded that whole thing back into the body
          //      editor, and the desk then appended a fresh signature on top,
          //      so every "Send again" went out double-signed.
          //   b) case_drafts stopped holding what the Brain actually wrote, so
          //      nothing could compare the Brain's output against what went
          //      out. That comparison is the entire quality metric.
          //
          // What was sent now lives in case_draft_versions.sent_text, which is
          // the column that exists for it. proposed_draft stays the Brain's.
          if (approvesDraft) {
            const { error: updateError } = await supabaseAdmin
              .from("case_drafts")
              .update({
                is_approved: true,
                last_updated: new Date().toISOString(),
              })
              .eq("case_id", caseId);

            if (updateError) {
              console.error(
                "[send-approved] approval update failed (mail already sent):",
                updateError,
              );
            }
          }

          // 6. Stamp the draft version history.
          //
          // The trigger record_case_draft_version() records generations. It
          // used to try to record sends as well, deciding as_is vs edited by
          // comparing the stored draft against what came back on approval.
          // Those two strings are never equal (plain text in, signed HTML
          // out), so it marked every send "edited" and the metric read as
          // noise. The browser is the only place that still holds both sides
          // of that comparison, so sent_mode arrives from the desk.
          //
          // WHICH row is stamped, and why this changed.
          //
          // It used to be "the newest row that has not been sent yet", with the
          // reasoning that a resend would find nothing to stamp. That only held
          // if every earlier version had also been sent. In the ordinary flow
          // (generate v1, regenerate v2, send v2) v1 is left permanently
          // unsent, so it was the row a resend found, and the resend wrote v2's
          // text and a send time onto v1. One email then showed as two sends,
          // and the as-is against edited ratio, which is the only quality
          // metric this project has, was counted twice from it.
          //
          // The composer now posts the id of the version it is actually
          // sending, so there is nothing to infer. A caller that does not send
          // one (the older desk) keeps the previous behaviour, narrowed to the
          // newest row overall so it can never reach back past a sent version.
          //
          // Failure here never fails the request. The mail has gone, and a
          // missing metric row is not something the sender can act on.
          let versionStamped = false;
          if (isNewSpine && approvesDraft) {
            const query = supabaseAdmin.from("case_draft_versions").select("id, sent_at");
            const { data: versionRow, error: versionLookupError } = draftVersionId
              ? await query.eq("id", draftVersionId).eq("conversation_id", caseId).maybeSingle()
              : await query
                  .eq("conversation_id", caseId)
                  .order("version_no", { ascending: false })
                  .limit(1)
                  .maybeSingle();

            if (versionLookupError) {
              console.error("[send-approved] draft version lookup failed:", versionLookupError);
            } else if (versionRow && (versionRow as { sent_at: string | null }).sent_at) {
              // Already stamped. A resend is a real thing an operator may do,
              // but the first send is what the metric is about, so the earlier
              // stamp stands and this one is recorded as not stamped.
              console.log(
                `[send-approved] version ${(versionRow as { id: string }).id} already stamped; leaving the first send standing`,
              );
            } else if (versionRow) {
              const { error: versionUpdateError } = await supabaseAdmin
                .from("case_draft_versions")
                .update({
                  sent_at: new Date().toISOString(),
                  sent_text: finalText,
                  sent_mode: sentMode,
                })
                .eq("id", (versionRow as { id: string }).id);

              if (versionUpdateError) {
                console.error("[send-approved] draft version stamp failed:", versionUpdateError);
              } else {
                versionStamped = true;
              }
            }
          }

          // 7. Log it onto the case.
          //
          // The outcome is TRACKED and returned. Both branches below swallow
          // their error deliberately -- the mail has gone, and failing the
          // request would tell the sender nothing was sent when something was.
          // But swallowing it silently is how the constraint violation above
          // survived unnoticed for the life of this route: the desk said
          // "Sent to ..." and the case stayed empty, and nothing anywhere said
          // otherwise except a console line nobody had reason to read.
          //
          // So the request still succeeds, and it now says whether the case
          // was updated. The desk surfaces it.
          //
          // What comes back is the OUTCOME, never the database's words. The
          // raw PostgREST message names tables, columns and constraints, and
          // it would land in a browser to say nothing the reader can act on.
          // It goes to console.error and stays there.
          let logged = true;
          let logError: string | null = null;

          if (isNewSpine) {
            const { error: eventError } = await supabaseAdmin.from("brain_events").insert({
              conversation_id: caseId,
              external_event_id: mgId || `sent:${caseId}:${Date.now()}`,
              event_type: "customer_email_sent",
              // MUST be "dimitris", not "internal".
              //
              // brain_events_actor_check allows exactly
              // customer | partner | dimitris | system. "internal" is not in
              // it, so every insert this route attempted was rejected by the
              // constraint -- and the error is swallowed below, because the
              // mail has already gone and failing the request would be worse.
              //
              // The result was that this route sent correctly and logged
              // nothing, for its entire life: 0 rows via portal_desk against
              // 10 from case-reply.ts, which uses "dimitris" and works. Every
              // approved draft reached the client and left no trace on the
              // case.
              //
              // "internal" is a valid DIRECTION, which is most likely how it
              // got here. It has never been a valid actor.
              actor: "dimitris",
              direction: "outbound",
              provider: "mailgun",
              provider_message_id: mgId || null,
              from_email: "hello@mygreektax.eu",
              to_emails: [clientRow.email],
              subject,
              body_text: logText,
              metadata: { via: "portal_desk", sent_mode: sentMode },
            });

            if (eventError) {
              console.error(
                "[send-approved] brain_events log failed (mail already sent):",
                eventError,
              );
              logged = false;
              logError = LOG_FAILURE_MESSAGE;
            }
          } else {
            const { error: timelineError } = await supabaseAdmin.from("case_timeline").insert({
              case_id: caseId,
              case_serial_id: caseSerialId,
              event_type: "outbound_sent",
              sender: "internal",
              payload: { text: logText, sent_mode: sentMode },
            });

            if (timelineError) {
              console.error(
                "[send-approved] timeline log failed (mail already sent):",
                timelineError,
              );
              logged = false;
              logError = LOG_FAILURE_MESSAGE;
            }
          }

          console.log(
            `[send-approved] sent for case ${caseId} to ${clientRow.email} (mode ${sentMode ?? "unknown"}, version stamped: ${versionStamped})`,
          );
          return Response.json({
            ok: true,
            sent_to: clientRow.email,
            client_name: clientRow.full_name ?? "",
            messageId: mgId ?? null,
            logged,
            logError,
            sentMode,
            versionStamped,
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
