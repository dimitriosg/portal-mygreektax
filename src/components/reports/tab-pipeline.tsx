import { AlertTriangle } from "lucide-react";
import { StatusBadge } from "@/lib/badges";
import { formatEuro, formatPct } from "@/lib/reports-format";
import {
  concentrationFrom,
  liveTotals,
  monthlyFrom,
  pipelineFrom,
  totalsOf,
  type ReportJobRow,
  type ReportTotals,
} from "@/lib/reports-aggregate";
import { ClientConcentrationChart, MonthlyRevenueChart } from "@/components/admin-reports-charts";
import { Tile } from "./primitives";

// The book: what work exists, what it is worth, and how far the margin on it
// can be trusted. Every figure is the value of work on the books, from the fees
// on each job — never money received.

export function PipelineTab({ jobs }: { jobs: ReportJobRow[] }) {
  const pipeline = pipelineFrom(jobs);
  const live = liveTotals(pipeline);
  const all = totalsOf(pipeline);
  const monthly = monthlyFrom(jobs);
  const concentration = concentrationFrom(jobs);

  return (
    <div className="space-y-6">
      {/* Cancelled excluded: 7 of the 15 cancelled jobs have no accountant fee,
          so including them would inflate margin. */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Live book</h2>
          <p className="text-xs text-muted-foreground">Cancelled work excluded</p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Jobs" value={live.jobs.toLocaleString("en-GB")} />
          <Tile label="Revenue on the books" value={formatEuro(live.retail)} />
          <Tile label="Gross margin" value={formatEuro(live.grossMargin)} />
          <Tile
            label="Margin %"
            value={formatPct(live.marginPct)}
            note={
              live.missingWholesale > 0
                ? `${live.missingWholesale} job${live.missingWholesale === 1 ? "" : "s"} with no accountant fee — margin is overstated`
                : undefined
            }
          />
        </div>
      </section>

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
              {pipeline.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    No jobs match these filters.
                  </td>
                </tr>
              )}
              {pipeline.map((row) => (
                <tr key={row.status} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.jobs}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatEuro(row.retail)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatEuro(row.wholesale)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatEuro(row.grossMargin)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPct(row.marginPct)}</td>
                  <td className="px-3 py-2">
                    {/* Margin on a row with no accountant fee is not high, it is
                        unknown. Say so where the number is read. */}
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
            {pipeline.length > 0 && <TotalsRow totals={all} />}
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Margin % on a row is its own gross margin over its own retail, never the average of the
          rows above it.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MonthlyRevenueChart rows={monthly} />
        <ClientConcentrationChart rows={concentration} />
      </section>
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
