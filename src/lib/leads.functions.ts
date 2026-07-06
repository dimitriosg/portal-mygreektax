import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import {
  airtableGet,
  airtableListAll,
  airtablePatch,
  TABLES,
  type AirtableRecord,
  type ClientFields,
  type MessageFields,
} from "./airtable.server";
import { createClientWithCode, deleteClient } from "./client-code.server";
import { CLIENT_STAGES, LEAD_URGENCY_OPTIONS } from "./leads-shared";
import { requireAdminAccess } from "./access-context.server";
import { logActivityEvent } from "./activity.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Internal-only pipeline view (Jim only) — every endpoint here requires admin
// access. As of Task 4 (single-base consolidation) a "lead" is just a Client
// record with Stage = "Potential"; there is no separate CRM base or Lead
// entity, and no linking step — the record IS the client from day one.
// Unlike Jobs, there is no partner-facing variant and no change-request workflow:
// the admin is both requester and approver, so writes go straight to Airtable.

const RECORD_ID = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9a-fA-F-]{36}$/, "Invalid record id");

// Ticket C, Part 2 — every updateLead field except Stage (Stage keeps its
// own lead_stage_changed event above, unchanged from Ticket B), mapped to
// the Airtable field name it writes. Drives the generic diff-and-log loop
// in updateLead's handler so every field the dialog's Save button and the
// pipeline's quickUpdate can touch ends up in the one activity_events
// stream — not a second table, not a second log.
const UPDATE_LEAD_LOG_FIELDS: ReadonlyArray<{
  key:
    | "urgency"
    | "leadValue"
    | "notes"
    | "lostReason"
    | "email"
    | "phone"
    | "nationality"
    | "afm"
    | "taxisnetAccess"
    | "cadence"
    | "caseCode"
    | "quoteSentDate"
    | "quoteAmount"
    | "deposit"
    | "balanceDue"
    | "partnerFee"
    | "parkedReason"
    | "nextAction"
    | "nextActionDate"
    | "fullName"
    | "clientCode"
    | "status"
    | "source"
    | "clientVisibleNote"
    | "threadId";
  airtableField: string;
}> = [
  { key: "urgency", airtableField: "Urgency" },
  { key: "leadValue", airtableField: "Lead Value (€)" },
  { key: "notes", airtableField: "Notes" },
  { key: "lostReason", airtableField: "Lost Reason" },
  { key: "email", airtableField: "Email" },
  { key: "phone", airtableField: "Phone" },
  { key: "nationality", airtableField: "Nationality" },
  { key: "afm", airtableField: "AFM" },
  { key: "taxisnetAccess", airtableField: "TAXISnet Access" },
  { key: "cadence", airtableField: "Cadence" },
  { key: "caseCode", airtableField: "Case Code" },
  { key: "quoteSentDate", airtableField: "Quote Sent Date" },
  { key: "quoteAmount", airtableField: "Quote Amount €" },
  { key: "deposit", airtableField: "Deposit €" },
  { key: "balanceDue", airtableField: "Balance Due €" },
  { key: "partnerFee", airtableField: "Partner Fee €" },
  { key: "parkedReason", airtableField: "Parked Reason" },
  { key: "nextAction", airtableField: "Next Action" },
  { key: "nextActionDate", airtableField: "Next Action Date" },
  { key: "fullName", airtableField: "Full Name" },
  { key: "clientCode", airtableField: "Client Code" },
  { key: "status", airtableField: "Status" },
  { key: "source", airtableField: "Source" },
  { key: "clientVisibleNote", airtableField: "Client Visible Note" },
  { key: "threadId", airtableField: "Thread ID" },
];

export const listLeads = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const data = await airtableListAll<ClientFields>(TABLES.clients, { pageSize: "100" });
    return { leads: data.records as AirtableRecord<ClientFields>[] };
  });

