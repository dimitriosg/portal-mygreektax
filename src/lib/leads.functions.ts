import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import {
  airtableGet,
  airtableListAll,
  airtablePatch,
  CRM_BASE_ID,
  CRM_TABLES,
  type AirtableRecord,
  type LeadFields,
} from "./airtable.server";
import { LEAD_STAGES, LEAD_STATUSES, LEAD_URGENCY_OPTIONS } from "./leads-shared";
import { requireAdminAccess } from "./access-context.server";
import { logActivityEvent } from "./activity.server";

// Internal-only CRM view (Jim only) — every endpoint here requires admin access.
// Unlike Jobs, there is no partner-facing variant and no change-request workflow:
// the admin is both requester and approver, so writes go straight to Airtable.

export const listLeads = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const data = await airtableListAll<LeadFields>(
      CRM_TABLES.leads,
      { pageSize: "100" },
      CRM_BASE_ID,
    );
    return { leads: data.records as AirtableRecord<LeadFields>[] };
  });

export const updateLead = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: {
      leadId: string;
      stage?: string;
      leadStatus?: string;
      urgency?: string;
      leadValue?: number | null;
      notes?: string;
      lostReason?: string;
    }) =>
      z
        .object({
          leadId: z.string().min(1).max(50),
          stage: z.enum(LEAD_STAGES).optional(),
          leadStatus: z.enum(LEAD_STATUSES).optional(),
          urgency: z.enum(LEAD_URGENCY_OPTIONS).optional(),
          leadValue: z.number().min(0).max(1_000_000).nullable().optional(),
          notes: z.string().max(5000).optional(),
          lostReason: z.string().max(500).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const existing = (await airtableGet(
      `${CRM_TABLES.leads}/${data.leadId}`,
      undefined,
      CRM_BASE_ID,
    )) as AirtableRecord<LeadFields>;
    const previousStage = existing.fields.Stage ?? null;

    const fields: Record<string, unknown> = {};
    if (data.stage !== undefined) fields["Stage"] = data.stage;
    if (data.leadStatus !== undefined) fields["Lead status"] = data.leadStatus;
    if (data.urgency !== undefined) fields["Urgency"] = data.urgency;
    if (data.leadValue !== undefined) fields["Lead value"] = data.leadValue;
    if (data.notes !== undefined) fields["Notes"] = data.notes;
    if (data.lostReason !== undefined) fields["Lost reason"] = data.lostReason;

    const updated = (await airtablePatch(
      CRM_TABLES.leads,
      data.leadId,
      fields,
      CRM_BASE_ID,
    )) as AirtableRecord<LeadFields>;

    if (data.stage !== undefined && data.stage !== previousStage) {
      await logActivityEvent({
        eventType: "lead_stage_changed",
        actorUserId: context.userId,
        actorEmail: context.claims.email as string | undefined,
        subjectLabel: existing.fields["Lead Name"] ?? data.leadId,
        metadata: { leadId: data.leadId, from: previousStage, to: data.stage },
      });
    }

    return { lead: updated };
  });
