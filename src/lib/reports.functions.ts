import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireAdminAccess } from "./access-context.server";
import { JOB_STATUSES } from "./airtable-shared";

// Read side of /admin/reports. Four views in, four shapes out, no writes.
//
// WHY THERE IS NO CASH FIGURE IN THIS FILE.
//
// Three sources in this database disagree about how much has been collected:
// payments.amount, clients.deposit, and the Google Sheet tracker. The cause is
// that payments has client_id but no job_id, so money cannot be attributed to
// the work it paid for. Jobs is therefore the reporting grain and the only
// money-shaped columns read anywhere on this page are jobs.client_fee and
// jobs.accountant_fee, both of which have exactly one source. Nothing here
// reads clients.quote_amount, clients.deposit, clients.balance_due or
// clients.partner_fee, and nothing here reports collected, outstanding,
// receivables or cash. See the migration header for the full argument.
//
// The arithmetic lives in the views, not here. This file re-shapes and orders;
// the one exception is the live-book total, which is a sum over pipeline rows
// already computed by v_report_pipeline rather than a second query.

export const CANCELLED_JOB_STATUS = "Cancelled / NMF";

export type ReportPipelineRow = {
  status: string;
  jobs: number;
  retail: number;
  wholesale: number;
  grossMargin: number;
  /** Fraction, not percent. Null when the row has no retail to divide by. */
  marginPct: number | null;
  /** Jobs on this row with no accountant fee, so its margin is overstated. */
  missingWholesale: number;
};

export type ReportMonthlyRow = {
  /** First day of the month, ISO date. */
  month: string;
  jobs: number;
  retail: number;
  grossMargin: number;
  completedRetail: number;
  inProgressRetail: number;
  openRetail: number;
  cancelledRetail: number;
};

export type ReportConcentrationRow = {
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  jobs: number;
  retail: number;
  grossMargin: number;
  /** Fraction of live retail. */
  shareOfBook: number | null;
};

export type ReportDataQualityRow = {
  checkKey: string;
  label: string;
  value: number;
};

export type ReportTotals = {
  jobs: number;
  retail: number;
  wholesale: number;
  grossMargin: number;
  marginPct: number | null;
  missingWholesale: number;
};

export type AdminReportsData = {
  /** Cancelled excluded. The tiles at the top of the page. */
  live: ReportTotals;
  /** Every status including cancelled. The totals row of the pipeline table. */
  all: ReportTotals;
  pipeline: ReportPipelineRow[];
  monthly: ReportMonthlyRow[];
  concentration: ReportConcentrationRow[];
  dataQuality: ReportDataQualityRow[];
};

// Postgres sum() over no rows is null, and a nullable numeric column sums to
// null rather than 0. Every consumer below wants a number.
function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Pipeline order, not alphabetical and not by size: a status table is read as a
// workflow. JOB_STATUSES is the same order the rest of the admin uses. Anything
// not in that list is still shown, appended, so a new status never disappears.
const STATUS_RANK = new Map<string, number>(JOB_STATUSES.map((s, i) => [s as string, i]));
function statusRank(status: string): number {
  return STATUS_RANK.get(status) ?? JOB_STATUSES.length;
}

function totalsOf(rows: ReportPipelineRow[]): ReportTotals {
  const totals = rows.reduce(
    (acc, r) => ({
      jobs: acc.jobs + r.jobs,
      retail: acc.retail + r.retail,
      wholesale: acc.wholesale + r.wholesale,
      grossMargin: acc.grossMargin + r.grossMargin,
      missingWholesale: acc.missingWholesale + r.missingWholesale,
    }),
    { jobs: 0, retail: 0, wholesale: 0, grossMargin: 0, missingWholesale: 0 },
  );
  // Margin on a total is margin over retail, never the mean of the row
  // percentages — those weight a €69 job the same as a €3,141 one.
  return {
    ...totals,
    marginPct: totals.retail === 0 ? null : totals.grossMargin / totals.retail,
  };
}

export const getAdminReports = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminReportsData> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const [pipelineRes, monthlyRes, concentrationRes, qualityRes] = await Promise.all([
      supabaseAdmin.from("v_report_pipeline").select("*"),
      supabaseAdmin.from("v_report_monthly").select("*").order("month", { ascending: true }),
      supabaseAdmin
        .from("v_report_client_concentration")
        .select("*")
        .order("retail", { ascending: false, nullsFirst: false })
        .limit(10),
      supabaseAdmin.from("v_report_data_quality").select("*"),
    ]);

    for (const res of [pipelineRes, monthlyRes, concentrationRes, qualityRes]) {
      if (res.error) throw new Error(res.error.message);
    }

    const pipeline: ReportPipelineRow[] = (pipelineRes.data ?? [])
      .map((r) => ({
        status: r.status ?? "Unknown",
        jobs: num(r.jobs),
        retail: num(r.retail),
        wholesale: num(r.wholesale),
        grossMargin: num(r.gross_margin),
        marginPct: r.margin_pct ?? null,
        missingWholesale: num(r.missing_wholesale),
      }))
      .sort(
        (a, b) => statusRank(a.status) - statusRank(b.status) || a.status.localeCompare(b.status),
      );

    const monthly: ReportMonthlyRow[] = (monthlyRes.data ?? [])
      .filter((r): r is typeof r & { month: string } => !!r.month)
      .map((r) => ({
        month: r.month,
        jobs: num(r.jobs),
        retail: num(r.retail),
        grossMargin: num(r.gross_margin),
        completedRetail: num(r.completed_retail),
        inProgressRetail: num(r.in_progress_retail),
        openRetail: num(r.open_retail),
        cancelledRetail: num(r.cancelled_retail),
      }));

    const concentration: ReportConcentrationRow[] = (concentrationRes.data ?? []).map((r) => ({
      clientId: r.client_id ?? null,
      clientCode: r.client_code ?? null,
      clientName: r.client_name ?? null,
      jobs: num(r.jobs),
      retail: num(r.retail),
      grossMargin: num(r.gross_margin),
      shareOfBook: r.share_of_book ?? null,
    }));

    const dataQuality: ReportDataQualityRow[] = (qualityRes.data ?? []).map((r) => ({
      checkKey: r.check_key ?? "",
      label: r.label ?? "",
      value: num(r.value),
    }));

    return {
      live: totalsOf(pipeline.filter((r) => r.status !== CANCELLED_JOB_STATUS)),
      all: totalsOf(pipeline),
      pipeline,
      monthly,
      concentration,
      dataQuality,
    };
  });