export const updateLead = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: {
      leadId: string;
      stage?: string;
      urgency?: string | null;
      leadValue?: number | null;
      notes?: string;
      lostReason?: string;
      email?: string;
      phone?: string;
      nationality?: string;
      afm?: string;
      taxisnetAccess?: boolean;
      cadence?: string;
      caseCode?: string;
      quoteSentDate?: string | null;
      quoteAmount?: number | null;
      deposit?: number | null;
      balanceDue?: number | null;
      partnerFee?: number | null;
      parkedReason?: string;
      nextAction?: string;
      nextActionDate?: string | null;
      fullName?: string;
      clientCode?: string;
      status?: string;
      source?: string;
      clientVisibleNote?: string;
      threadId?: string;
    }) =>
      z
        .object({
          leadId: RECORD_ID,
          stage: z.enum(CLIENT_STAGES).optional(),
          urgency: z.enum(LEAD_URGENCY_OPTIONS).nullable().optional(),
          leadValue: z.number().min(0).max(1_000_000).nullable().optional(),
          notes: z.string().max(5000).optional(),
          lostReason: z.string().max(500).optional(),
          email: z.string().email().max(200).optional(),
          phone: z.string().max(50).optional(),
          nationality: z.string().max(100).optional(),
          afm: z.string().max(50).optional(),
          taxisnetAccess: z.boolean().optional(),
          cadence: z.string().max(100).optional(),
          caseCode: z.string().max(100).optional(),
          quoteSentDate: z.string().nullable().optional(),
          quoteAmount: z.number().min(0).max(1_000_000).nullable().optional(),
          deposit: z.number().min(0).max(1_000_000).nullable().optional(),
          balanceDue: z.number().min(0).max(1_000_000).nullable().optional(),
          partnerFee: z.number().min(0).max(1_000_000).nullable().optional(),
          parkedReason: z.string().max(500).optional(),
          nextAction: z.string().max(2000).optional(),
          nextActionDate: z.string().nullable().optional(),
          fullName: z.string().max(200).optional(),
          clientCode: z.string().max(100).optional(),
          status: z.string().max(100).optional(),
          source: z.string().max(200).optional(),
          clientVisibleNote: z.string().max(5000).optional(),
          threadId: z.string().max(200).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const existing = (await airtableGet(
      `${TABLES.clients}/${data.leadId}`,
    )) as AirtableRecord<ClientFields>;
    const previousStage = existing.fields.Stage ?? null;

    const fields: Record<string, unknown> = {};
    if (data.stage !== undefined) fields["Stage"] = data.stage;
    if (data.urgency !== undefined) fields["Urgency"] = data.urgency;
    if (data.leadValue !== undefined) fields["Lead Value (€)"] = data.leadValue;
    if (data.notes !== undefined) fields["Notes"] = data.notes;
    if (data.lostReason !== undefined) fields["Lost Reason"] = data.lostReason;
    if (data.email !== undefined) fields["Email"] = data.email;
    if (data.phone !== undefined) fields["Phone"] = data.phone;
    if (data.nationality !== undefined) fields["Nationality"] = data.nationality;
    if (data.afm !== undefined) fields["AFM"] = data.afm;
    if (data.taxisnetAccess !== undefined) fields["TAXISnet Access"] = data.taxisnetAccess;
    if (data.cadence !== undefined) fields["Cadence"] = data.cadence;
    if (data.caseCode !== undefined) fields["Case Code"] = data.caseCode;
    if (data.quoteSentDate !== undefined) fields["Quote Sent Date"] = data.quoteSentDate;
    if (data.quoteAmount !== undefined) fields["Quote Amount €"] = data.quoteAmount;
    if (data.deposit !== undefined) fields["Deposit €"] = data.deposit;
    if (data.balanceDue !== undefined) fields["Balance Due €"] = data.balanceDue;
    if (data.partnerFee !== undefined) fields["Partner Fee €"] = data.partnerFee;
    if (data.parkedReason !== undefined) fields["Parked Reason"] = data.parkedReason;
    if (data.nextAction !== undefined) fields["Next Action"] = data.nextAction;
    if (data.nextActionDate !== undefined) fields["Next Action Date"] = data.nextActionDate;
    if (data.fullName !== undefined) fields["Full Name"] = data.fullName;
    if (data.clientCode !== undefined) fields["Client Code"] = data.clientCode;
    if (data.status !== undefined) fields.Status = data.status;
    if (data.source !== undefined) fields.Source = data.source;
    if (data.clientVisibleNote !== undefined) fields["Client Visible Note"] = data.clientVisibleNote;
    if (data.threadId !== undefined) fields["Thread ID"] = data.threadId;

    const updated = (await airtablePatch(
      TABLES.clients,
      data.leadId,
      fields,
    )) as AirtableRecord<ClientFields>;

    if (data.stage !== undefined && data.stage !== previousStage) {
      await logActivityEvent({
        eventType: "lead_stage_changed",
        actorUserId: context.userId,
        actorEmail: context.claims.email as string | undefined,
        subjectLabel: existing.fields["Full Name"] ?? data.leadId,
        metadata: { leadId: data.leadId, field: "Stage", from: previousStage, to: data.stage },
      });
    }

    // Ticket C, Part 2 — audit log for every other field this handler can
    // write, covering both the Ticket B inline quickUpdate calls (Next
    // Action / Next Action Date) and the detail dialog's batch Save (the
    // rest). Reuses the SAME logActivityEvent + activity_events stream as
    // lead_stage_changed/lead_created above — no second logging system.
    // Diffed against `existing` (fetched once, above) so a field only logs
    // when its value actually changed, whether the caller sent one field
    // (quickUpdate) or the whole form (batch Save).
    type LoggableValue = string | number | boolean | null;
    const normalize = (v: unknown): LoggableValue =>
      v === undefined ? null : (v as LoggableValue);
    for (const { key, airtableField } of UPDATE_LEAD_LOG_FIELDS) {
      const rawNewValue = (data as Record<string, unknown>)[key];
      if (rawNewValue === undefined) continue;
      const rawOldValue = (existing.fields as Record<string, unknown>)[airtableField];
      const oldValue = normalize(rawOldValue);
      const newValue = normalize(rawNewValue);
      if (oldValue === newValue) continue;
      await logActivityEvent({
        eventType: "lead_field_changed",
        actorUserId: context.userId,
        actorEmail: context.claims.email as string | undefined,
        subjectLabel: existing.fields["Full Name"] ?? data.leadId,
        metadata: {
          leadId: data.leadId,
          field: airtableField,
          from: oldValue,
          to: newValue,
        },
      });
    }

    return { lead: updated };
  });

