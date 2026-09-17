import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { requireAdminAccess } from "./access-context.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivityEvent } from "./activity.server";
import { CLIENT_STAGES } from "./leads-shared";

// Cases, and the jobs filed under them, read and written from the pipeline.
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

export type CaseJob = {
  id: string;
  jobCode: string | null;
  status: string | null;
};

export type CaseSummary = {
  id: string;
  caseSerialId: string | null;
  /** "CS001" -- the short form, for showing beside a job. */
  caseCode: string | null;
  caseNumber: number | null;
  title: string | null;
  subject: string | null;
  stage: string | null;
  status: string | null;
  jobs: CaseJob[];
};

/** MGT-CS002-CLT0039 -> CS002. Null when the serial is missing or malformed. */
function shortCaseCode(serial: string | null): string | null {
  if (!serial) return null;
  const m = serial.match(/(CS\d+)/);
  return m ? m[1] : null;
}

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
    const [casesRes, jobsRes] = await Promise.all([
      supabaseAdmin
        .from("brain_conversations")
        .select("id, case_serial_id, case_number, title, subject, stage, status")
        .eq("client_id", data.clientId)
        .is("archived_at", null)
        .order("case_number", { ascending: true, nullsFirst: false }),
      supabaseAdmin
        .from("jobs")
        .select("id, job_code, status, case_id")
        .eq("client_id", data.clientId)
        .order("job_code", { ascending: true }),
    ]);

    if (casesRes.error) throw new Error(`Failed to load cases: ${casesRes.error.message}`);
    if (jobsRes.error)
      throw new Error(`Failed to load the client's jobs: ${jobsRes.error.message}`);

    const jobsByCaseId = new Map<string, CaseJob[]>();
    // Which case each job sits under, keyed by job id, so the flat jobs list
    // can show "CS001" beside a job without a second round trip.
    const caseCodeByJobId: Record<string, string> = {};

    const cases: CaseSummary[] = (casesRes.data ?? []).map((row) => ({
      id: row.id,
      caseSerialId: row.case_serial_id,
      caseCode: shortCaseCode(row.case_serial_id),
      caseNumber: row.case_number,
      title: row.title,
      subject: row.subject,
      stage: row.stage,
      status: row.status,
      jobs: [],
    }));
    const caseById = new Map(cases.map((c) => [c.id, c]));

    for (const job of jobsRes.data ?? []) {
      if (!job.case_id) continue;
      const parent = caseById.get(job.case_id);
      // A job whose case is archived keeps its case_id but has no case to nest
      // under here. It still shows in the flat list below, unfiled.
      if (!parent) continue;
      const entry: CaseJob = { id: job.id, jobCode: job.job_code, status: job.status };
      const list = jobsByCaseId.get(job.case_id) ?? [];
      list.push(entry);
      jobsByCaseId.set(job.case_id, list);
      if (parent.caseCode) caseCodeByJobId[job.id] = parent.caseCode;
    }

    for (const c of cases) c.jobs = jobsByCaseId.get(c.id) ?? [];

    return { cases, caseCodeByJobId };
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

// Rename a case, at any point in its life.
//
// The title is the human answer to "what was this case about?", and that answer
// is often only clear once the work has started -- a case opened from an email
// begins with no title at all. Changing it is an ordinary edit, not a
// correction, so it needs no reason. It is still logged, because the title is
// what the case is known by afterwards.
//
// Only the title moves. case_serial_id and case_number are identity and are
// never touched here; open_case() is the only thing that sets them.
export const renameCase = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { caseId: string; title: string }) =>
    z.object({ caseId: RECORD_ID, title: z.string().trim().max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("brain_conversations")
      .select("id, title, case_serial_id, client_id")
      .eq("id", data.caseId)
      .single();
    if (fetchErr || !existing) {
      throw new Error(`Case not found: ${fetchErr?.message ?? data.caseId}`);
    }

    // Empty clears the title back to "no title yet" rather than storing "".
    const nextTitle = data.title.trim() || null;
    if ((existing.title ?? null) === nextTitle) {
      return { caseId: existing.id, title: nextTitle, unchanged: true };
    }

    const { error: updateErr } = await supabaseAdmin
      .from("brain_conversations")
      .update({ title: nextTitle })
      .eq("id", data.caseId);
    if (updateErr) throw new Error(`Could not rename the case: ${updateErr.message}`);

    await logActivityEvent({
      eventType: "case_renamed",
      actorUserId: context.userId,
      actorEmail: (context.claims.email as string | undefined) ?? null,
      subjectLabel: existing.case_serial_id ?? existing.id,
      metadata: {
        leadId: existing.client_id,
        caseId: existing.id,
        caseSerialId: existing.case_serial_id,
        from: existing.title,
        to: nextTitle,
      },
    });

    return { caseId: existing.id, title: nextTitle, unchanged: false };
  });

