import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn, formatDate } from "@/lib/utils";
import { formatPct } from "@/lib/reports-format";
import { sourcesFrom, SOURCE_NOT_RECORDED, type ReportLeadRow } from "@/lib/reports-aggregate";
import { LeadSourceChart } from "@/components/admin-reports-charts";
import { CoverageNote } from "./primitives";

// Which channels actually convert, as opposed to which bring volume — and,
// because a rate you cannot open is a rate you have to take on trust, which
// leads are behind each one.

export function SourcesTab({ leads }: { leads: ReportLeadRow[] }) {
  const rows = sourcesFrom(leads);
  const notRecorded = rows.find((r) => r.source === SOURCE_NOT_RECORDED);
  const total = leads.length;

  const [expanded, setExpanded] = useState<string | null>(null);

  // Grouped on the same rule sourcesFrom uses, so an expanded row can never
  // disagree with the count on the row that opened it.
  const leadsBySource = useMemo(() => {
    const bySource = new Map<string, ReportLeadRow[]>();
    for (const lead of leads) {
      const key = lead.source?.trim() || SOURCE_NOT_RECORDED;
      const list = bySource.get(key);
      if (list) list.push(lead);
      else bySource.set(key, [lead]);
    }
    for (const list of bySource.values()) {
      // Newest first: the recent ones are the ones still worth acting on.
      list.sort((a, b) => (b.lead_created_at ?? "").localeCompare(a.lead_created_at ?? ""));
    }
    return bySource;
  }, [leads]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Lead sources</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2 text-right">Leads</th>
                <th className="px-3 py-2 text-right">Quoted</th>
                <th className="px-3 py-2 text-right">Deposit paid</th>
                <th className="px-3 py-2 text-right">Lead → paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    No leads match these filters.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const isOpen = expanded === row.source;
                const domId = `leads-${row.source.replace(/\W+/g, "-")}`;
                return (
                  <Fragment key={row.source}>
                    <tr
                      className={cn(
                        "border-t border-border hover:bg-muted/30",
                        isOpen && "bg-muted/30",
                      )}
                    >
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : row.source)}
                          aria-expanded={isOpen}
                          aria-controls={domId}
                          title={isOpen ? "Hide these leads" : "Show these leads"}
                          className={cn(
                            "inline-flex items-center gap-1 rounded px-1 text-left hover:bg-muted hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            row.source === SOURCE_NOT_RECORDED && "text-muted-foreground",
                          )}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          )}
                          {row.source}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.leads}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.quoted}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.active}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
                        {formatPct(row.conversion)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-border bg-muted/10">
                        <td colSpan={5} className="px-3 py-3">
                          <LeadBreakdown id={domId} leads={leadsBySource.get(row.source) ?? []} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Click a source to see the leads it brought in.
        </p>
      </section>

      <section>
        <LeadSourceChart rows={rows} />
      </section>

      <section className="space-y-1">
        <CoverageNote>
          Conversion is measured to <strong>deposit paid</strong>, not to completion, on purpose.
          Completion correlates with age: the newest channels have barely any completed work yet,
          and ranking them on it would read as a failure when it is only recency.
        </CoverageNote>
        {notRecorded && total > 0 && (
          <CoverageNote>
            {notRecorded.leads} of {total} leads have no source recorded. They are shown as their
            own row rather than dropped — leaving them out would flatter every rate above.
          </CoverageNote>
        )}
      </section>
    </div>
  );
}

/**
 * The leads behind one source. There is no per-lead route in this app — leads
 * are edited in a dialog on /leads — so this shows enough to identify each one
 * by eye and links to that page rather than pretending to deep-link.
 */
function LeadBreakdown({ id, leads }: { id: string; leads: ReportLeadRow[] }) {
  if (leads.length === 0) {
    return (
      <p id={id} className="text-xs text-muted-foreground">
        No leads to show.
      </p>
    );
  }
  return (
    <div id={id} className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border bg-background">
        <table className="w-full min-w-[620px] text-xs">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-1.5">Lead</th>
              <th className="px-3 py-1.5">Stage</th>
              <th className="px-3 py-1.5">Created</th>
              <th className="px-3 py-1.5">Quoted</th>
              <th className="px-3 py-1.5">Deposit paid</th>
              <th className="px-3 py-1.5">Complete</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr
                key={lead.client_id ?? lead.client_code}
                className="border-t border-border hover:bg-muted/30"
              >
                <td className="px-3 py-1.5">
                  <span className="font-medium">{lead.client_name ?? "—"}</span>
                  {lead.client_code && (
                    <div className="text-muted-foreground">{lead.client_code}</div>
                  )}
                </td>
                <td className="px-3 py-1.5">{lead.current_stage ?? "—"}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {formatDate(lead.lead_created_at)}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{formatDate(lead.quoted_at)}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{formatDate(lead.active_at)}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {formatDate(lead.complete_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Link to="/leads" className="text-xs text-muted-foreground hover:text-foreground">
        Open the leads page →
      </Link>
    </div>
  );
}
