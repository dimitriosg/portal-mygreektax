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
// change, one 'failed' row for the audit trail, and a thrown error carrying the
// reason. Whether that error reaches a human depends on the caller, and the
// three differ -- see the note at each call site.
//
// NOT REPOINTED AT MAILGUN HERE, DELIBERATELY. The portal does send mail
// directly elsewhere (case-reply, send-approved, partner-reply all POST to
// Mailgun), so wiring these three the same way would have been a short change.
// It is the wrong place: outbound email is being consolidated onto n8n, where
// sending, suppression handling and email_send_log writes already live
// together. When these flows come back, the portal should POST an event and
// n8n should send it. Rebuilding a second sender inside the portal this week
// would be work thrown away next week.
//
// WHEN THAT LANDS: this module is the only thing to replace. Each caller
// already renders its template and holds a recipient; swap refuseOutboundEmail
// for the n8n dispatch and the flows come back with no other change.
// -----------------------------------------------------------------------------

export const NO_OUTBOUND_SENDER =
  "The portal has no transactional email sender. This message was not sent and was not queued: " +
  "outbound transactional email is being moved to n8n. See src/lib/outbound-email.server.ts.";

/**
 * Record the refusal and throw. Never returns.
 *
 * The email_send_log row is written before the throw and its failure is
 * swallowed, because losing the audit line must not mask the real error, which
 * is the one the caller needs to see.
 */
export async function refuseOutboundEmail(params: {
  templateName: string;
  recipientEmail: string;
  messageId?: string;
}): Promise<never> {
  const { templateName, recipientEmail, messageId } = params;

  try {
    await supabaseAdmin.from("email_send_log").insert({
      message_id: messageId ?? crypto.randomUUID(),
      template_name: templateName,
      recipient_email: recipientEmail,
      status: "failed",
      error_message: NO_OUTBOUND_SENDER,
    });
  } catch (error) {
    console.error("[outbound-email] could not write the refusal to email_send_log", { error });
  }

  console.error("[outbound-email] refused to send", { templateName, recipientEmail });
  throw new Error(NO_OUTBOUND_SENDER);
}
