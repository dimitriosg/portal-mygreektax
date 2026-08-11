import { refuseOutboundEmail } from "./outbound-email.server";

// Partner invite email.
//
// This refuses. The portal has no transactional sender -- see
// src/lib/outbound-email.server.ts for the full reason, including why it is not
// being repointed at Mailgun in the portal.
//
// This is the one of the three producers where the refusal is genuinely loud.
// Its only caller, sendPartnerInviteEmail in invites.functions.ts, exists for
// no other purpose than to send this email and does not catch, so the throw
// reaches the admin who pressed the button. That is the correct outcome: the
// invite has not gone out, and until now they were told it had. The invite
// RECORD is created by a different server function and is unaffected -- what
// fails is the notification, which is what actually failed.
//
// REMOVED WITH THE ENQUEUE, all recoverable from git when n8n takes this over:
//
//   - the suppressed_emails check
//   - get-or-create of the email_unsubscribe_tokens row
//   - the React Email render (email-templates/partner-invite.tsx is still
//     present and still the source of the wording)
//
// Those ran BEFORE the enqueue, which meant every call minted an unsubscribe
// token for an address that was never going to be emailed. Refusing at the top
// leaves no rows behind. Suppression belongs with the sender in any case, and
// the sender is going to be n8n, where suppression already lives.

export async function enqueuePartnerInviteEmail(params: {
  email: string;
  firstName: string;
  inviteUrl: string;
}): Promise<never> {
  return refuseOutboundEmail({
    templateName: "partner-invite",
    recipientEmail: params.email,
  });
}
