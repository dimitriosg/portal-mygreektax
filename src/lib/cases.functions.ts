import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { requireAdminAccess } from "./access-context.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Cases, read and created from the pipeline.
//
// A case is a row in public.brain_conversations -- the table already carries
// case_serial_id, case_number, stage and client_id, and /review/$caseId already
// opens it. This file does not introduce a second case identity; it is the
// read/write surface the pipeline needs.
//
// Creation goes through public.open_case() and nowhere else. That function
// holds the per-client advisory lock, allocates case_number, mints the
// MGT-CSnnn-CLTnnnn serial and logs the case_opened event. Writing this table
// directly from here would be a second place the numbering logic lives, which
// is the thing the house rule in client-code.server.ts exists to prevent.
//
// CS001 is never created here. Every new client already gets it from the
// clients_open_first_case trigger, in the same transaction as the client
// insert. What this file adds is the deliberate second case and beyond.

const RECORD_ID = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9a-fA-F-]{36}$/, "Invalid record id");

export type CaseSummary = {
  id: string;
  caseSerialId: string | null;
  caseNumber: number | null;
  title: string | null;
  subject: string | null;
  stage: string | null;
  status: string | null;
  createdAt: string | null;
  closedAt: string | null;
};

export const listClientCases = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { clientId: string }) => z.object({ clientId: RECORD_ID }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    // Archived cases are excluded: restore_case() puts one back, and showing
    // them here would offer a second, quieter way to resurrect one.
    const { data: rows, error } = await supabaseAdmin
      .from("brain_conversations")
      .select(
        "id, case_serial_id, case_number, title, subject, stage, status, created_at, closed_at",
      )
      .eq("client_id", data.clientId)
      .is("archived_at", null)
      .order("case_number", { ascending: true, nullsFirst: false });

    if (error) throw new Error(`Failed to load cases: ${error.message}`);

    const cases: CaseSummary[] = (rows ?? []).map((row) => ({
      id: row.id,
      caseSerialId: row.case_serial_id,
      caseNumber: row.case_number,
      title: row.title,
      subject: row.subject,
      stage: row.stage,
      status: row.status,
      createdAt: row.created_at,
      closedAt: row.closed_at,
    }));

    return { cases };
  });

export const openCase = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { clientId: string; title?: string }) =>
    z
      .object({
        clientId: RECORD_ID,
        title: z.string().trim().max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    // p_source records who asked for this case, and it is what separates a
    // deliberate second case from the automatic CS001 in the activity feed:
    // 'first_case' is the trigger, 'pipeline' is a person on /leads.
    const { data: rows, error } = await supabaseAdmin.rpc("open_case", {
      p_client_id: data.clientId,
      p_title: data.title?.trim() || undefined,
      p_source: "pipeline",
    });

    if (error) throw new Error(`Failed to open the case: ${error.message}`);

    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.out_case_id) throw new Error("open_case returned no case");

    return {
      caseId: row.out_case_id,
      caseSerialId: row.out_case_serial_id,
      caseNumber: row.out_case_number,
    };
  });
