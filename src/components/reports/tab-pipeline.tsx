import { Fragment, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { StatusBadge } from "@/lib/badges";
import { cn, formatDate } from "@/lib/utils";
import { formatEuro, formatPct } from "@/lib/reports-format";
import {
  CANCELLED_JOB_STATUS,
  concentrationFrom,
  liveTotals,
  monthlyFrom,
  pipelineFrom,
  type ReportJobRow,
  type ReportPipelineRow,
  type ReportTotals,
} from "@/lib/reports-aggregate";
import { ClientConcentrationChart, MonthlyRevenueChart } from "@/components/admin-reports-charts";
import { Tile } from "./primitives";

// The book: what work exists, what it is worth, and how far the margin on it
// can be trusted. Every figure is the value of work on the books, from the fees
// on each job — never money received.
//
// Cancelled work is not part of the report. It sits below the totals as a
// footnote, excluded from every figure above it and carrying no warning badge:
// a cancelled job with no accountant fee is not a data problem to chase, it is
// a job nobody is going to do.

type SortKey = "job" | "client" | "service" | "retail" | "wholesale" | "margin" | "sent" | "sla";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "job", label: "Job" },
  { key: "client", label: "Client" },
  { key: "service", label: "Service" },
  { key: "retail", label: "Retail", numeric: true },
  { key: "wholesale", label: "Wholesale", numeric: true },
  { key: "margin", label: "Margin", numeric: true },
  { key: "sent", label: "Sent" },
  { key: "sla", label: "SLA" },
];

function sortValue(job: ReportJobRow, key: SortKey): string | number | null {
  switch (key) {
    case "job":
      return job.job_code;
    case "client":
      return job.client_name;
    case "service":
      return job.service_name;
    case "retail":
      return job.retail;
    case "wholesale":
      return job.wholesale;
    case "margin":
      return job.gross_margin;
    case "sent":
      return job.date_sent;
    case "sla":
      return job.sla_deadline;
  }
}

// Nulls sort last whichever direction you pick: a job with no SLA is not the
// most urgent one, and flipping the arrow should not make it so.
function compareJobs(a: ReportJobRow, b: ReportJobRow, key: SortKey, dir: SortDir): number {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  const sign = dir === "asc" ? 1 : -1;
  if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
  // numeric:true so JB9 sorts before JB10 rather than after it.
  return (
    String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * sign
  );
}