// Set a case's stage by hand.
//
// Safe to offer only because clients_sync_stage_to_conversations is gone. While
// that trigger existed it stamped the client's stage onto every case on any
// change, so a control here would have been silently undone -- worse than no
// control at all.
//
// recompute_case_stage still moves a case when its jobs move, and deliberately
// does nothing when a case has no jobs or none have started. So a stage set
// here survives until the work itself says otherwise.
//
// The work happens inside public.set_case_stage() for the same reason
// assign_job_to_case exists: the stage update and its audit row have to commit
// together, and the case row has to be locked across the read and the write so
// a job trigger cannot slip recompute_case_stage in between and leave this
// function logging a "from" stage that is already stale.
export const setCaseStage = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { caseId: string; stage: string }) =>
    z
      .object({
        caseId: RECORD_ID,
        stage: z.enum(CLIENT_STAGES),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: rows, error } = await supabaseAdmin.rpc("set_case_stage", {
      p_case_id: data.caseId,
      p_stage: data.stage,
      p_actor_user_id: context.userId,
      p_actor_email: (context.claims.email as string | undefined) ?? undefined,
    });

    // The function raises for a missing case and an archived one, so its
    // message is already the sentence to show.
    if (error) throw new Error(error.message);

    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error("set_case_stage returned nothing");

    return {
      caseId: row.out_case_id,
      stage: row.out_to_stage,
      fromStage: row.out_from_stage,
      unchanged: row.out_unchanged,
    };
  });

// File a job under a case, or take it back out (caseId: null).
//
// Never inferred, always a person's decision, and always audited: who, when,
// from which case and to which case. The reason is optional -- it adds colour
// when there is colour to add, and requiring one for an obvious filing only
// trains people to type "x".
//
// The work happens inside public.assign_job_to_case() rather than here,
// because the job update and its audit row have to commit together. Two
// PostgREST calls cannot be made atomic from this side, and no ordering fixes
// it: audit-first can leave an audit row for an update that failed,
// audit-second can leave a filed job with no audit row -- and retrying that
// second case finds the job already filed, reports "unchanged", and never
// repairs the missing row. One plpgsql function makes both writes land or
// neither.
export const assignJobToCase = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string; caseId: string | null; reason?: string }) =>
    z
      .object({
        jobId: RECORD_ID,
        caseId: RECORD_ID.nullable(),
        reason: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: rows, error } = await supabaseAdmin.rpc("assign_job_to_case", {
      p_job_id: data.jobId,
      p_case_id: data.caseId,
      // The argument has no SQL default, so it is always sent. The function
      // does nullif(btrim(...), '') on it, which turns a blank into a real
      // NULL rather than storing an empty string in the audit row.
      p_reason: data.reason ?? "",
      p_actor_user_id: context.userId,
      p_actor_email: (context.claims.email as string | undefined) ?? undefined,
    });

    // The function raises for a missing job, a case belonging to another
    // client and an archived case, so its message is already the sentence to
    // show.
    if (error) throw new Error(error.message);

    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error("assign_job_to_case returned nothing");

    return {
      jobId: row.out_job_id,
      caseId: row.out_case_id,
      fromCaseId: row.out_from_case_id,
      unchanged: row.out_unchanged,
    };
  });
