import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { z } from "zod";
import { getAdminReports } from "@/lib/reports.functions";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { filterJobs, filterLeads, type ReportFilters } from "@/lib/reports-aggregate";
import { ReportsFilterBar } from "@/components/reports/filter-bar";
import { PipelineTab } from "@/components/reports/tab-pipeline";
import { FunnelTab } from "@/components/reports/tab-funnel";
import { SourcesTab } from "@/components/reports/tab-sources";
import { QualityTab } from "@/components/reports/tab-quality";

// Reports. Read-only, no cash.
//
// Every figure here is the value of work on the books, from jobs.client_fee and
// jobs.accountant_fee, or a count of leads. Nothing on this page is money
// received, promised or owed, and nothing on it reads clients.quote_amount,
// clients.deposit, clients.balance_due, clients.partner_fee or
// clients.lead_value. Three sources in this database disagree about how much
// has been collected and payments has no job_id, so any cash number here would
// be confidently wrong — which is worse than absent.
//
// This route is a shell: auth, one query, filter state, and which tab is
// showing. The tabs themselves live in src/components/reports/ and all
// arithmetic lives in src/lib/reports-aggregate.ts, so no number is defined in
// more than one place.

const TABS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "funnel", label: "Funnel" },
  { key: "sources", label: "Sources" },
  { key: "quality", label: "Data quality" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// .catch() on every field rather than .optional() alone: a hand-edited or stale
// URL should land on the default view, never throw the route into an error
// boundary. A report link is the kind of thing people paste into chat and edit.
const searchSchema = z.object({
  // Optional, not defaulted: the router treats a required output field as a
  // required link param, and `<Link to="/admin/reports">` should keep working
  // with no search at all. The default is applied at read time instead.
  tab: z.enum(["pipeline", "funnel", "sources", "quality"]).optional().catch(undefined),
  from: z.string().regex(ISO_DAY).optional().catch(undefined),
  to: z.string().regex(ISO_DAY).optional().catch(undefined),
  /** Comma-separated job statuses. */
  status: z.string().optional().catch(undefined),
  /** Comma-separated lead stages. */
  stage: z.string().optional().catch(undefined),
});

type ReportsSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/admin/reports")({
  // Typed as Record<string, unknown> rather than letting the schema drive the
  // input type, matching src/routes/appendix.tsx. Otherwise the router infers
  // every param as required and `<Link to="/admin/reports">` on the admin
  // overview stops compiling for want of a search object.
  validateSearch: (search: Record<string, unknown>): ReportsSearch => searchSchema.parse(search),
  component: ReportsPage,
});

/** HH:mm in the viewer's own timezone — this is "how stale is this", not a date. */
function formatTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function splitList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function joinList(values?: string[]): string | undefined {
  return values?.length ? values.join(",") : undefined;
}

