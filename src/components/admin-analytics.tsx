import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { getPlausibleStats } from "@/lib/analytics.functions";
import { getErrorMessage } from "@/lib/auth-errors";
import { Card, CardContent } from "@/components/ui/card";

function fmtDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function AdminAnalytics({ enabled = true }: { enabled?: boolean }) {
  const fetchStats = useServerFn(getPlausibleStats);
  const q = useQuery({
    queryKey: ["admin", "plausible-stats"],
    queryFn: () => fetchStats(),
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Analytics</h2>
        <p className="text-xs text-muted-foreground">
          Powered by Plausible · last 30 days
        </p>
      </div>

      {q.isLoading && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Loading analytics…
          </CardContent>
        </Card>
      )}

      {q.error && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            Could not load analytics: {getErrorMessage(q.error)}
          </CardContent>
        </Card>
      )}

      {q.data && q.data.error && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            {q.data.error}
          </CardContent>
        </Card>
      )}

      {q.data && !q.data.error && q.data.aggregate && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Visitors" value={q.data.aggregate.visitors.toLocaleString()} />
            <Kpi label="Page views" value={q.data.aggregate.pageviews.toLocaleString()} />
            <Kpi label="Bounce rate" value={`${Math.round(q.data.aggregate.bounceRate)}%`} />
            <Kpi label="Avg. visit" value={fmtDuration(q.data.aggregate.visitDuration)} />
          </div>

          <Card>
            <CardContent className="py-4">
              <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                Visitors per day
              </div>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={q.data.timeseries} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="visitorsFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(d: string) => d.slice(5)}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--background))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="visitors"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      fill="url(#visitorsFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2">
            <BreakdownTable
              title="Top pages (last 7d)"
              rows={(q.data.topPages ?? []).map((p) => ({ label: p.page || "/", value: p.visitors }))}
              empty="No page views yet."
            />
            <BreakdownTable
              title="Top events (last 7d)"
              rows={(q.data.topEvents ?? []).map((e) => ({ label: e.name, value: e.visitors }))}
              empty="No custom events yet."
            />
          </div>
        </>
      )}
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

function BreakdownTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { label: string; value: number }[];
  empty: string;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">{empty}</div>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center justify-between gap-3">
                <span className="truncate text-foreground">{r.label}</span>
                <span className="tabular-nums text-muted-foreground">{r.value.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
