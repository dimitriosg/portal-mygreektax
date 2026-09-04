import { formatPct } from "@/lib/reports-format";
import { sourcesFrom, SOURCE_NOT_RECORDED, type ReportLeadRow } from "@/lib/reports-aggregate";
import { LeadSourceChart } from "@/components/admin-reports-charts";
import { CoverageNote } from "./primitives";

// Which channels actually convert, as opposed to which bring volume.

export function SourcesTab({ leads }: { leads: ReportLeadRow[] }) {
  const rows = sourcesFrom(leads);
  const notRecorded = rows.find((r) => r.source === SOURCE_NOT_RECORDED);
  const total = leads.length;

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
              {rows.map((row) => (
                <tr key={row.source} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2">
                    {row.source === SOURCE_NOT_RECORDED ? (
                      <span className="text-muted-foreground">{row.source}</span>
                    ) : (
                      row.source
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.leads}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.quoted}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.active}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">
                    {formatPct(row.conversion)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
