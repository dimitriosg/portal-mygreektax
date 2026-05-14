import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

export type ActivityEventType =
  | "partner_invite_accepted"
  | "partner_login"
  | "partner_disabled"
  | "partner_enabled"
  | "job_created"
  | "job_change_request_created"
  | "job_change_request_decided"
  | "job_status_changed"
  | "tracking_link_created"
  | "tracking_link_regenerated"
  | "tracking_link_opened"
  | "tracking_link_extended";

export type ActivityEventInput = {
  eventType: ActivityEventType;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  subjectLabel?: string | null;
  metadata?: Json;
};

/**
 * Append an activity event. Best-effort: never throws — analytics must
 * never break a user-facing flow.
 */
export async function logActivityEvent(input: ActivityEventInput): Promise<boolean> {
  try {
    await supabaseAdmin.from("activity_events").insert({
      event_type: input.eventType,
      actor_user_id: input.actorUserId ?? null,
      actor_email: input.actorEmail?.toLowerCase() ?? null,
      actor_name: input.actorName ?? null,
      subject_label: input.subjectLabel ?? null,
      metadata: input.metadata ?? {},
    });
    return true;
  } catch (err) {
    console.error("logActivityEvent failed", err);
    return false;
  }
}
