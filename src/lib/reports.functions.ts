import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireAdminAccess } from "./access-context.server";
import type { ReportDataQualityRow, ReportJobRow, ReportLeadRow } from "./reports-aggregate";

// Read side of /admin/reports. Three views in, three arrays out, no writes.
//
// WHY THIS RETURNS ROWS RATHER THAN TOTALS.
//
// It used to fetch the pre-aggregated views and hand the page finished numbers.
// That cannot survive a filter: a view takes no date-range parameter, so
// filtered and unfiltered would need separate paths and would eventually
// disagree. At this size — 49 jobs, 54 leads — the honest answer is to send the
// rows and aggregate once, in src/lib/reports-aggregate.ts, where every tab
// reads the same definition and the arithmetic can be unit-tested.
//
// One call rather than one per tab: ~103 rows behind a five minute staleTime is
// not worth splitting, and a single fetch keeps every tab consistent with the
// same snapshot.
//
// WHY THERE IS NO CASH FIGURE IN THIS FILE.
//
// Three sources in this database disagree about how much has been collected:
// payments.amount, clients.deposit, and the Google Sheet tracker. The cause is
// that payments has client_id but no job_id, so money cannot be attributed to
// the work it paid for. Jobs is therefore the reporting grain and the only
// money-shaped columns read anywhere are jobs.client_fee and
// jobs.accountant_fee, both of which have exactly one source. Nothing here
// reads clients.quote_amount, clients.deposit, clients.balance_due,
// clients.partner_fee or clients.lead_value, and nothing here reports
// collected, outstanding, receivables or cash.

export type AdminReportsData = {
  /** One row per job, from v_report_jobs. */
  jobs: ReportJobRow[];
  /** One row per client, from v_report_lead_lifecycle. */
  leads: ReportLeadRow[];
  /** Drift checks, unfiltered by nature — they describe the whole database. */
  dataQuality: ReportDataQualityRow[];
  /**
   * When lead stage history starts. The funnel can only see transitions logged
   * after this, so anything earlier under-counts, and the page says so rather
   * than presenting a partial funnel as complete.
   */
  leadHistoryFrom: string | null;
};

export const getAdminReports = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminReportsData> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const [jobsRes, leadsRes, qualityRes, historyRes] = await Promise.all([
      supabaseAdmin.from("v_report_jobs").select("*"),
      supabaseAdmin.from("v_report_lead_lifecycle").select("*"),
      supabaseAdmin.from("v_report_data_quality").select("*"),
      // The oldest stage transition on record. One row, ordered and limited, so
      // the page can state its own coverage instead of implying it has all of
      // history.
      supabaseAdmin
        .from("activity_events")
        .select("occurred_at")
        .eq("event_type", "lead_stage_changed")
        .order("occurred_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    for (const res of [jobsRes, leadsRes, qualityRes]) {
      if (res.error) throw new Error(res.error.message);
    }
    // The coverage note is nice to have, not load-bearing: if it fails the page
    // should still render, just without the date.
    const leadHistoryFrom = historyRes.error ? null : (historyRes.data?.occurred_at ?? null);

    return {
      jobs: (jobsRes.data ?? []) as ReportJobRow[],
      leads: (leadsRes.data ?? []) as ReportLeadRow[],
      dataQuality: (qualityRes.data ?? []) as ReportDataQualityRow[],
      leadHistoryFrom,
    };
  });
