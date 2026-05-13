import { render } from "@react-email/components";
import * as React from "react";
import { adminTemplate, decisionTemplate } from "./email-templates/change-request";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { listAdminEmails } from "./access-context.server";

const SENDER_DOMAIN = "notify.portal.mygreektax.eu";
const FROM_DOMAIN = "portal.mygreektax.eu";
const SITE_NAME = "My Greek Tax";
const SITE_URL = "https://portal.mygreektax.eu";

async function enqueue(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  templateName: string;
}) {
  const messageId = crypto.randomUUID();
  await supabaseAdmin.from("email_send_log").insert({
    message_id: messageId,
    template_name: opts.templateName,
    recipient_email: opts.to,
    status: "pending",
  });
  const { error } = await supabaseAdmin.rpc("enqueue_email", {
    queue_name: "transactional_emails",
    payload: {
      message_id: messageId,
      to: opts.to,
      from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      sender_domain: SENDER_DOMAIN,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      purpose: "transactional",
      label: opts.templateName,
      idempotency_key: messageId,
      queued_at: new Date().toISOString(),
    },
  });
  if (error) {
    console.error("[change-request-email] enqueue failed", error);
  }
}

export async function enqueueChangeRequestAdminEmail(params: {
  jobCode: string;
  jobId: string;
  partnerName: string;
  field: string;
  currentValue: string;
  requestedValue: string;
  reason: string | null;
}) {
  const reviewUrl = `${SITE_URL}/admin/change-requests`;
  const props = { ...params, reviewUrl };
  const element = React.createElement(adminTemplate.component, props as never);
  const html = await render(element);
  const text = await render(element, { plainText: true });
  const subject =
    typeof adminTemplate.subject === "function"
      ? adminTemplate.subject(props)
      : adminTemplate.subject;
  const recipients = await listAdminEmails();
  await Promise.all(
    recipients.map((to) =>
      enqueue({ to, subject, html, text, templateName: "change-request-admin" }),
    ),
  );
}

export async function enqueueChangeRequestDecisionEmail(params: {
  to: string;
  partnerName: string;
  jobCode: string;
  field: string;
  requestedValue: string;
  decision: "approved" | "rejected";
  decisionNote: string | null;
}) {
  const props = { ...params, jobUrl: `${SITE_URL}/dashboard` };
  const element = React.createElement(decisionTemplate.component, props as never);
  const html = await render(element);
  const text = await render(element, { plainText: true });
  const subject =
    typeof decisionTemplate.subject === "function"
      ? decisionTemplate.subject(props)
      : decisionTemplate.subject;
  await enqueue({
    to: params.to,
    subject,
    html,
    text,
    templateName: "change-request-decision",
  });
}
