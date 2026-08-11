import { listAdminEmails } from "./access-context.server";
import { refuseOutboundEmail } from "./outbound-email.server";

// Change-request notifications: the admin alert when a partner raises one, and
// the decision notice back to the partner.
//
// Both refuse. The portal has no transactional sender -- see
// src/lib/outbound-email.server.ts for the full reason, including why these are
// not being repointed at Mailgun in the portal.
//
// LOUDNESS, HONESTLY: both call sites in jobs.functions.ts wrap these in
// try/catch and log, marked "Fire-and-forget", so the throw lands in the Worker
// log rather than in front of a person. That is deliberate and left alone. By
// the time these run the change request itself is already recorded, and making
// a partner's submission fail because a notification cannot be sent would trade
// a silent problem for a worse loud one. Whether those call sites should
// surface it is a decision about the change-request flow, not about email.
//
// REMOVED WITH THE ENQUEUE, recoverable from git when n8n takes this over: the
// React Email render of both templates (email-templates/change-request.tsx,
// which is still present and still the source of the wording) and the
// pending-then-enqueue write. Rendering a document that cannot be sent is waste
// on every call, so the refusal happens before it rather than after.

export async function enqueueChangeRequestAdminEmail(params: {
  jobCode: string;
  jobId: string;
  partnerName: string;
  field: string;
  currentValue: string;
  requestedValue: string;
  reason: string | null;
}): Promise<never> {
  void params;
  // Resolved so the refusal records who it would have reached. One row for the
  // whole notification rather than one per admin: the throw ends it either way,
  // and the addresses are the useful part.
  const recipients = await listAdminEmails();
  return refuseOutboundEmail({
    templateName: "change-request-admin",
    recipientEmail: recipients.length ? recipients.join(", ") : "(no admin recipients resolved)",
  });
}

export async function enqueueChangeRequestDecisionEmail(params: {
  to: string;
  partnerName: string;
  jobCode: string;
  field: string;
  requestedValue: string;
  decision: "approved" | "rejected";
  decisionNote: string | null;
}): Promise<never> {
  return refuseOutboundEmail({
    templateName: "change-request-decision",
    recipientEmail: params.to,
  });
}
