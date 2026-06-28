import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import {
  airtableGet,
  airtableListAll,
  airtablePatch,
  airtablePost,
  CRM_BASE_ID,
  CRM_TABLES,
  type AirtableRecord,
  type LeadFields,
  type MessageFields,
  type ActivityFields,
} from "./airtable.server";
import { LEAD_STAGES, LEAD_STATUSES, LEAD_URGENCY_OPTIONS } from "./leads-shared";
import { requireAdminAccess } from "./access-context.server";
import { logActivityEvent } from "./activity.server";

// Internal-only CRM view (Jim only) — every endpoint here requires admin access.
// Unlike Jobs, there is no partner-facing variant and no change-request workflow:
// the admin is both requester and approver, so writes go straight to Airtable.

const RECORD_ID = z.string().min(1).max(80).regex(/^rec[A-Za-z0-9]+$/, "Invalid record id");

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
      email?: string;
      phone?: string;
      company?: string;
    }) =>
      z
        .object({
          leadId: RECORD_ID,
          stage: z.enum(LEAD_STAGES).optional(),
          leadStatus: z.enum(LEAD_STATUSES).optional(),
          urgency: z.enum(LEAD_URGENCY_OPTIONS).optional(),
          leadValue: z.number().min(0).max(1_000_000).nullable().optional(),
          notes: z.string().max(5000).optional(),
          lostReason: z.string().max(500).optional(),
          email: z.string().email().max(200).optional(),
          phone: z.string().max(50).optional(),
          company: z.string().max(200).optional(),
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

    // Once a lead is linked to an Ops client, the CRM<->Ops sync ("Sync: Ops
    // Client -> CRM Lead outcome") drives Stage/Lead status from Client.Status
    // on its own 15-min cadence. Manual edits to those two fields here would
    // get silently reverted on the next sync run, so block them post-link
    // rather than let Jim "fix" something that quietly un-fixes itself.
    const isLinked = Boolean(existing.fields["Ops Client Record ID"]);
    if (isLinked && (data.stage !== undefined || data.leadStatus !== undefined)) {
      throw new Error(
        "This lead is linked to a client — Stage and Lead status are now managed " +
          "automatically by the CRM↔Ops sync and can't be edited here.",
      );
    }

    const fields: Record<string, unknown> = {};
    if (data.stage !== undefined) fields["Stage"] = data.stage;
    if (data.leadStatus !== undefined) fields["Lead status"] = data.leadStatus;
    if (data.urgency !== undefined) fields["Urgency"] = data.urgency;
    if (data.leadValue !== undefined) fields["Lead value"] = data.leadValue;
    if (data.notes !== undefined) fields["Notes"] = data.notes;
    if (data.lostReason !== undefined) fields["Lost reason"] = data.lostReason;
    if (data.email !== undefined) fields["Email"] = data.email;
    if (data.phone !== undefined) fields["Phone"] = data.phone;
    if (data.company !== undefined) fields["Company"] = data.company;

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

export const createLead = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: {
      leadName: string;
      email: string;
      phone?: string;
      company?: string;
      urgency?: string;
      situation?: string;
    }) =>
      z
        .object({
          leadName: z.string().min(1).max(200),
          email: z.string().email().max(200),
          phone: z.string().max(50).optional(),
          company: z.string().max(200).optional(),
          urgency: z.enum(LEAD_URGENCY_OPTIONS).optional(),
          situation: z.string().max(2000).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const created = await airtablePost(
      CRM_TABLES.leads,
      {
        "Lead Name": data.leadName,
        Email: data.email,
        Phone: data.phone,
        Company: data.company,
        Urgency: data.urgency,
        Situation: data.situation,
        Stage: "New",
        "Lead status": "New",
        "Submission date": new Date().toISOString(),
        "Referral source": "Manual entry",
      },
      CRM_BASE_ID,
    );

    await logActivityEvent({
      eventType: "lead_created",
      actorUserId: context.userId,
      actorEmail: context.claims.email as string | undefined,
      subjectLabel: data.leadName,
      metadata: { leadId: created.id, source: "manual" },
    });

    return { lead: created as AirtableRecord<LeadFields> };
  });

export const listLeadThread = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { leadId: string }) => z.object({ leadId: RECORD_ID }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const [messages, activities] = await Promise.all([
      airtableListAll<MessageFields>(
        CRM_TABLES.messages,
        { filterByFormula: `FIND("${data.leadId}", ARRAYJOIN({Lead}))` },
        CRM_BASE_ID,
      ),
      airtableListAll<ActivityFields>(
        CRM_TABLES.activities,
        { filterByFormula: `FIND("${data.leadId}", ARRAYJOIN({Leads}))` },
        CRM_BASE_ID,
      ),
    ]);

    return {
      messages: messages.records as AirtableRecord<MessageFields>[],
      activities: activities.records as AirtableRecord<ActivityFields>[],
    };
  });
