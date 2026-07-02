import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import {
  airtableGet,
  airtableListAll,
  airtablePatch,
  airtablePost,
  TABLES,
  type AirtableRecord,
  type ClientFields,
  type MessageFields,
} from "./airtable.server";
import { CLIENT_STAGES, LEAD_URGENCY_OPTIONS } from "./leads-shared";
import { requireAdminAccess } from "./access-context.server";
import { logActivityEvent } from "./activity.server";

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
  .regex(/^rec[A-Za-z0-9]+$/, "Invalid record id");

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

    // Client Code is intentionally left blank here, same as the Incoming Form
    // automation — auto-numbering per the CLT####-XX standard is a separate,
    // not-yet-built piece of work (needs a "next available number" lookup).
    const created = await airtablePost(TABLES.clients, {
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
