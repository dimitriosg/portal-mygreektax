import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReportConcentrationRow, ReportMonthlyRow } from "@/lib/reports.functions";
import { Card, CardContent } from "@/components/ui/card";
import { formatEuro, formatPct } from "@/lib/reports-format";

// Palette checked for colourblind separation and contrast, assigned in fixed
// order and never cycled: a series keeps its colour when the data changes.
// Cancelled work is deliberately not in this set — it is muted, because it is
// context for the live book rather than part of it.
const SERIES = {
  completed: "#2a78d6",
  inProgress: "#eb6834",
  open: "#1baf7a",
} as const;
const CANCELLED = "var(--muted-foreground)";

/** 2026-08-01 → "Aug 26". */
function monthLabel(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-GB", { month: "short" })} ${String(d.getFullYear()).slice(2)}`;
}

const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" } as const;

const TOOLTIP_STYLE = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--card-foreground)",
} as const;

type MonthlyDatum = {
  label: string;
  Completed: number;
  "In Progress": number;
  Open: number;
  Cancelled: number;
};

export function MonthlyRevenueChart({ rows }: { rows: ReportMonthlyRow[] }) {
  const data: MonthlyDatum[] = rows.map((r) => ({
    label: monthLabel(r.month),
    Completed: r.completedRetail,
    "In Progress": r.inProgressRetail,
    Open: r.openRetail,
    Cancelled: r.cancelledRetail,
  }));

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
          Revenue on the books by month
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Month comes from the date the job was sent, falling back to when it was created. Cancelled
          work sits beside the live stack, not inside it.
        </p>
        {data.length === 0 ? (
          <EmptyPlot />
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} stroke="var(--border)" tickLine={false} />
                <YAxis
                  tick={AXIS}
                  stroke="var(--border)"
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tickFormatter={(v: number) => formatEuro(v)}
                />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number, name: string) => [formatEuro(v), name]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {/* A 1px surface-coloured stroke is the gap between stacked
                    segments; without it two adjacent fills read as one block. */}
                <Bar
                  dataKey="Completed"
                  stackId="live"
                  fill={SERIES.completed}
                  stroke="var(--card)"
                />
                <Bar
                  dataKey="In Progress"
                  stackId="live"
                  fill={SERIES.inProgress}
                  stroke="var(--card)"
                />
                <Bar
                  dataKey="Open"
                  stackId="live"
                  fill={SERIES.open}
                  stroke="var(--card)"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="Cancelled"
                  stackId="cancelled"
                  fill={CANCELLED}
                  fillOpacity={0.35}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ClientConcentrationChart({ rows }: { rows: ReportConcentrationRow[] }) {
  // The bar's label is built here rather than in a LabelList formatter: that
  // formatter only receives the value, and several clients share a retail
  // figure, so looking the row back up by value would print the wrong share.
  const data = rows.map((r) => ({
    label: r.clientName ?? r.clientCode ?? "Unknown client",
    retail: r.retail,
    labelText:
      r.shareOfBook == null
        ? formatEuro(r.retail)
        : `${formatEuro(r.retail)} · ${formatPct(r.shareOfBook)}`,
  }));

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
          Client concentration — top 10
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Share is of live retail, cancelled work excluded. It is not a share of anything collected.
        </p>
        {data.length === 0 ? (
          <EmptyPlot />
        ) : (
          <div className="w-full" style={{ height: Math.max(200, data.length * 30 + 24) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                layout="vertical"
                margin={{ top: 4, right: 96, left: 0, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={AXIS}
                  stroke="var(--border)"
                  tickLine={false}
                  axisLine={false}
                  width={150}
                />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [formatEuro(v), "On the books"]}
                />
                {/* One series, so no legend: the card title names it. Values are
                    direct-labelled instead, which is also the relief the palette
                    check asks for on the lighter fills. */}
                <Bar dataKey="retail" fill={SERIES.completed} radius={[0, 4, 4, 0]} barSize={16}>
                  <LabelList
                    dataKey="labelText"
                    position="right"
                    style={{ fontSize: 11, fill: "var(--foreground)" }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyPlot() {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      Nothing to plot yet.
    </div>
  );
}
