import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireAdminAccess } from "./access-context.server";
import type {
  CaseMessageRow,
  CorrespondenceRow,
  SyncRunRow,
  UnmatchedPartnerMessage,
} from "./correspondence-shared";

// Read and refresh side of the Correspondence view on /leads. Admin only.
//
// WHY EVERYTHING GOES THROUGH THE SERVICE ROLE.
//
// public.messages has RLS enabled and zero policies, which is deliberate: the
// table holds client correspondence, and correspondence carries whatever a
// client chose to type. One July row held a TAXISnet username and password in
// plaintext until #126 redacted it, and the Gmail sync now masks credential
// shapes on the way in — but the posture here does not depend on either of
// those holding. Nothing about the table is readable by anon or
// authenticated, so the browser Supabase client cannot read it at all and the
// two views inherit that. Every read here is supabaseAdmin behind
// requireAdminAccess, and no snippet is ever exposed to a non-admin session.
//
// WHY THE ROWS COME BACK RAW.
//
// Same reasoning as reports.functions.ts: the views do the grouping, the pure
// functions in correspondence-shared.ts do the sorting, filtering and the
// stale/unanswered decisions, and both pages read the same definitions. This
// file is transport only and contains no arithmetic.

/** Every client code in this database is CLT####-XX. Uppercased before matching. */
const CLIENT_CODE = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .transform((v) => v.toUpperCase())
  .refine((v) => /^CLT[0-9]{4}-[A-Z]{2}$/.test(v), "Invalid client code");

/** The one source these functions deal in. */
const GMAIL_SOURCE = "gmail";

export type CorrespondenceOverview = {
  /** One row per case with correspondence, unsorted and unfiltered. */
  rows: CorrespondenceRow[];
  /**
   * The most recent run of the Gmail sync, whatever its outcome, or null if the
   * sync has never recorded one. Null is a real answer and the page says
   * "never refreshed" rather than leaving the line blank — a blank reads as
   * "fresh" and silent staleness is the thing this page exists to remove.
   */
  lastRun: SyncRunRow | null;
  /**
   * Whether a manual refresh is wired up at all. False until the n8n workflow
   * gains a webhook trigger and its URL and secret are set in Cloudflare, and
   * the page disables the button and says so rather than offering a control
   * that silently does nothing.
   */
  refreshConfigured: boolean;
  /**
   * Partner messages that could not be attached to exactly one case.
   *
   * Carried so the table can say so out loud. The matching rule refuses an
   * ambiguous CLTnnnn prefix rather than attaching the message to every client
   * that shares it, and an exclusion nobody can see is the same failure as the
   * double it replaced — a number that is quietly missing rather than quietly
   * doubled.
   */
  unmatched: UnmatchedPartnerMessage[];
};

export const getCorrespondenceOverview = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<CorrespondenceOverview> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const [rowsRes, runRes, unmatchedRes] = await Promise.all([
      supabaseAdmin.from("v_case_correspondence").select("*"),
      // Latest run of any outcome, not the latest success: a failed run must be
      // able to replace a stale success on the header, otherwise the page shows
      // an old green timestamp while the sync is broken.
      supabaseAdmin
        .from("sync_runs")
        .select("*")
        .eq("source", GMAIL_SOURCE)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("v_case_correspondence_unmatched")
        .select("*")
        .order("ts", { ascending: false }),
    ]);

    if (rowsRes.error) throw new Error(`Failed to load correspondence: ${rowsRes.error.message}`);
    // The freshness line is informative, not load-bearing. If sync_runs cannot
    // be read the table should still render; the page then shows the same
    // "never refreshed" state, which is the honest reading of "we don't know".
    const lastRun = runRes.error ? null : ((runRes.data as SyncRunRow | null) ?? null);

    // Same reasoning as lastRun: informative, not load-bearing. A table that
    // renders without its footnote beats a page that will not render at all.
    const unmatched = unmatchedRes.error
      ? []
      : ((unmatchedRes.data ?? []) as UnmatchedPartnerMessage[]);

    return {
      rows: (rowsRes.data ?? []) as CorrespondenceRow[],
      lastRun,
      refreshConfigured: isRefreshConfigured(),
      unmatched,
    };
  });