export function PipelineTab({ jobs }: { jobs: ReportJobRow[] }) {
  const pipeline = pipelineFrom(jobs);
  const live = liveTotals(pipeline);
  const liveRows = pipeline.filter((r) => r.status !== CANCELLED_JOB_STATUS);
  const cancelled = pipeline.find((r) => r.status === CANCELLED_JOB_STATUS) ?? null;
  const monthly = monthlyFrom(jobs);
  const concentration = concentrationFrom(jobs);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "retail", dir: "desc" });

  const jobsByStatus = useMemo(() => {
    const byStatus = new Map<string, ReportJobRow[]>();
    for (const job of jobs) {
      const key = job.status ?? "Unknown";
      const list = byStatus.get(key);
      if (list) list.push(job);
      else byStatus.set(key, [job]);
    }
    return byStatus;
  }, [jobs]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : // First click on a money column shows the biggest first, which is what
          // you want when you open a row to investigate. Text starts A–Z.
          { key, dir: ["retail", "wholesale", "margin"].includes(key) ? "desc" : "asc" },
    );
  }

  return (
    <div className="space-y-6">
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
              {liveRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    No live jobs match these filters.
                  </td>
                </tr>
              )}
              {liveRows.map((row) => {
                const isOpen = expanded === row.status;
                const rowJobs = jobsByStatus.get(row.status) ?? [];
                const domId = `jobs-${row.status.replace(/\W+/g, "-")}`;
                return (
                  <Fragment key={row.status}>
                    <tr
                      className={cn(
                        "border-t border-border hover:bg-muted/30",
                        isOpen && "bg-muted/30",
                      )}
                    >
                      <td className="px-3 py-2">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : row.status)}
                          aria-expanded={isOpen}
                          aria-controls={domId}
                          title={isOpen ? "Hide these jobs" : "Show these jobs"}
                          className="inline-flex items-center gap-1 rounded px-1 tabular-nums hover:bg-muted hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {row.jobs}
                        </button>
                      </td>
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
                        {/* Margin on a live row with no accountant fee is not
                            high, it is unknown. Say so where the number is read. */}
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
                    {isOpen && (
                      <tr className="border-t border-border bg-muted/10">
                        <td colSpan={7} className="px-3 py-3">
                          <JobBreakdown id={domId} jobs={rowJobs} sort={sort} onSort={toggleSort} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              {liveRows.length > 0 && <TotalsRow totals={live} />}
              {cancelled && <CancelledRow row={cancelled} />}
            </tfoot>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Click a job count to see the jobs behind it, then a column header to sort them, then a job
          code to open it. Margin % on a row is its own gross margin over its own retail, never the
          average of the rows above it.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MonthlyRevenueChart rows={monthly} />
        <ClientConcentrationChart rows={concentration} />
      </section>
    </div>
  );
}

/** The jobs behind one status row. Every job code links to the job itself. */
function JobBreakdown({
  id,
  jobs,
  sort,
  onSort,
}: {
  id: string;
  jobs: ReportJobRow[];
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
}) {
  const sorted = useMemo(
    () => [...jobs].sort((a, b) => compareJobs(a, b, sort.key, sort.dir)),
    [jobs, sort],
  );

  if (jobs.length === 0) {
    return (
      <p id={id} className="text-xs text-muted-foreground">
        No jobs to show.
      </p>
    );
  }
  return (
    <div id={id} className="overflow-x-auto rounded-md border border-border bg-background">
      <table className="w-full min-w-[680px] text-xs">
        <thead className="bg-muted/40 text-left">
          <tr>
            {COLUMNS.map((col) => {
              const active = sort.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={cn("px-3 py-1.5", col.numeric && "text-right")}
                >
                  <button
                    type="button"
                    onClick={() => onSort(col.key)}
                    className={cn(
                      "inline-flex items-center gap-0.5 rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      col.numeric && "flex-row-reverse",
                      active && "font-semibold text-foreground",
                    )}
                  >
                    {col.label}
                    {/* Only the active column shows an arrow; one per table is
                        the whole point of a sort indicator. */}
                    {active &&
                      (sort.dir === "asc" ? (
                        <ChevronUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-3 w-3" aria-hidden="true" />
                      ))}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((job) => (
            <tr key={job.id ?? job.job_code} className="border-t border-border hover:bg-muted/30">
              <td className="px-3 py-1.5">
                {job.id ? (
                  <Link
                    to="/jobs/$jobId"
                    params={{ jobId: job.id }}
                    className="font-medium hover:underline"
                  >
                    {job.job_code ?? job.id}
                  </Link>
                ) : (
                  <span className="font-medium">{job.job_code ?? "—"}</span>
                )}
              </td>
              <td className="px-3 py-1.5">{job.client_name ?? "—"}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{job.service_name ?? "—"}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatEuro(job.retail)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {/* An unset accountant fee is unknown cost, not zero cost, and
                    this is the row where that distinction is checkable. */}
                {job.wholesale_missing ? (
                  <span
                    className="text-amber-700 dark:text-amber-300"
                    title="No accountant fee set"
                  >
                    not set
                  </span>
                ) : (
                  formatEuro(job.wholesale)
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatEuro(job.gross_margin)}
              </td>
              <td className="px-3 py-1.5 text-muted-foreground">{formatDate(job.date_sent)}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{formatDate(job.sla_deadline)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TotalsRow({ totals }: { totals: ReportTotals }) {
  return (
    <tr className="border-t-2 border-border bg-muted/40 font-semibold">
      <td className="px-3 py-2">Live book</td>
      <td className="px-3 py-2 text-right tabular-nums">{totals.jobs}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatEuro(totals.retail)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatEuro(totals.wholesale)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatEuro(totals.grossMargin)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatPct(totals.marginPct)}</td>
      <td className="px-3 py-2 text-xs font-normal text-muted-foreground">
        {totals.missingWholesale > 0 ? `${totals.missingWholesale} without an accountant fee` : "—"}
      </td>
    </tr>
  );
}

/**
 * Cancelled work, below the line and counted in nothing above it. Muted, and
 * with no missing-fee warning: an unset accountant fee on a job nobody will do
 * is not drift worth chasing, and flagging it trains you to ignore the badge
 * where it does matter.
 */
function CancelledRow({ row }: { row: ReportPipelineRow }) {
  return (
    <tr className="border-t border-border text-muted-foreground">
      <td className="px-3 py-2">
        <span className="text-xs">Cancelled / NMF — excluded</span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{row.jobs}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatEuro(row.retail)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatEuro(row.wholesale)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatEuro(row.grossMargin)}</td>
      <td className="px-3 py-2 text-right tabular-nums">—</td>
      <td className="px-3 py-2 text-xs">Not counted in any figure above</td>
    </tr>
  );
}
