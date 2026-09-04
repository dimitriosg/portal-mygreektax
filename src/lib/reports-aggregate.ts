// Every number on /admin/reports, computed from row-level data.
//
// WHY THE ARITHMETIC MOVED OUT OF SQL.
//
// The views originally aggregated (v_report_pipeline, v_report_monthly,
// v_report_client_concentration) and the page read the totals directly. That
// stopped working the moment the page grew filters: a view cannot take a date
// range as a parameter, so a pre-aggregated view either ignores the filter or
// forces a second, unfiltered code path beside it. Two code paths for one set
// of numbers is how the three-sources-of-truth problem started, and this page
// exists because of that problem.
//
// So the page fetches rows — 49 jobs, 54 leads — and aggregates here. The part
// that actually mattered is unchanged: v_report_jobs remains the single
// definition of a job's retail, wholesale and margin. What moved is summing,
// which is trivial, now filter-aware, and unlike a view can be unit-tested.
// The aggregate views stay in the database for ad-hoc SQL; the page just no
// longer reads them.
//
// NO CASH HERE EITHER. Retail, wholesale and margin come from jobs.client_fee
// and jobs.accountant_fee, which have one source. Nothing in this file reads
// clients.quote_amount, deposit, balance_due, partner_fee — or lead_value,
// which belongs to the same drifted family and is not carried by the views.

import { JOB_STATUSES } from "./airtable-shared";

export const CANCELLED_JOB_STATUS = "Cancelled / NMF";

/** The stage a lead is on once the deposit has landed — see the migration. */
export const PAID_STAGE = "Active";

// ---------------------------------------------------------------------------
// Row shapes, as the views return them
// ---------------------------------------------------------------------------

export type ReportJobRow = {
  id: string | null;
  job_code: string | null;
  status: string | null;
  client_id: string | null;
  client_code: string | null;
  client_name: string | null;
  service_name: string | null;
  service_code: string | null;
  retail: number | null;
  wholesale: number | null;
  gross_margin: number | null;
  margin_pct: number | null;
  month: string | null;
  wholesale_missing: boolean | null;
  is_cancelled: boolean | null;
  date_sent: string | null;
  sla_deadline: string | null;
  paid_at: string | null;
  created_at: string | null;
};

export type ReportLeadRow = {
  client_id: string | null;
  client_code: string | null;
  client_name: string | null;
  source: string | null;
  current_stage: string | null;
  current_status: string | null;
  lead_created_at: string | null;
  quoted_at: string | null;
  active_at: string | null;
  delivered_at: string | null;
  complete_at: string | null;
  lost_at: string | null;
  parked_at: string | null;
  last_activity_at: string | null;
  next_action: string | null;
  next_action_date: string | null;
};

export type ReportDataQualityRow = {
  check_key: string | null;
  label: string | null;
  value: number | null;
};

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type ReportFilters = {
  /** ISO date, inclusive. */
  from?: string;
  /** ISO date, inclusive to the end of that day. */
  to?: string;
  /** Job statuses to keep. Empty means all. */
  status?: string[];
  /** Lead stages to keep. Empty means all. */
  stage?: string[];
};

export const EMPTY_FILTERS: ReportFilters = {};

export function hasActiveFilters(f: ReportFilters): boolean {
  return !!(f.from || f.to || f.status?.length || f.stage?.length);
}

// A job's date is the day it was sent, falling back to when it was created —
// the same rule v_report_jobs uses to derive `month`, kept identical here so
// the date filter and the monthly chart can never disagree about which month a
// job belongs to.
function jobDate(job: ReportJobRow): string | null {
  return job.date_sent ?? job.created_at ?? null;
}