export type CaseCorrespondenceDetail = {
  /** Every message on this case, both parties, ordered oldest first. */
  messages: CaseMessageRow[];
  /**
   * The same six counts the consolidated table shows, so the detail page can
   * repeat them in its header without recomputing them from the message list
   * and risking a disagreement. Null when the case has no correspondence.
   */
  summary: CorrespondenceRow | null;
  /** Resolved from the client code so the header can name the case. */
  clientCode: string;
};

export const getCaseCorrespondence = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { clientCode: string }) => z.object({ clientCode: CLIENT_CODE }).parse(d))
  .handler(async ({ data, context }): Promise<CaseCorrespondenceDetail> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const [messagesRes, summaryRes] = await Promise.all([
      supabaseAdmin
        .from("v_case_messages")
        .select("*")
        .eq("client_code", data.clientCode)
        .order("ts", { ascending: true }),
      supabaseAdmin
        .from("v_case_correspondence")
        .select("*")
        .eq("client_code", data.clientCode)
        .maybeSingle(),
    ]);

    if (messagesRes.error) throw new Error(`Failed to load messages: ${messagesRes.error.message}`);
    if (summaryRes.error) throw new Error(`Failed to load counts: ${summaryRes.error.message}`);

    return {
      messages: (messagesRes.data ?? []) as CaseMessageRow[],
      summary: (summaryRes.data as CorrespondenceRow | null) ?? null,
      clientCode: data.clientCode,
    };
  });

// ---------------------------------------------------------------------------
// Refresh on demand
// ---------------------------------------------------------------------------
//
// THE PORTAL HALF OF A TWO-HALF FEATURE.
//
// The other half is n8n workflow uSQOKDb9YLNxiIIT ("20 · Sync Gmail to
// messages"), which now carries a POST webhook trigger — "Portal Refresh
// Requested", behind header auth on X-Mgt-Portal-Secret — alongside its
// 2-hourly schedule. Two things still gate the button, and both are outside
// this repository: the workflow is inactive and tagged `standby`, and a
// webhook only answers once the workflow is activated; and
// N8N_GMAIL_SYNC_URL / N8N_GMAIL_SYNC_SECRET are unset in Cloudflare. Until
// then requestGmailSync refuses cleanly and the page disables the button with
// the reason on it. Nothing here guesses a URL.
//
// THE CONTRACT WITH n8n, AS BUILT.
//
// This function creates the sync_runs row itself — through the
// claim_gmail_sync_slot RPC, which reserves it atomically — and then POSTs
// `run_id` to the webhook. n8n therefore UPDATES the row it is given rather
// than inserting its own, and inserts one only for its own scheduled runs. The
// row is created here rather than in n8n for two reasons the portal cannot get
// any other way: the rate limit below needs a durable record of manual attempts
// that survives a Worker isolate recycling, and the poll needs to know which
// row is this run rather than guessing at the newest one and racing the
// 2-hourly cron. On the n8n side, "Run Context" refuses a request whose
// `run_id` is not a uuid rather than inventing a row, because a run recorded
// under some other id would report success against nothing and leave the row
// this function is polling on 'running' for ever.
//
// The cooldown holds one manual run against another, not a manual run against
// the cron. If the two overlap, both read the same unlogged messages and the
// second insert hits messages_message_id_uq; n8n continues rather than dying,
// so the losing run closes as 'failed' with the duplicate-key error and the
// winning run still writes every message. Visible, and not lossy.
//
// A row left on 'running' is not swept up by anything. That is intentional: it
// records that a run was asked for and never reported back, which is exactly
// what a webhook that accepted the request and then died looks like. The page
// calls it out after STALLED_RUN_MS rather than showing it as in flight.

