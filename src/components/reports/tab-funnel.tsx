import { formatDate } from "@/lib/utils";
import { formatPct } from "@/lib/reports-format";
import { funnelFrom, stageDistribution, type ReportLeadRow } from "@/lib/reports-aggregate";
import { FunnelChart } from "@/components/admin-reports-charts";
import { Card, CardContent } from "@/components/ui/card";
import { CoverageNote, Tile } from "./primitives";

// The closing cycle. Reconstructed from the stage-change history in
// activity_events, which is why the coverage note matters: the log starts
// partway through the business's life, and a partial funnel read as a complete
// one is exactly the kind of confidently-wrong number this page exists to avoid.

export function FunnelTab({
  leads,
  leadHistoryFrom,
  unlinkableEvents,
}: {
  leads: ReportLeadRow[];
  leadHistoryFrom: string | null;
  unlinkableEvents: number;
}) {
  const steps = funnelFrom(leads);
  const stages = stageDistribution(leads);
  const quoted = steps.find((s) => s.key === "quoted");
  const paid = steps.find((s) => s.key === "active");

  // Quoted → paid is the number worth a tile: it is the one step that is a
  // decision by the client rather than by us.
  const winRate = quoted && paid && quoted.count > 0 ? paid.count / quoted.count : null;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Closing cycle</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Leads" value={String(steps[0]?.count ?? 0)} />
          <Tile label="Quoted" value={String(quoted?.count ?? 0)} />
          <Tile label="Deposit paid" value={String(paid?.count ?? 0)} />
          <Tile label="Quote → paid" value={winRate == null ? "—" : formatPct(winRate)} />
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FunnelChart steps={steps} />

        <Card>
          <CardContent className="py-4">
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Where leads are now
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              Current stage, which is a different question from the funnel above — that counts every
              stage a lead has ever reached.
            </p>
            {stages.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No leads match.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {stages.map((s) => (
                    <tr key={s.stage} className="border-t border-border first:border-t-0">
                      <td className="py-2">{s.stage}</td>
                      <td className="py-2 text-right tabular-nums font-medium">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-1">
        <CoverageNote>
          The deposit step is the move into stage <strong>Active</strong>, which the database gates
          on a deposit arriving — a better signal than the payment records, which carry no job
          reference.
        </CoverageNote>
        <CoverageNote>
          Stage history begins{" "}
          {leadHistoryFrom ? formatDate(leadHistoryFrom) : "when the activity log was introduced"}.
          Anything that happened before then is not in these counts, so early leads under-report.
          {unlinkableEvents > 0 && (
            <>
              {" "}
              A further {unlinkableEvents} stage change
              {unlinkableEvents === 1 ? "" : "s"} cannot be linked to a client and{" "}
              {unlinkableEvents === 1 ? "is" : "are"} excluded — see Data quality.
            </>
          )}
        </CoverageNote>
      </section>
    </div>
  );
}
