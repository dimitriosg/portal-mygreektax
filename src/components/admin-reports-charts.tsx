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
import type {
  FunnelStep,
  ReportConcentrationRow,
  ReportMonthlyRow,
  ReportSourceRow,
} from "@/lib/reports-aggregate";
import { Card, CardContent } from "@/components/ui/card";
import { formatEuro, formatPct } from "@/lib/reports-format";

// Palette checked for colourblind separation and contrast, assigned in fixed
// order and never cycled: a series keeps its colour when the data changes.
// Cancelled work has no colour here because it is no longer plotted at all.
const SERIES = {
  completed: "#2a78d6",
  inProgress: "#eb6834",
  open: "#1baf7a",
  // Margin is not another slice of revenue, it is a different measure of the
  // same month, so it gets its own hue and its own bar rather than a segment.
  margin: "#8E44AD",
} as const;

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
  Margin: number;
};

export function MonthlyRevenueChart({ rows }: { rows: ReportMonthlyRow[] }) {
  const data: MonthlyDatum[] = rows.map((r) => ({
    label: monthLabel(r.month),
    Completed: r.completedRetail,
    "In Progress": r.inProgressRetail,
    Open: r.openRetail,
    Margin: r.grossMargin,
  }));

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
          Revenue on the books by month
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Month comes from the date the job was sent, falling back to when it was created. The stack
          is revenue by status; the purple bar beside it is the gross margin inside that revenue.
          Cancelled work is excluded entirely.
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
                {/* Its own stackId, so it stands beside the revenue stack
                    rather than adding to it — margin is a part of that revenue,
                    and stacking it would double-count the month. */}
                <Bar dataKey="Margin" stackId="margin" fill={SERIES.margin} radius={[4, 4, 0, 0]} />
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

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

/**
 * The closing cycle, as a horizontal bar per step. One series, so one hue and
 * no legend: the steps are stages of the same quantity shrinking, not four
 * different things, and colouring them separately would imply otherwise.
 */
/**
 * Draws a step's label inside its own bar, and gives up when the bar is too
 * short to hold it. A label that overflows a short bar collides with the next
 * one and reads as belonging to the wrong step. The tooltip carries the same
 * text, so nothing is lost by staying silent here.
 */
function InsideLabel(props: {
  x?: string | number;
  y?: string | number;
  width?: string | number;
  height?: string | number;
  value?: string | number;
}) {
  const num = (v: string | number | undefined) => (typeof v === "number" ? v : Number(v ?? 0));
  const x = num(props.x);
  const y = num(props.y);
  const width = num(props.width);
  const height = num(props.height);
  const text = String(props.value ?? "");
  // Roughly 6px per character at 11px, plus padding either side.
  const needed = text.length * 6 + 20;
  if (!text || width < needed) return null;
  return (
    <text
      x={x + width - 10}
      y={y + height / 2}
      textAnchor="end"
      dominantBaseline="central"
      style={{ fontSize: 11, fill: "#fff", fontWeight: 500 }}
    >
      {text}
    </text>
  );
}

export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const data = steps.map((s) => ({
    label: s.label,
    count: s.count,
    // Built here rather than in a LabelList formatter, which receives only the
    // value — and two steps can legitimately share a count.
    labelText:
      s.conversion == null
        ? `${s.count} leads`
        : `${s.count}  ·  ${formatPct(s.conversion)} of previous`,
  }));

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
          Closing cycle
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Leads that ever reached each step, not leads sitting on it now — a lead that completed and
          reopened has still been quoted and still paid.
        </p>
        {data.length === 0 ? (
          <EmptyPlot />
        ) : (
          <div className="w-full" style={{ height: Math.max(200, data.length * 44 + 24) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                layout="vertical"
                margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
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
                  width={110}
                />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                  contentStyle={TOOLTIP_STYLE}
                  // The tooltip is the fallback for a bar too short to hold its
                  // own label, so it repeats the conversion, not just the count.
                  formatter={(
                    _v: number,
                    _n: string,
                    item: { payload?: { labelText?: string } },
                  ) => [item?.payload?.labelText ?? "", "Reached"]}
                />
                <Bar dataKey="count" fill={SERIES.completed} radius={[0, 4, 4, 0]} barSize={20}>
                  <LabelList dataKey="labelText" content={InsideLabel} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Lead sources
// ---------------------------------------------------------------------------

/** Volume by source. Conversion is the table's job — a bar cannot show both. */
export function LeadSourceChart({ rows }: { rows: ReportSourceRow[] }) {
  const data = rows.map((r) => ({
    label: r.source,
    leads: r.leads,
    labelText: r.conversion == null ? `${r.leads}` : `${r.leads}  ·  ${formatPct(r.conversion)}`,
  }));

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
          Where leads come from
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Lead count, labelled with the share that went on to pay a deposit.
        </p>
        {data.length === 0 ? (
          <EmptyPlot />
        ) : (
          <div className="w-full" style={{ height: Math.max(200, data.length * 32 + 24) }}>
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
                  width={170}
                />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [`${v}`, "Leads"]}
                />
                <Bar dataKey="leads" fill={SERIES.open} radius={[0, 4, 4, 0]} barSize={16}>
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
