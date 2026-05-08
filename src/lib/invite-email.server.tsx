import { render } from "@react-email/components";
import * as React from "react";
import { template as partnerInviteTemplate } from "./email-templates/partner-invite";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const SENDER_DOMAIN = "notify.portal.mygreektax.eu";
const FROM_DOMAIN = "portal.mygreektax.eu";
const SITE_NAME = "My Greek Tax";

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function enqueuePartnerInviteEmail(params: {
  email: string;
  firstName: string;
  inviteUrl: string;
}) {
  const { email, firstName, inviteUrl } = params;
  const normalized = email.toLowerCase();

  // Refuse if email is suppressed.
  const { data: suppressed } = await supabaseAdmin
    .from("suppressed_emails" as any)
    .select("id")
    .eq("email", normalized)
    .maybeSingle();
  if (suppressed) {
    throw new Error(
      "This email address has unsubscribed or bounced and cannot be emailed.",
    );
  }

  // Get or create unsubscribe token (one per address).
  let unsubscribeToken: string | null = null;
  const { data: existing } = await supabaseAdmin
    .from("email_unsubscribe_tokens" as any)
    .select("token, used_at")
    .eq("email", normalized)
    .maybeSingle();
  if (existing && !(existing as any).used_at) {
    unsubscribeToken = (existing as any).token;
  } else if (!existing) {
    unsubscribeToken = generateToken();
    await supabaseAdmin
      .from("email_unsubscribe_tokens" as any)
      .upsert(
        { token: unsubscribeToken, email: normalized },
        { onConflict: "email", ignoreDuplicates: true } as any,
      );
    const { data: stored } = await supabaseAdmin
      .from("email_unsubscribe_tokens" as any)
      .select("token")
      .eq("email", normalized)
      .maybeSingle();
    unsubscribeToken = (stored as any)?.token ?? unsubscribeToken;
  }

  // Render the template.
  const element = React.createElement(partnerInviteTemplate.component, {
    firstName,
    inviteUrl,
  });
  const html = await render(element);
  const text = await render(element, { plainText: true });

  const messageId = crypto.randomUUID();

  // Append pending log row.
  await supabaseAdmin.from("email_send_log" as any).insert({
    message_id: messageId,
    template_name: "partner-invite",
    recipient_email: email,
    status: "pending",
  });

  const { error: enqueueError } = await supabaseAdmin.rpc(
    "enqueue_email" as any,
    {
      queue_name: "transactional_emails",
      payload: {
        message_id: messageId,
        to: email,
        from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
        sender_domain: SENDER_DOMAIN,
        subject:
          typeof partnerInviteTemplate.subject === "function"
            ? (partnerInviteTemplate.subject as (d: any) => string)({
                firstName,
                inviteUrl,
              })
            : (partnerInviteTemplate.subject as string),
        html,
        text,
        purpose: "transactional",
        label: "partner-invite",
        idempotency_key: messageId,
        unsubscribe_token: unsubscribeToken,
        queued_at: new Date().toISOString(),
      },
    } as any,
  );

  if (enqueueError) {
    await supabaseAdmin.from("email_send_log" as any).insert({
      message_id: messageId,
      template_name: "partner-invite",
      recipient_email: email,
      status: "failed",
      error_message: "Failed to enqueue invite email",
    });
    throw new Error("Could not queue the invite email. Please try again.");
  }

  return { ok: true };
}