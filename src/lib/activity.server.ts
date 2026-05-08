import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type ActivityEventType =
  | "partner_invite_accepted"
  | "partner_login"
  | "partner_disabled"
  | "partner_enabled"
  | "job_created"
  | "job_status_changed"
  | "tracking_link_created"
  | "tracking_link_opened"
  | "tracking_link_extended";

export type ActivityEventInput = {
  eventType: ActivityEventType;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  subjectLabel?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Append an activity event. Best-effort: never throws — analytics must
 * never break a user-facing flow.
 */
export async function logActivityEvent(input: ActivityEventInput): Promise<void> {
  try {
    await supabaseAdmin.from("activity_events" as any).insert({
      event_type: input.eventType,
      actor_user_id: input.actorUserId ?? null,
      actor_email: input.actorEmail?.toLowerCase() ?? null,
      actor_name: input.actorName ?? null,
      subject_label: input.subjectLabel ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    console.error("logActivityEvent failed", err);
  }
}