import { supabaseAdmin } from "@/integrations/supabase/client.server";

// -----------------------------------------------------------------------------
// The portal has no transactional email sender.
//
// It used to have one on paper: three flows (partner invite, change-request
// notifications, activity summaries) rendered a template, wrote an
// email_send_log row as 'pending', and called enqueue_email() to put the
// message on the `transactional_emails` pgmq queue. The only consumer of that
// queue was /lovable/email/queue/process, which was gated on LOVABLE_API_KEY
// and LOVABLE_SEND_URL, neither of which was ever set in production.
//
// So nothing ever drained it. In the queue's entire lifetime it received three
// messages, all on 12/05/2026, all partner invites, and not one was delivered:
// email_send_log has never held a single 'sent' or 'failed' row from this path.
// The one recipient who did become a partner was onboarded another way. The
// producers reported success to their callers throughout.
//
// That is the specific failure this module exists to prevent recurring. A
// producer with no consumer does not announce itself: the caller returns ok,
// the row says 'pending', and 'pending' is indistinguishable from 'about to be
// sent' until someone thinks to ask how old the oldest one is.
//
// So: refuse, in the open. No queue write, no 'pending' row that will never
// change, one 'failed' row for the audit trail, and a thrown error. Whether
// that error reaches a human depends on the caller, and the three differ -- see
// the note at each call site.
//
// NOT REPOINTED AT MAILGUN HERE, DELIBERATELY. The portal does send mail
// directly elsewhere (send-approved POSTs to Mailgun), so wiring these three
// the same way would have been a short change.
// It is the wrong place: outbound email is being consolidated onto n8n, where
// sending, suppression handling and email_send_log writes already live
// together. When these flows come back, the portal should POST an event and
// n8n should send it. Rebuilding a second sender inside the portal this week
// would be work thrown away next week.
//
// WHEN THAT LANDS: this module is the only thing to replace. Each caller
// already holds a recipient; swap refuseOutboundEmail for the n8n dispatch and
// the flows come back with no other change.
// -----------------------------------------------------------------------------

// TWO MESSAGES, ON PURPOSE.
//
// The thrown one can reach an admin's screen: the partner-invite caller does
// not catch, so this lands in the portal UI. It says what happened and what to
// do, and nothing else. An operator does not need our migration plan or a
// source path to understand that the invite did not go out, and putting either
// in front of them is leaking internals into a user-facing error.
//
// The recorded one goes to email_send_log.error_message, which is read by
// whoever is diagnosing, and carries the detail.
const REFUSED_USER_MESSAGE =
  "This email could not be sent: the portal has no email sender configured. Nothing was queued, " +
  "so it will not arrive later. Contact the administrator.";

const REFUSED_AUDIT_REASON =
  "Refused by outbound-email.server.ts: the portal has no transactional sender. Not queued. " +
  "Outbound transactional email is being consolidated onto n8n.";

/**
 * Record the refusal and throw. Never returns.
 *
 * The email_send_log write is best effort and its failure is reported but not
 * propagated, because losing the audit line must not mask the real error, which
 * is the one the caller needs to see.
 */
export async function refuseOutboundEmail(params: {
  templateName: string;
  recipientEmail: string;
  messageId?: string;
}): Promise<never> {
  const { templateName, recipientEmail, messageId } = params;
  const id = messageId ?? crypto.randomUUID();

  try {
    // supabase-js resolves with { error } rather than rejecting, so a
    // constraint or PostgREST failure here would otherwise pass silently and
    // leave no audit row at all -- the exact class of quiet failure this
    // module was written to stop. The catch below is still required: it covers
    // the client throwing outright, which it does when Supabase env is unset.
    const { error } = await supabaseAdmin.from("email_send_log").insert({
      message_id: id,
      template_name: templateName,
      recipient_email: recipientEmail,
      status: "failed",
      error_message: REFUSED_AUDIT_REASON,
    });
    if (error) {
      console.error("[outbound-email] could not record the refusal", {
        templateName,
        messageId: id,
        error: error.message,
      });
    }
  } catch (error) {
    console.error("[outbound-email] could not record the refusal", {
      templateName,
      messageId: id,
      error,
    });
  }

  // No recipient in the log line. It is a user identifier, it is already in
  // email_send_log.recipient_email where it belongs, and for the change-request
  // notification the value is every admin address at once -- one line would
  // publish the whole list. Correlate through message_id instead.
  console.error("[outbound-email] refused to send", { templateName, messageId: id });

  throw new Error(REFUSED_USER_MESSAGE);
}
