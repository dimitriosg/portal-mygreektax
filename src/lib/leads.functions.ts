import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import type { AirtableRecord, ClientFields, MessageFields } from "./airtable.server";
import { createClientWithCode, deleteClient } from "./client-code.server";
import { CLIENT_STAGES, LEAD_URGENCY_OPTIONS } from "./leads-shared";
import { requireAdminAccess } from "./access-context.server";
import { logActivityEvent } from "./activity.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

// Internal-only pipeline view (Jim only) — every endpoint here requires admin
// access. A "lead" is just a Client record with Stage = "Potential"; there is
// no separate CRM base. All data lives in the Supabase public.clients table.

type ClientRow = Database["public"]["Tables"]["clients"]["Row"];
type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

const RECORD_ID = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9a-fA-F-]{36}$/, "Invalid record id");

// ---------------------------------------------------------------------------
// Mapping layer: Supabase snake_case rows ↔ AirtableRecord<ClientFields>
// shape that the frontend (src/routes/leads.tsx) already consumes.
// ---------------------------------------------------------------------------

function rowToLead(row: ClientRow): AirtableRecord<ClientFields> {
  return {
    id: row.id,
    createdTime: row.created_at,
    fields: {
      "Full Name": row.full_name ?? undefined,
      "Client Code": row.client_code ?? undefined,
      Email: row.email ?? undefined,
      Phone: row.phone ?? undefined,
      Status: row.status ?? undefined,
      Notes: row.notes ?? undefined,
      Stage: row.stage ?? undefined,
      Source: row.source ?? undefined,
      Urgency: row.urgency ?? undefined,
      "Lead Value (€)": row.lead_value ?? undefined,
      "Lost Reason": row.lost_reason ?? undefined,
      "Next Action": row.next_action ?? undefined,
      "Next Action Date": row.next_action_date ?? undefined,
      "Last activity": row.last_activity ?? undefined,
      Nationality: row.nationality ?? undefined,
      AFM: row.afm ?? undefined,
      "TAXISnet Access": row.taxisnet_access ?? undefined,
      Cadence: row.cadence ?? undefined,
      "Case Code": row.case_code ?? undefined,
      "Quote Sent Date": row.quote_sent_date ?? undefined,
      "Quote Amount €": row.quote_amount ?? undefined,
      "Deposit €": row.deposit ?? undefined,
      "Balance Due €": row.balance_due ?? undefined,
      "Partner Fee €": row.partner_fee ?? undefined,
      "Parked Reason": row.parked_reason ?? undefined,
      "Client Visible Note": row.client_visible_note ?? undefined,
      "Thread ID": row.thread_id ?? undefined,
    },
  };
}

function rowToMessage(row: MessageRow): AirtableRecord<MessageFields> {
  return {
    id: row.id,
    createdTime: row.created_at,
    fields: {
      "Message ID": row.message_id ?? undefined,
      Client: row.client_id ? [row.client_id] : undefined,
      Direction: row.direction ?? undefined,
      Timestamp: row.ts ?? undefined,
      Subject: row.subject ?? undefined,
      Body: row.body ?? undefined,
      "Thread ID": row.thread_id ?? undefined,
      From: row.from_addr ?? undefined,
      To: row.to_addr ?? undefined,
    },
  };
}