function ReportsPage() {
  const { user, loading, sessionReady, isAdmin } = useAuth();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const tab: TabKey = search.tab ?? "pipeline";

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", replace: true });
      return;
    }
    if (!sessionReady) return;
    if (!isAdmin) navigate({ to: "/dashboard", replace: true });
  }, [loading, sessionReady, user, isAdmin, navigate]);

  const fetchReports = useServerFn(getAdminReports);
  const reportsQ = useQuery({
    queryKey: ["admin", "reports"],
    queryFn: () => fetchReports(),
    enabled: !!isAdmin && sessionReady,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (isAuthSessionError(reportsQ.error)) navigate({ to: "/login", replace: true });
  }, [reportsQ.error, navigate]);

  const filters: ReportFilters = useMemo(
    () => ({
      from: search.from,
      to: search.to,
      status: splitList(search.status),
      stage: splitList(search.stage),
    }),
    [search.from, search.to, search.status, search.stage],
  );

  // replace: true so dragging a date range does not bury the back button under
  // one history entry per click.
  function setSearch(next: Partial<ReportsSearch>) {
    navigate({ to: "/admin/reports", search: { ...search, ...next }, replace: true });
  }

  function setFilters(next: ReportFilters) {
    setSearch({
      from: next.from,
      to: next.to,
      status: joinList(next.status),
      stage: joinList(next.stage),
    });
  }

  const data = reportsQ.data;

  const jobs = useMemo(() => filterJobs(data?.jobs ?? [], filters), [data?.jobs, filters]);
  const leads = useMemo(() => filterLeads(data?.leads ?? [], filters), [data?.leads, filters]);

  // Facet options come from the data actually present, so a status that no job
  // has stops offering a filter that would return nothing.
  const statusOptions = useMemo(
    () =>
      [...new Set((data?.jobs ?? []).map((j) => j.status).filter((s): s is string => !!s))].sort(),
    [data?.jobs],
  );
  const stageOptions = useMemo(
    () =>
      [
        ...new Set((data?.leads ?? []).map((l) => l.current_stage).filter((s): s is string => !!s)),
      ].sort(),
    [data?.leads],
  );

  const unlinkable =
    data?.dataQuality.find((c) => c.check_key === "lead_history_unlinkable")?.value ?? 0;

  if (loading || (!!user && !sessionReady)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground">Loading...</div>
    );
  }
  if (!isAdmin) return null;

  const facetMode = tab === "pipeline" ? "jobs" : tab === "quality" ? "none" : "leads";

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to admin
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            The book, the closing cycle, and where the leads come from. Read-only.
          </p>
        </div>
        {/* The query holds data for five minutes, which is right for a report
            you leave open — and wrong for the moment you have just changed
            something and want to see it. This refetches in place rather than
            reloading the page, so the tab and filters survive. */}
        <div className="flex items-center gap-2">
          {data && (
            <span className="text-xs text-muted-foreground" title="When this data was fetched">
              {reportsQ.isFetching
                ? "Refreshing…"
                : `Updated ${formatTime(reportsQ.dataUpdatedAt)}`}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => reportsQ.refetch()}
            disabled={reportsQ.isFetching}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", reportsQ.isFetching && "animate-spin")}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>
      </div>

      <Card className="border-dashed">
        <CardContent className="py-4 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">No cash figures on this page.</span>{" "}
          Everything below is the value of work on the books, or a count of leads. Nothing here is
          money collected, outstanding or owed: three sources in this database disagree on what has
          been collected, and payments carry no job, so any cash number would be wrong with
          confidence.
        </CardContent>
      </Card>

      {/* Segmented control rather than ui/tabs.tsx, which nothing in this repo
          uses. Same shape as the board/list toggle on the leads page. */}
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-1 text-sm">
        {TABS.map((tab_) => (
          <button
            key={tab_.key}
            type="button"
            onClick={() => setSearch({ tab: tab_.key })}
            aria-current={tab === tab_.key ? "page" : undefined}
            className={cn(
              "rounded px-3 py-1 transition-colors",
              tab === tab_.key
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab_.label}
          </button>
        ))}
      </div>

      <ReportsFilterBar
        filters={filters}
        onChange={setFilters}
        mode={facetMode}
        facetOptions={facetMode === "jobs" ? statusOptions : stageOptions}
      />

      {reportsQ.isLoading && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">Loading reports…</CardContent>
        </Card>
      )}

      {reportsQ.error && !isAuthSessionError(reportsQ.error) && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            Could not load reports: {getErrorMessage(reportsQ.error)}
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {tab === "pipeline" && <PipelineTab jobs={jobs} />}
          {tab === "funnel" && (
            <FunnelTab
              leads={leads}
              leadHistoryFrom={data.leadHistoryFrom}
              unlinkableEvents={unlinkable}
            />
          )}
          {tab === "sources" && <SourcesTab leads={leads} />}
          {tab === "quality" && (
            <QualityTab jobs={jobs} leads={leads} dataQuality={data.dataQuality} />
          )}
        </>
      )}
    </div>
  );
}
