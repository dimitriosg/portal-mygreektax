import { AlertTriangle } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import {
  watchlistCount,
  watchlistFrom,
  type ReportDataQualityRow,
  type ReportJobRow,
  type ReportLeadRow,
  type ReportWatchlist,
} from "@/lib/reports-aggregate";

// Two things that both mean "needs attention": work running late or going
// quiet, and numbers that disagree with each other.

export function QualityTab({
  jobs,
  leads,
  dataQuality,
}: {
  jobs: ReportJobRow[];
  leads: ReportLeadRow[];
  dataQuality: ReportDataQualityRow[];
}) {
  const watchlist = watchlistFrom(jobs, leads);
  const total = watchlistCount(watchlist);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Needs attention</h2>
          <p className="text-xs text-muted-foreground">
            {total === 0 ? "Nothing waiting" : `${total} item${total === 1 ? "" : "s"}`}
          </p>
        </div>
        {total === 0 ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              Nothing overdue, nothing quoted and unanswered, nothing gone quiet. This section is
              empty when the pipeline is healthy.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <JobList
              title="Past SLA"
              hint="Open work whose deadline has gone."
              jobs={watchlist.slaOverdue}
              tone="warn"
              suffix={(j) => `${j.daysOverdue}d over`}
            />
            <JobList
              title="Due within 7 days"
              hint="Open work with a deadline coming up."
              jobs={watchlist.slaDueSoon}
              suffix={(j) => formatDate(j.slaDeadline)}
            />
            <LeadList
              title="Quoted, no deposit"
              hint="Quote sent, nothing back, and not yet parked or lost."
              leads={watchlist.quotedNotPaid}
              suffix={(l) => `${l.daysSince}d since quote`}
            />
            <LeadList
              title="Gone quiet"
              hint="Open leads with no recorded activity for 30 days or more."
              leads={watchlist.goneQuiet}
              suffix={(l) => `${l.daysSince}d quiet`}
            />
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Data quality</h2>
          <p className="text-xs text-muted-foreground">
            A non-zero number here is a warning, not an error
          </p>
        </div>
        <Card>
          <CardContent className="divide-y divide-border py-0">
            {dataQuality.length === 0 && (
              <div className="py-6 text-sm text-muted-foreground">No checks returned.</div>
            )}
            {dataQuality.map((check) => {
              const value = check.value ?? 0;
              return (
                <div
                  key={check.check_key ?? check.label ?? ""}
                  className="flex items-center justify-between gap-4 py-3 text-sm"
                >
                  <div className="flex items-center gap-2">
                    {value !== 0 && (
                      <AlertTriangle
                        className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                        aria-hidden="true"
                      />
                    )}
                    <span className={value !== 0 ? "" : "text-muted-foreground"}>
                      {check.label}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 tabular-nums font-semibold ${
                      value !== 0 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"
                    }`}
                  >
                    {value.toLocaleString("en-GB")}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">
          These checks describe the whole database and deliberately ignore the filters above — drift
          does not stop existing because a date range excludes it.
        </p>
      </section>
    </div>
  );
}

function ListCard({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
          <span className="text-sm font-semibold tabular-nums">{count}</span>
        </div>
        <p className="mb-2 mt-1 text-xs text-muted-foreground">{hint}</p>
        {count === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>{children}</tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function JobList({
  title,
  hint,
  jobs,
  suffix,
  tone,
}: {
  title: string;
  hint: string;
  jobs: ReportWatchlist["slaOverdue"];
  suffix: (job: ReportWatchlist["slaOverdue"][number]) => string;
  tone?: "warn";
}) {
  return (
    <ListCard title={title} hint={hint} count={jobs.length}>
      {jobs.map((j) => (
        <tr key={j.id ?? j.jobCode} className="border-t border-border first:border-t-0">
          <td className="py-2">
            {j.id ? (
              <Link
                to="/jobs/$jobId"
                params={{ jobId: j.id }}
                className="font-medium hover:underline"
              >
                {j.jobCode ?? j.id}
              </Link>
            ) : (
              <span className="font-medium">{j.jobCode ?? "—"}</span>
            )}
            <div className="text-xs text-muted-foreground">{j.clientName ?? "—"}</div>
          </td>
          <td
            className={`py-2 text-right text-xs tabular-nums ${
              tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"
            }`}
          >
            {suffix(j)}
          </td>
        </tr>
      ))}
    </ListCard>
  );
}

function LeadList({
  title,
  hint,
  leads,
  suffix,
}: {
  title: string;
  hint: string;
  leads: ReportWatchlist["quotedNotPaid"];
  suffix: (lead: ReportWatchlist["quotedNotPaid"][number]) => string;
}) {
  return (
    <ListCard title={title} hint={hint} count={leads.length}>
      {leads.map((l) => (
        <tr key={l.clientId ?? l.clientCode} className="border-t border-border first:border-t-0">
          <td className="py-2">
            <span className="font-medium">{l.clientName ?? l.clientCode ?? "—"}</span>
            <div className="text-xs text-muted-foreground">{l.stage ?? "—"}</div>
          </td>
          <td className="py-2 text-right text-xs tabular-nums text-muted-foreground">
            {suffix(l)}
          </td>
        </tr>
      ))}
    </ListCard>
  );
}