function isRefreshConfigured(): boolean {
  return !!process.env.N8N_GMAIL_SYNC_URL && !!process.env.N8N_GMAIL_SYNC_SECRET;
}

/** One manual run a minute. The sync reads the whole mailbox window each time. */
const MANUAL_COOLDOWN_SECONDS = 60;

export type RequestGmailSyncResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "not_configured" | "rate_limited" | "webhook_failed"; message: string };

export const requestGmailSync = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<RequestGmailSyncResult> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const webhookUrl = process.env.N8N_GMAIL_SYNC_URL;
    const secret = process.env.N8N_GMAIL_SYNC_SECRET;
    if (!webhookUrl || !secret) {
      console.error("[gmail-sync] N8N_GMAIL_SYNC_URL / N8N_GMAIL_SYNC_SECRET not configured");
      return {
        ok: false,
        reason: "not_configured",
        message:
          "Manual refresh is not wired up yet. The n8n Gmail sync needs a webhook trigger, and N8N_GMAIL_SYNC_URL and N8N_GMAIL_SYNC_SECRET need setting as Cloudflare secrets.",
      };
    }

    // Rate limit in the database rather than an in-memory map: Workers run many
    // isolates and an in-memory counter would let one click per isolate
    // through. Only manual runs count — the 2-hourly cron must not lock the
    // button out.
    //
    // One RPC rather than a read then an insert. Those were two statements and
    // therefore two snapshots: two requests arriving together both saw no
    // recent run, both inserted, and both fired the webhook, which is exactly
    // what the limit exists to stop. claim_gmail_sync_slot takes a
    // transaction-level advisory lock, so the second caller waits, sees the
    // first row, and is refused. A null return means refused.
    const claim = await supabaseAdmin.rpc("claim_gmail_sync_slot", {
      p_cooldown_seconds: MANUAL_COOLDOWN_SECONDS,
    });
    if (claim.error) throw new Error(`Failed to start refresh: ${claim.error.message}`);
    const runId = claim.data;
    if (!runId) {
      return {
        ok: false,
        reason: "rate_limited",
        message: "A manual refresh already ran in the last minute. Give it a moment.",
      };
    }

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mgt-Portal-Secret": secret,
        },
        body: JSON.stringify({ source: GMAIL_SOURCE, run_id: runId, triggered_by: "portal" }),
      });
      if (!res.ok) {
        const detail = `n8n responded ${res.status}`;
        console.error("[gmail-sync] webhook rejected", { status: res.status, runId });
        // Close the row out as failed rather than leaving it on 'running'. The
        // run demonstrably never started, and a stuck row would keep the button
        // locked for a minute for no reason.
        await supabaseAdmin
          .from("sync_runs")
          .update({ status: "failed", finished_at: new Date().toISOString(), error: detail })
          .eq("id", runId);
        return {
          ok: false,
          reason: "webhook_failed",
          message: `Could not start the sync: ${detail}`,
        };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[gmail-sync] webhook error", { error, runId });
      await supabaseAdmin
        .from("sync_runs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error: detail })
        .eq("id", runId);
      return { ok: false, reason: "webhook_failed", message: `Could not reach n8n: ${detail}` };
    }

    // n8n returns as soon as it has queued the run, so this is "accepted", not
    // "finished". The page polls getGmailSyncRun with this id.
    return { ok: true, runId };
  });

export const getGmailSyncRun = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { runId: string }) =>
    z.object({ runId: z.string().uuid("Invalid run id") }).parse(d),
  )
  .handler(async ({ data, context }): Promise<SyncRunRow | null> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const res = await supabaseAdmin
      .from("sync_runs")
      .select("*")
      .eq("id", data.runId)
      .maybeSingle();
    if (res.error) throw new Error(`Failed to read sync run: ${res.error.message}`);
    return (res.data as SyncRunRow | null) ?? null;
  });
