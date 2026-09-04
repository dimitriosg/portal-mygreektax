import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { getAdminReports, type ReportTotals } from "@/lib/reports.functions";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/lib/badges";
import { ClientConcentrationChart, MonthlyRevenueChart } from "@/components/admin-reports-charts";
import { formatEuro, formatPct } from "@/lib/reports-format";

// Reports. Read-only, no cash.
//
// Every figure here is the value of work on the books, from jobs.client_fee and
// jobs.accountant_fee. Nothing on this page is money received, promised or owed,
// and nothing on it reads clients.quote_amount, clients.deposit,
// clients.balance_due or clients.partner_fee. Three sources in this database
// disagree about how much has been collected and payments has no job_id, so any
// cash number here would be confidently wrong — which is worse than absent. The
// data quality panel at the bottom is where that disagreement is made visible;
// it is the reason this page exists in this shape.

export const Route = createFileRoute("/admin/reports")({
  component: ReportsPage,
});

function ReportsPage() {
  const { user, loading, sessionReady, isAdmin } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", replace: true });
      return;
    }
    if (!sessionReady) return;
    if (!isAdmin) navigate({ to: "/dashboard", replace: true });
  }, [loading, sessionReady, user, isAdmin, navigate]);

  const fetchReports = useServerFn(getAdminReports);
  const reportsQ = useQuery({
    queryKey: ["admin", "reports"],
    queryFn: () => fetchReports(),
    enabled: !!isAdmin && sessionReady,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (isAuthSessionError(reportsQ.error)) navigate({ to: "/login", replace: true });
  }, [reportsQ.error, navigate]);

  if (loading || (!!user && !sessionReady)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground">Loading...</div>
    );
  }
  if (!isAdmin) return null;

  const data = reportsQ.data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to admin
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            The book by job, by status and by month. Read-only.
          </p>
        </div>
      </div>

      <Card className="border-dashed">
        <CardContent className="py-4 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">No cash figures on this page.</span>{" "}
          Everything below is the value of work on the books, taken from the fees on each job.
          Nothing here is money collected, outstanding or owed: three sources in this database
          disagree on what has been collected, and payments carry no job, so any cash number would
          be wrong with confidence. The data quality panel at the bottom is that disagreement,
          measured.
        </CardContent>
      </Card>

      {reportsQ.isLoading && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">Loading reports…</CardContent>
        </Card>
      )}

      {reportsQ.error && !isAuthSessionError(reportsQ.error) && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            Could not load reports: {getErrorMessage(reportsQ.error)}
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* A. Live book. Cancelled excluded — 7 of the 15 cancelled jobs have
              no accountant fee, so including them would inflate margin. */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Live book</h2>
              <p className="text-xs text-muted-foreground">Cancelled work excluded</p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Jobs" value={data.live.jobs.toLocaleString("en-GB")} />
              <Tile label="Revenue on the books" value={formatEuro(data.live.retail)} />
              <Tile label="Gross margin" value={formatEuro(data.live.grossMargin)} />
              <Tile
                label="Margin %"
                value={formatPct(data.live.marginPct)}
                note={
                  data.live.missingWholesale > 0
                    ? `${data.live.missingWholesale} job${data.live.missingWholesale === 1 ? "" : "s"} with no accountant fee — margin is overstated`
                    : undefined
                }
              />
            </div>
          </section>

          {/* B. Pipeline by status. */}
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Pipeline by status</h2>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Jobs</th>
                    <th className="px-3 py-2 text-right">Retail</th>
                    <th className="px-3 py-2 text-right">Wholesale</th>
                    <th className="px-3 py-2 text-right">Gross margin</th>
                    <th className="px-3 py-2 text-right">Margin %</th>
                    <th className="px-3 py-2">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pipeline.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                        No jobs yet.
                      </td>
                    </tr>
                  )}
                  {data.pipeline.map((row) => (
                    <tr key={row.status} className="border-t border-border hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.jobs}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatEuro(row.retail)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatEuro(row.wholesale)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatEuro(row.grossMargin)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatPct(row.marginPct)}
                      </td>
                      <td className="px-3 py-2">
                        {/* Margin on a row with no accountant fee is not high,
                            it is unknown. Say so where the number is read. */}
                        {row.missingWholesale > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            {row.missingWholesale} without an accountant fee
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {data.pipeline.length > 0 && <TotalsRow totals={data.all} />}
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Margin % on a row is its own gross margin over its own retail, never the average of
              the rows above it.
            </p>
          </section>

          {/* C. Charts. */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MonthlyRevenueChart rows={data.monthly} />
            <ClientConcentrationChart rows={data.concentration} />
          </section>

          {/* D. Data quality. Not a footnote. */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Data quality</h2>
              <p className="text-xs text-muted-foreground">
                A non-zero number here is a warning, not an error
              </p>
            </div>
            <Card>
              <CardContent className="divide-y divide-border py-0">
                {data.dataQuality.length === 0 && (
                  <div className="py-6 text-sm text-muted-foreground">No checks returned.</div>
                )}
                {data.dataQuality.map((check) => (
                  <div
                    key={check.checkKey}
                    className="flex items-center justify-between gap-4 py-3 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      {check.value !== 0 && (
                        <AlertTriangle
                          className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                          aria-hidden="true"
                        />
                      )}
                      <span className={check.value !== 0 ? "" : "text-muted-foreground"}>
                        {check.label}
                      </span>
                    </div>
                    <span
                      className={`shrink-0 tabular-nums font-semibold ${
                        check.value !== 0
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-muted-foreground"
                      }`}
                    >
                      {check.value.toLocaleString("en-GB")}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground">
              Payments cannot be attributed to a job until payments carries a job id. Until then
              this page reports work, not money.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function TotalsRow({ totals }: { totals: ReportTotals }) {
  return (
    <tfoot>
      <tr className="border-t-2 border-border bg-muted/40 font-semibold">
        <td className="px-3 py-2">All</td>
        <td className="px-3 py-2 text-right tabular-nums">{totals.jobs}</td>
        <td className="px-3 py-2 text-right tabular-nums">{formatEuro(totals.retail)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{formatEuro(totals.wholesale)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{formatEuro(totals.grossMargin)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{formatPct(totals.marginPct)}</td>
        <td className="px-3 py-2 text-xs font-normal text-muted-foreground">
          {totals.missingWholesale > 0
            ? `${totals.missingWholesale} without an accountant fee`
            : "—"}
        </td>
      </tr>
    </tfoot>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {note && (
          <div className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{note}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