// Ticket C, Part 2 — maps each updateLead camelCase input key to both its
// Airtable-cased UI field name (used for activity logging metadata.field) and
// its snake_case Supabase column name (used for the actual DB write).
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
  column: string;
}> = [
  { key: "urgency", airtableField: "Urgency", column: "urgency" },
  { key: "leadValue", airtableField: "Lead Value (€)", column: "lead_value" },
  { key: "notes", airtableField: "Notes", column: "notes" },
  { key: "lostReason", airtableField: "Lost Reason", column: "lost_reason" },
  { key: "email", airtableField: "Email", column: "email" },
  { key: "phone", airtableField: "Phone", column: "phone" },
  { key: "nationality", airtableField: "Nationality", column: "nationality" },
  { key: "afm", airtableField: "AFM", column: "afm" },
  { key: "taxisnetAccess", airtableField: "TAXISnet Access", column: "taxisnet_access" },
  { key: "cadence", airtableField: "Cadence", column: "cadence" },
  { key: "caseCode", airtableField: "Case Code", column: "case_code" },
  { key: "quoteSentDate", airtableField: "Quote Sent Date", column: "quote_sent_date" },
  { key: "quoteAmount", airtableField: "Quote Amount €", column: "quote_amount" },
  { key: "deposit", airtableField: "Deposit €", column: "deposit" },
  { key: "balanceDue", airtableField: "Balance Due €", column: "balance_due" },
  { key: "partnerFee", airtableField: "Partner Fee €", column: "partner_fee" },
  { key: "parkedReason", airtableField: "Parked Reason", column: "parked_reason" },
  { key: "nextAction", airtableField: "Next Action", column: "next_action" },
  { key: "nextActionDate", airtableField: "Next Action Date", column: "next_action_date" },
  { key: "fullName", airtableField: "Full Name", column: "full_name" },
  { key: "clientCode", airtableField: "Client Code", column: "client_code" },
  { key: "status", airtableField: "Status", column: "status" },
  { key: "source", airtableField: "Source", column: "source" },
  { key: "clientVisibleNote", airtableField: "Client Visible Note", column: "client_visible_note" },
  { key: "threadId", airtableField: "Thread ID", column: "thread_id" },
];

export const listLeads = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const { data: rows, error } = await supabaseAdmin
      .from("clients")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to list leads: ${error.message}`);
    return { leads: (rows ?? []).map(rowToLead) };
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

    // Fetch existing row from Supabase for diff-and-log.
    const { data: existingRow, error: fetchErr } = await supabaseAdmin
      .from("clients")
      .select("*")
      .eq("id", data.leadId)
      .single();
    if (fetchErr || !existingRow)
      throw new Error(`Lead not found: ${fetchErr?.message ?? data.leadId}`);

    const existing = rowToLead(existingRow);
    const previousStage = existing.fields.Stage ?? null;

    // Build snake_case update payload for Supabase.
    type ClientUpdate = Database["public"]["Tables"]["clients"]["Update"];
    const cols: ClientUpdate = {};
    if (data.stage !== undefined) cols.stage = data.stage;
    for (const { key, column } of UPDATE_LEAD_LOG_FIELDS) {
      const val = (data as Record<string, unknown>)[key];
      if (val !== undefined) (cols as Record<string, unknown>)[column] = val;
    }

    const { data: updatedRow, error: updateErr } = await supabaseAdmin
      .from("clients")
      .update(cols)
      .eq("id", data.leadId)
      .select("*")
      .single();
    if (updateErr || !updatedRow)
      throw new Error(`Failed to update lead: ${updateErr?.message ?? "no row"}`);

    const updated = rowToLead(updatedRow);

    if (data.stage !== undefined && data.stage !== previousStage) {
      await logActivityEvent({
        eventType: "lead_stage_changed",
        actorUserId: context.userId,
        actorEmail: context.claims.email as string | undefined,
        subjectLabel: existing.fields["Full Name"] ?? data.leadId,
        metadata: { leadId: data.leadId, field: "Stage", from: previousStage, to: data.stage },
      });
    }

    // Audit log for every other field — diffed against existing row.
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

    // Fetch from Supabase for audit-log snapshot before deletion.
    const { data: existingRow, error: fetchErr } = await supabaseAdmin
      .from("clients")
      .select("*")
      .eq("id", data.leadId)
      .single();
    if (fetchErr || !existingRow)
      throw new Error(`Lead not found: ${fetchErr?.message ?? data.leadId}`);

    const existing = rowToLead(existingRow);

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
      full_name: data.leadName,
      email: data.email,
      phone: data.phone,
      urgency: data.urgency,
      notes: data.situation,
      stage: "Potential",
      status: "Prospect",
      source: "Manual entry",
    });

    await logActivityEvent({
      eventType: "lead_created",
      actorUserId: context.userId,
      actorEmail: context.claims.email as string | undefined,
      subjectLabel: data.leadName,
      metadata: { leadId: created.id, source: "manual" },
    });

    return { lead: rowToLead(created as ClientRow) };
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

    // Messages table exists in Supabase with client_id FK → clients.id.
    const { data: rows, error } = await supabaseAdmin
      .from("messages")
      .select("*")
      .eq("client_id", data.leadId)
      .order("ts", { ascending: true });
    if (error) throw new Error(`Failed to load message thread: ${error.message}`);

    return {
      messages: (rows ?? []).map(rowToMessage) as AirtableRecord<MessageFields>[],
    };
  });
