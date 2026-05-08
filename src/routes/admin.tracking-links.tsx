import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { listTrackingLinks, getTrackingLinkOpens } from "@/lib/jobs.functions";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/lib/badges";
import { formatDate, formatDateTime } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/tracking-links")({
  component: TrackingLinksPage,
});

type SortKey = "last_opened" | "opens" | "created";

function TrackingLinksPage() {
  const { user, loading, isAdmin } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!user) navigate({ to: "/login" });
    else if (!isAdmin) navigate({ to: "/dashboard" });
  }, [loading, user, isAdmin, navigate]);

  const fetchLinks = useServerFn(listTrackingLinks);
  const fetchOpens = useServerFn(getTrackingLinkOpens);

  const linksQ = useQuery({
    queryKey: ["tracking-links"],
    queryFn: () => fetchLinks(),
    enabled: !!isAdmin,
  });

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("last_opened");
  const [openToken, setOpenToken] = useState<string | null>(null);

  const opensQ = useQuery({
    queryKey: ["tracking-link-opens", openToken],
    queryFn: () => fetchOpens({ data: { token: openToken! } }),
    enabled: !!openToken,
  });

  const filtered = useMemo(() => {
    const list = linksQ.data?.links ?? [];
    const q = search.trim().toLowerCase();
    const f = q
      ? list.filter(
          (l) =>
            l.jobCode?.toLowerCase().includes(q) ||
            l.clientName?.toLowerCase().includes(q) ||
            l.client_email?.toLowerCase().includes(q),
        )
      : list;
    const sorted = [...f].sort((a, b) => {
      if (sort === "opens") return b.open_count - a.open_count;
      if (sort === "created")
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      // last_opened (nulls last)
      const at = a.last_opened_at ? new Date(a.last_opened_at).getTime() : 0;
      const bt = b.last_opened_at ? new Date(b.last_opened_at).getTime() : 0;
      return bt - at;
    });
    return sorted;
  }, [linksQ.data, search, sort]);

  const totals = useMemo(() => {
    const list = linksQ.data?.links ?? [];
    return {
      links: list.length,
      opens: list.reduce((s, l) => s + l.open_count, 0),
      opened: list.filter((l) => l.open_count > 0).length,
    };
  }, [linksQ.data]);

  if (!isAdmin) return null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            to="/admin"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to admin
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Tracking links</h1>
          <p className="text-sm text-muted-foreground">
            All client tracking links and how often customers opened them.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Links generated" value={totals.links} />
        <Stat label="Links opened" value={totals.opened} />
        <Stat label="Total opens" value={totals.opens} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by job code, client name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded border border-input bg-background px-2 py-2 text-sm"
        >
          <option value="last_opened">Sort: Last open</option>
          <option value="opens">Sort: Most opens</option>
          <option value="created">Sort: Newest</option>
        </select>
      </div>

      <p className="text-xs text-muted-foreground">
        Customer IPs and approximate location are stored for fraud and abuse review.
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2">Job</th>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2 text-right">Opens</th>
              <th className="px-3 py-2">Last open</th>
              <th className="px-3 py-2">Last location</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {linksQ.isLoading && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!linksQ.isLoading && filtered.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">No tracking links yet.</td></tr>
            )}
            {filtered.map((l) => {
              const trackUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/track/${l.token}`;
              return (
                <tr key={l.token} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <Link
                      to="/jobs/$jobId"
                      params={{ jobId: l.airtable_job_id }}
                      className="font-medium hover:underline"
                    >
                      {l.jobCode ?? l.airtable_job_id}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div>{l.clientName ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{l.client_email}</div>
                  </td>
                  <td className="px-3 py-2">
                    {l.status ? <StatusBadge status={l.status} /> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDate(l.created_at)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDate(l.expires_at)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{l.open_count}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {l.last_opened_at ? formatDateTime(l.last_opened_at) : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{l.last_country ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard?.writeText(trackUrl);
                        toast.success("Link copied");
                      }}
                    >
                      Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setOpenToken(l.token)}
                      disabled={l.open_count === 0}
                    >
                      Details
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openToken} onOpenChange={(v) => !v && setOpenToken(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Open log</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {opensQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {opensQ.data && opensQ.data.opens.length === 0 && (
              <p className="text-sm text-muted-foreground">No opens recorded.</p>
            )}
            {opensQ.data && opensQ.data.opens.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-2 py-1.5">When</th>
                      <th className="px-2 py-1.5">Country</th>
                      <th className="px-2 py-1.5">City</th>
                      <th className="px-2 py-1.5">Device</th>
                      <th className="px-2 py-1.5">Browser</th>
                      <th className="px-2 py-1.5">OS</th>
                      <th className="px-2 py-1.5">IP</th>
                      <th className="px-2 py-1.5">Referrer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opensQ.data.opens.map((o) => (
                      <tr key={o.id} className="border-t border-border align-top">
                        <td className="px-2 py-1.5 whitespace-nowrap">{formatDateTime(o.opened_at)}</td>
                        <td className="px-2 py-1.5">{o.country ?? "—"}</td>
                        <td className="px-2 py-1.5">{o.city ?? "—"}</td>
                        <td className="px-2 py-1.5">{o.device ?? "—"}</td>
                        <td className="px-2 py-1.5">{o.browser ?? "—"}</td>
                        <td className="px-2 py-1.5">{o.os ?? "—"}</td>
                        <td className="px-2 py-1.5 font-mono text-[11px]">{o.ip ?? "—"}</td>
                        <td className="px-2 py-1.5 max-w-[160px] truncate" title={o.referrer ?? ""}>
                          {o.referrer ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}