// Compared as strings. Both sides are ISO-8601, which sorts lexicographically
// in date order, so this avoids constructing a Date per row per keystroke and
// sidesteps the timezone question entirely: a date filter means calendar days
// as recorded, not days as resolved in the viewer's timezone.
function withinRange(value: string | null, from?: string, to?: string): boolean {
  if (!value) return !from && !to; // undated rows survive only an empty range
  const day = value.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

export function filterJobs(jobs: ReportJobRow[], f: ReportFilters): ReportJobRow[] {
  return jobs.filter((j) => {
    if (!withinRange(jobDate(j), f.from, f.to)) return false;
    if (f.status?.length && !f.status.includes(j.status ?? "")) return false;
    return true;
  });
}

export function filterLeads(leads: ReportLeadRow[], f: ReportFilters): ReportLeadRow[] {
  return leads.filter((l) => {
    if (!withinRange(l.lead_created_at, f.from, f.to)) return false;
    if (f.stage?.length && !f.stage.includes(l.current_stage ?? "")) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Postgres sums to null over no rows and over a nullable column; every
// consumer below wants a number.
function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Margin over retail. Never the mean of row percentages. */
function marginPct(grossMargin: number, retail: number): number | null {
  return retail === 0 ? null : grossMargin / retail;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type ReportPipelineRow = {
  status: string;
  jobs: number;
  retail: number;
  wholesale: number;
  grossMargin: number;
  marginPct: number | null;
  missingWholesale: number;
};

export type ReportTotals = {
  jobs: number;
  retail: number;
  wholesale: number;
  grossMargin: number;
  marginPct: number | null;
  missingWholesale: number;
};

// Pipeline order, not alphabetical and not by size: a status table is read as a
// workflow. Anything not in JOB_STATUSES is still shown, appended, so a new
// status never disappears.
const STATUS_RANK = new Map<string, number>(JOB_STATUSES.map((s, i) => [s as string, i]));
function statusRank(status: string): number {
  return STATUS_RANK.get(status) ?? JOB_STATUSES.length;
}

export function pipelineFrom(jobs: ReportJobRow[]): ReportPipelineRow[] {
  const byStatus = new Map<string, ReportPipelineRow>();
  for (const j of jobs) {
    const status = j.status ?? "Unknown";
    const row = byStatus.get(status) ?? {
      status,
      jobs: 0,
      retail: 0,
      wholesale: 0,
      grossMargin: 0,
      marginPct: null,
      missingWholesale: 0,
    };
    row.jobs += 1;
    row.retail += num(j.retail);
    row.wholesale += num(j.wholesale);
    row.grossMargin += num(j.gross_margin);
    if (j.wholesale_missing) row.missingWholesale += 1;
    byStatus.set(status, row);
  }
  return [...byStatus.values()]
    .map((r) => ({ ...r, marginPct: marginPct(r.grossMargin, r.retail) }))
    .sort(
      (a, b) => statusRank(a.status) - statusRank(b.status) || a.status.localeCompare(b.status),
    );
}

export function totalsOf(rows: ReportPipelineRow[]): ReportTotals {
  const t = rows.reduce(
    (acc, r) => ({
      jobs: acc.jobs + r.jobs,
      retail: acc.retail + r.retail,
      wholesale: acc.wholesale + r.wholesale,
      grossMargin: acc.grossMargin + r.grossMargin,
      missingWholesale: acc.missingWholesale + r.missingWholesale,
    }),
    { jobs: 0, retail: 0, wholesale: 0, grossMargin: 0, missingWholesale: 0 },
  );
  return { ...t, marginPct: marginPct(t.grossMargin, t.retail) };
}

export function liveTotals(rows: ReportPipelineRow[]): ReportTotals {
  return totalsOf(rows.filter((r) => r.status !== CANCELLED_JOB_STATUS));
}

// ---------------------------------------------------------------------------
// Monthly
// ---------------------------------------------------------------------------

export type ReportMonthlyRow = {
  month: string;
  jobs: number;
  retail: number;
  grossMargin: number;
  completedRetail: number;
  inProgressRetail: number;
  openRetail: number;
  cancelledRetail: number;
};

export function monthlyFrom(jobs: ReportJobRow[]): ReportMonthlyRow[] {
  const byMonth = new Map<string, ReportMonthlyRow>();
  for (const j of jobs) {
    if (!j.month) continue;
    const month = j.month.slice(0, 10);
    const row = byMonth.get(month) ?? {
      month,
      jobs: 0,
      retail: 0,
      grossMargin: 0,
      completedRetail: 0,
      inProgressRetail: 0,
      openRetail: 0,
      cancelledRetail: 0,
    };
    const retail = num(j.retail);
    if (j.is_cancelled) {
      row.cancelledRetail += retail;
    } else {
      row.jobs += 1;
      row.retail += retail;
      row.grossMargin += num(j.gross_margin);
      // Open is defined by subtraction, not by listing statuses, so Delivered,
      // Invoiced and the legacy Sent cannot fall through into no segment. Same
      // rule as v_report_monthly; the three segments must always sum to retail.
      if (j.status === "Completed") row.completedRetail += retail;
      else if (j.status === "In Progress") row.inProgressRetail += retail;
      else row.openRetail += retail;
    }
    byMonth.set(month, row);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// ---------------------------------------------------------------------------
// Client concentration
// ---------------------------------------------------------------------------

export type ReportConcentrationRow = {
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  jobs: number;
  retail: number;
  grossMargin: number;
  shareOfBook: number | null;
};

export function concentrationFrom(jobs: ReportJobRow[], limit = 10): ReportConcentrationRow[] {
  const live = jobs.filter((j) => !j.is_cancelled);
  const totalRetail = live.reduce((sum, j) => sum + num(j.retail), 0);
  const byClient = new Map<string, ReportConcentrationRow>();
  for (const j of live) {
    const key = j.client_id ?? `unknown:${j.client_name ?? ""}`;
    const row = byClient.get(key) ?? {
      clientId: j.client_id,
      clientCode: j.client_code,
      clientName: j.client_name,
      jobs: 0,
      retail: 0,
      grossMargin: 0,
      shareOfBook: null,
    };
    row.jobs += 1;
    row.retail += num(j.retail);
    row.grossMargin += num(j.gross_margin);
    byClient.set(key, row);
  }
  return [...byClient.values()]
    .map((r) => ({ ...r, shareOfBook: totalRetail === 0 ? null : r.retail / totalRetail }))
    .sort((a, b) => b.retail - a.retail)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export type FunnelStep = {
  key: "lead" | "quoted" | "active" | "delivered" | "complete";
  label: string;
  /** Leads that ever reached this step, not leads sitting on it now. */
  count: number;
  /** Fraction of the previous step that got here. Null on the first step. */
  conversion: number | null;
  /** Leads that reached the previous step but not this one. */
  dropOff: number;
};

// Milestones are "ever reached", taken from the first transition into that
// stage. Deliberately not the client's current stage: stages move backwards in
// this data, and a lead that completed and reopened has still been quoted and
// still been paid. "Where leads are now" is a different question — that is
// stageDistribution below.
export function funnelFrom(leads: ReportLeadRow[]): FunnelStep[] {
  const reached = {
    lead: leads.length,
    quoted: leads.filter((l) => l.quoted_at).length,
    active: leads.filter((l) => l.active_at).length,
    delivered: leads.filter((l) => l.delivered_at).length,
    complete: leads.filter((l) => l.complete_at).length,
  };
  const spec: { key: FunnelStep["key"]; label: string }[] = [
    { key: "lead", label: "Leads" },
    { key: "quoted", label: "Quoted" },
    { key: "active", label: "Deposit paid" },
    { key: "delivered", label: "Delivered" },
    { key: "complete", label: "Complete" },
  ];
  return spec.map((s, i) => {
    const count = reached[s.key];
    const prev = i === 0 ? null : reached[spec[i - 1].key];
    return {
      ...s,
      count,
      conversion: prev == null ? null : prev === 0 ? null : count / prev,
      dropOff: prev == null ? 0 : Math.max(0, prev - count),
    };
  });
}

/** Where leads sit right now, by current stage — not the same as the funnel. */
export function stageDistribution(leads: ReportLeadRow[]): { stage: string; count: number }[] {
  const byStage = new Map<string, number>();
  for (const l of leads) {
    const stage = l.current_stage ?? "(none)";
    byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
  }
  return [...byStage.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Lead sources
// ---------------------------------------------------------------------------

export const SOURCE_NOT_RECORDED = "(not recorded)";

export type ReportSourceRow = {
  source: string;
  leads: number;
  quoted: number;
  active: number;
  /** Lead → deposit paid. Deliberately not lead → complete; see the component. */
  conversion: number | null;
};

export function sourcesFrom(leads: ReportLeadRow[]): ReportSourceRow[] {
  const bySource = new Map<string, ReportSourceRow>();
  for (const l of leads) {
    // Leads with no source recorded get their own row rather than being
    // dropped. They are the largest group, and hiding them would flatter the
    // conversion rate of every source that is recorded.
    const source = l.source?.trim() || SOURCE_NOT_RECORDED;
    const row = bySource.get(source) ?? {
      source,
      leads: 0,
      quoted: 0,
      active: 0,
      conversion: null,
    };
    row.leads += 1;
    if (l.quoted_at) row.quoted += 1;
    if (l.active_at) row.active += 1;
    bySource.set(source, row);
  }
  return [...bySource.values()]
    .map((r) => ({ ...r, conversion: r.leads === 0 ? null : r.active / r.leads }))
    .sort((a, b) => b.leads - a.leads);
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

export type WatchlistJob = {
  id: string | null;
  jobCode: string | null;
  clientName: string | null;
  status: string | null;
  slaDeadline: string | null;
  daysOverdue: number;
};

export type WatchlistLead = {
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  stage: string | null;
  since: string | null;
  daysSince: number;
};

export type ReportWatchlist = {
  slaOverdue: WatchlistJob[];
  slaDueSoon: WatchlistJob[];
  quotedNotPaid: WatchlistLead[];
  goneQuiet: WatchlistLead[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: string | null, now: Date): number {
  if (!from) return 0;
  const t = new Date(from).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.floor((now.getTime() - t) / DAY_MS);
}

function isOpen(job: ReportJobRow): boolean {
  return !job.is_cancelled && job.status !== "Completed";
}

/**
 * The "what do I chase today" list. `now` is injected rather than read from the
 * clock so this stays testable and so a render cannot disagree with itself
 * midway through.
 */
export function watchlistFrom(
  jobs: ReportJobRow[],
  leads: ReportLeadRow[],
  now: Date = new Date(),
  quietDays = 30,
  dueSoonDays = 7,
): ReportWatchlist {
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + dueSoonDays * DAY_MS).toISOString().slice(0, 10);

  const openWithSla = jobs.filter((j) => isOpen(j) && j.sla_deadline);
  const toJob = (j: ReportJobRow): WatchlistJob => ({
    id: j.id,
    jobCode: j.job_code,
    clientName: j.client_name,
    status: j.status,
    slaDeadline: j.sla_deadline,
    daysOverdue: daysBetween(j.sla_deadline, now),
  });

  return {
    slaOverdue: openWithSla
      .filter((j) => (j.sla_deadline as string) < today)
      .map(toJob)
      .sort((a, b) => b.daysOverdue - a.daysOverdue),
    slaDueSoon: openWithSla
      .filter((j) => (j.sla_deadline as string) >= today && (j.sla_deadline as string) <= soon)
      .map(toJob)
      .sort((a, b) => (a.slaDeadline ?? "").localeCompare(b.slaDeadline ?? "")),
    // Quoted, never reached the deposit stage, and not already closed out.
    // Parked and Lost are decisions already taken, not things to chase.
    quotedNotPaid: leads
      .filter(
        (l) =>
          l.quoted_at && !l.active_at && l.current_stage !== "Parked" && l.current_stage !== "Lost",
      )
      .map((l) => ({
        clientId: l.client_id,
        clientCode: l.client_code,
        clientName: l.client_name,
        stage: l.current_stage,
        since: l.quoted_at,
        daysSince: daysBetween(l.quoted_at, now),
      }))
      .sort((a, b) => b.daysSince - a.daysSince),
    goneQuiet: leads
      .filter((l) => {
        if (!["Potential", "Quoted", "Active"].includes(l.current_stage ?? "")) return false;
        const last = l.last_activity_at ?? l.lead_created_at;
        return daysBetween(last, now) >= quietDays;
      })
      .map((l) => {
        const last = l.last_activity_at ?? l.lead_created_at;
        return {
          clientId: l.client_id,
          clientCode: l.client_code,
          clientName: l.client_name,
          stage: l.current_stage,
          since: last,
          daysSince: daysBetween(last, now),
        };
      })
      .sort((a, b) => b.daysSince - a.daysSince),
  };
}

export function watchlistCount(w: ReportWatchlist): number {
  return w.slaOverdue.length + w.slaDueSoon.length + w.quotedNotPaid.length + w.goneQuiet.length;
}