export const deleteLead = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { leadId: string }) => z.object({ leadId: RECORD_ID }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const existing = (await airtableGet(
      `${TABLES.clients}/${data.leadId}`,
    )) as AirtableRecord<ClientFields>;

    await logActivityEvent({
      eventType: "lead_deleted",
      actorUserId: context.userId,
      actorEmail: context.claims.email as string | undefined,
      subjectLabel: existing.fields["Full Name"] ?? data.leadId,
      metadata: {
        leadId: data.leadId,
        client_code: existing.fields["Client Code"] ?? null,
        full_name: existing.fields["Full Name"] ?? null,
        email: existing.fields.Email ?? null,
      },
    });

    return deleteClient(data.leadId);
  });

export const createLead = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: {
      leadName: string;
      email: string;
      phone?: string;
      urgency?: string;
      situation?: string;
    }) =>
      z
        .object({
          leadName: z.string().min(1).max(200),
          email: z.string().email().max(200),
          phone: z.string().max(50).optional(),
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

    // Client Code is generated by the one shared function (client-code.server.ts)
    // so numbering logic never gets reimplemented at a second call site.
    // Nationality is always XX here — set manually on review, not guessed.
    const created = await createClientWithCode({
      "Full Name": data.leadName,
      Email: data.email,
      Phone: data.phone,
      Urgency: data.urgency,
      Notes: data.situation,
      Stage: "Potential",
      Status: "Prospect",
      Source: "Manual entry",
    });

    await logActivityEvent({
      eventType: "lead_created",
      actorUserId: context.userId,
      actorEmail: context.claims.email as string | undefined,
      subjectLabel: data.leadName,
      metadata: { leadId: created.id, source: "manual" },
    });

    return { lead: created as AirtableRecord<ClientFields> };
  });

// Ticket C, Part 2b — read-only history for one client, newest first.
// Reads the same activity_events stream every other logActivityEvent call
// writes to (Stage changes, Ticket C field-diff entries, lead_created) —
// filtered by metadata.leadId, since that's the one place every one of
// those entries already records which Client record it's about.
export const listLeadActivity = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { leadId: string }) => z.object({ leadId: RECORD_ID }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: events, error } = await supabaseAdmin
      .from("activity_events")
      .select("*")
      .in("event_type", ["lead_stage_changed", "lead_field_changed", "lead_created"])
      .eq("metadata->>leadId", data.leadId)
      .order("occurred_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(`Failed to load activity history: ${error.message}`);

    return { events: events ?? [] };
  });

export const listLeadThread = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { leadId: string }) => z.object({ leadId: RECORD_ID }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    // Note: {Client} inside a filterByFormula resolves to the *primary field
    // value* of the linked record(s), not the record id -- so filtering by record id
    // via formula never matches. The REST API response itself does return the linked
    // record ids directly on each row, so we fetch and filter client-side instead.
    const messages = await airtableListAll<MessageFields>(TABLES.messages, {});

    return {
      messages: messages.records.filter((r) =>
        (r.fields.Client ?? []).includes(data.leadId),
      ) as AirtableRecord<MessageFields>[],
    };
  });
