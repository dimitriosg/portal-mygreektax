import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  listJobs,
  listAccountants,
  getJobOrder,
  saveJobOrder,
  clearJobOrder,
} from "@/lib/jobs.functions";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import {
  describeSupabaseToken,
  getSupabaseProjectHost,
} from "@/integrations/supabase/auth-diagnostics";
import { createErrorReferenceId, debugError, debugLog, isDebugEnabled } from "@/lib/debug";
import { formatDate } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NextActionBadge, StatusBadge, TierBadge } from "@/lib/badges";
import { getJobStatusSortOrder, JOB_STATUSES } from "@/lib/airtable-shared";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ChevronDown } from "lucide-react";

// Briefly keep the session-expired UI visible before routing back to sign-in.
const AUTH_ERROR_REDIRECT_DELAY_MS = 1500;
const ACTIVE_PARTNER_WORK_STATUSES = new Set([
  "Pending",
  "Paid",
  "In Progress",
  "Delivered",
  "Invoiced",
]);

function compareJobCodeAsc(a?: string, b?: string) {
  const left = (a ?? "").trim();
  const right = (b ?? "").trim();
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function isRequireSupabaseAuthMessage(error: unknown) {
  return getErrorMessage(error).startsWith("Unauthorized:");
}

export const Route = createFileRoute("/dashboard")({
  component: Dashboard,
  errorComponent: DashboardErrorComponent,
});

function DashboardErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const errorReferenceId = useMemo(() => createErrorReferenceId("dashboard-route"), []);
  const showErrorDetails = isDebugEnabled();
  const errorDetails =
    error instanceof Error ? (error.stack ?? error.message) : getErrorMessage(error);

  debugError("[dashboard-route-error]", {
    referenceId: errorReferenceId,
    message: getErrorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error ? error.cause : undefined,
    pathname,
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Dashboard didn&apos;t load</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Something went wrong while loading the dashboard. You can retry or return to sign in.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Reference ID: {errorReferenceId}</p>
      {showErrorDetails && (
        <details className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-left text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">Error details</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words">{errorDetails}</pre>
        </details>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" onClick={() => navigate({ to: "/login", replace: true })}>
          Go to sign in
        </Button>
      </div>
    </div>
  );
}

function Dashboard() {
  const {
    user,
    session,
    loading,
    sessionReady,
    accessType,
    accessStatus,
    accessError,
    isAdmin,
    isRealAdmin,
    isPartner,
    impersonatingId,
    impersonatingName,
    startImpersonation,
    stopImpersonation,
  } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const lastProcessedAuthErrorRef = useRef<unknown>(null);
  const lastProcessedQueryErrorRef = useRef<unknown>(null);
  const [hideCompleted, setHideCompleted] = useState(false);
  const [hideToAssign, setHideToAssign] = useState(false);
  const [activePartnerWorkOnly, setActivePartnerWorkOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("code");
  const showAuthDebugPanel = isDebugEnabled();
  const clientTokenDiagnostics = useMemo(
    () => describeSupabaseToken(session?.access_token),
    [session?.access_token],
  );
  const clientProjectHost = useMemo(
    () => getSupabaseProjectHost(import.meta.env.VITE_SUPABASE_URL || undefined),
    [],
  );
  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", replace: true });
      return;
    }
    if (!sessionReady) return;
  }, [loading, sessionReady, user, navigate]);

  const fetchJobs = useServerFn(listJobs);
  const fetchAccountants = useServerFn(listAccountants);
  const fetchOrder = useServerFn(getJobOrder);
  const persistOrder = useServerFn(saveJobOrder);
  const resetOrder = useServerFn(clearJobOrder);
  const queryClient = useQueryClient();
  const asPartner = impersonatingId ?? "";
  const scopeKey = asPartner ? `partner:${asPartner}` : isAdmin ? "admin" : "self";
  const isAuthBootstrapping = loading || (!!user && !sessionReady);
  const isDashboardQueryEnabled = !loading && !!user && sessionReady;
  const hasPortalAccess =
    accessStatus === "resolved" && (accessType === "admin" || accessType === "partner");
  const shouldFetchJobs = isDashboardQueryEnabled && hasPortalAccess;
  const shouldFetchOrder = shouldFetchJobs;
  const shouldFetchAccountants = isDashboardQueryEnabled && !!isRealAdmin;

  // `sessionReady` ensures we never fire server functions during Supabase's
  // internal _initialize/_recoverAndRefresh cycle, where the token is not yet
  // valid even though `user` is non-null.
  const { data, isLoading, error } = useQuery({
    queryKey: ["jobs", user?.id, asPartner],
    queryFn: () => fetchJobs({ data: asPartner ? { asAccountantId: asPartner } : {} }),
    enabled: shouldFetchJobs,
    throwOnError: false,
  });
  const accQ = useQuery({
    queryKey: ["accountants"],
    queryFn: () => fetchAccountants(),
    enabled: shouldFetchAccountants,
    throwOnError: false,
  });
  const orderQ = useQuery({
    queryKey: ["job-order", user?.id, scopeKey],
    queryFn: () => fetchOrder({ data: { scopeKey } }),
    enabled: shouldFetchOrder,
    throwOnError: false,
  });
  const queryErrors = useMemo(
    () => [error, accQ.error, orderQ.error],
    [accQ.error, error, orderQ.error],
  );
  const authError = useMemo(
    () => queryErrors.find((err) => err != null && isAuthSessionError(err)),
    [queryErrors],
  );
  const queryError = useMemo(
    () => queryErrors.find((err) => err != null && !isAuthSessionError(err)),
    [queryErrors],
  );
  const serverFunctionAuthError = useMemo(
    () => queryErrors.find((err) => err != null && isRequireSupabaseAuthMessage(err)),
    [queryErrors],
  );
  const queryErrorReferenceId = useMemo(
    () => (queryError ? createErrorReferenceId("dashboard-query") : null),
    [queryError],
  );
  const serverFunctionErrorReferenceId = useMemo(
    () => (serverFunctionAuthError ? createErrorReferenceId("dashboard-server-auth") : null),
    [serverFunctionAuthError],
  );
  const isLoadingJobs =
    isAuthBootstrapping ||
    (shouldFetchJobs && (isLoading || orderQ.isLoading || (!!isRealAdmin && accQ.isLoading)));

  useEffect(() => {
    debugLog("[dashboard] auth gate", {
      userId: user?.id ?? null,
      loading,
      sessionReady,
      isAdmin,
      isRealAdmin,
      isPartner,
      accessType,
      accessStatus,
      accessError,
      impersonatingId,
    });
  }, [
    accessError,
    accessStatus,
    accessType,
    impersonatingId,
    isAdmin,
    isPartner,
    isRealAdmin,
    loading,
    sessionReady,
    user?.id,
  ]);

  useEffect(() => {
    if (!authError) {
      lastProcessedAuthErrorRef.current = null;
      return;
    }
    if (lastProcessedAuthErrorRef.current === authError) return;
    lastProcessedAuthErrorRef.current = authError;

    if (authError) {
      debugError("[dashboard] auth error", {
        message: getErrorMessage(authError),
        error: authError,
        pathname,
        userId: user?.id ?? null,
        sessionReady,
      });
    }
    const timeoutId = window.setTimeout(() => {
      navigate({ to: "/login", replace: true });
    }, AUTH_ERROR_REDIRECT_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [authError, navigate, pathname, sessionReady, user?.id]);

  useEffect(() => {
    if (!queryError) {
      lastProcessedQueryErrorRef.current = null;
      return;
    }
    if (lastProcessedQueryErrorRef.current === queryError) return;
    lastProcessedQueryErrorRef.current = queryError;

    debugError("[dashboard] query error", {
      jobs: error && !isAuthSessionError(error) ? getErrorMessage(error) : null,
      accountants:
        accQ.error && !isAuthSessionError(accQ.error) ? getErrorMessage(accQ.error) : null,
      order:
        orderQ.error && !isAuthSessionError(orderQ.error) ? getErrorMessage(orderQ.error) : null,
      pathname,
      userId: user?.id ?? null,
      sessionReady,
    });
  }, [accQ.error, error, orderQ.error, pathname, queryError, sessionReady, user?.id]);

  const savedOrder = Array.isArray(orderQ.data?.orderedJobIds) ? orderQ.data.orderedJobIds : [];
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const accountants = Array.isArray(accQ.data?.accountants) ? accQ.data.accountants : [];
  const clientNames = data?.clientNames ?? {};

  // Local manual ordering (initialised from saved order; new jobs appended)
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const handleMutationError = (error: unknown) => {
    if (isAuthSessionError(error)) {
      navigate({ to: "/login", replace: true });
      return;
    }
    toast.error(getErrorMessage(error));
  };

  useEffect(() => {
    if (!isDashboardQueryEnabled || !data) return;
    const ids = jobs.map((j) => j.id);
    if (savedOrder.length === 0) {
      setManualOrder(ids);
    } else {
      const known = savedOrder.filter((id) => ids.includes(id));
      const newOnes = ids.filter((id) => !savedOrder.includes(id));
      setManualOrder([...known, ...newOnes]);
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, orderQ.data]);

  useEffect(() => {
    setSortBy(savedOrder.length > 0 ? "manual" : "code");
  }, [savedOrder.length]);

  const newJobIds = useMemo(() => {
    if (!Array.isArray(savedOrder) || savedOrder.length === 0) return [] as string[];
    return jobs.map((j) => j.id).filter((id) => !savedOrder.includes(id));
  }, [jobs, savedOrder]);

  const saveMut = useMutation({
    mutationFn: () => persistOrder({ data: { scopeKey, orderedJobIds: manualOrder } }),
    onSuccess: () => {
      toast.success("Order saved");
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["job-order", user?.id, scopeKey] });
    },
    onError: handleMutationError,
  });
  const clearMut = useMutation({
    mutationFn: () => resetOrder({ data: { scopeKey } }),
    onSuccess: () => {
      toast.success("Custom order cleared");
      queryClient.invalidateQueries({ queryKey: ["job-order", user?.id, scopeKey] });
    },
    onError: handleMutationError,
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const sortedJobs = useMemo(() => {
    if (sortBy === "manual") {
      const map = new Map(jobs.map((j) => [j.id, j]));
      return manualOrder.map((id) => map.get(id)).filter(Boolean) as typeof jobs;
    }
    const arr = [...jobs];
    const cmp = (a: string | undefined, b: string | undefined) => (a ?? "").localeCompare(b ?? "");
    if (sortBy === "code")
      arr.sort((a, b) => compareJobCodeAsc(a.fields["Job Code"], b.fields["Job Code"]));
    else if (sortBy === "status")
      arr.sort(
        (a, b) =>
          getJobStatusSortOrder(a.fields.Status) - getJobStatusSortOrder(b.fields.Status) ||
          cmp(a.fields.Status, b.fields.Status),
      );
    else if (sortBy === "tier") arr.sort((a, b) => cmp(a.fields.Tier?.[0], b.fields.Tier?.[0]));
    else if (sortBy === "sla")
      arr.sort((a, b) => cmp(a.fields["SLA Deadline"], b.fields["SLA Deadline"]));
    return arr;
  }, [jobs, manualOrder, sortBy]);

  const filtered = sortedJobs.filter((j) => {
    const status = j.fields.Status ?? "";
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (hideCompleted && status === "Completed") return false;
    if (hideToAssign && status === "To Assign") return false;
    if (activePartnerWorkOnly && !ACTIVE_PARTNER_WORK_STATUSES.has(status)) return false;
    return true;
  });

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = filtered.map((j) => j.id);
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    const newFilteredOrder = arrayMove(ids, oldIndex, newIndex);
    const filteredSet = new Set(ids);
    const result: string[] = [];
    let inserted = false;
    for (const id of manualOrder) {
      if (filteredSet.has(id)) {
        if (!inserted) {
          result.push(...newFilteredOrder);
          inserted = true;
        }
      } else {
        result.push(id);
      }
    }
    if (!inserted) result.push(...newFilteredOrder);
    setManualOrder(result);
    setDirty(true);
  };

  if (isAuthBootstrapping) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground">
        Loading your dashboard…
      </div>
    );
  }

  if (!user) return null;

  if (authError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Card>
          <CardContent className="py-6">
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight">Session expired</h1>
              <p className="text-sm text-muted-foreground">
                Your session expired. Please sign in again.
              </p>
              <Button onClick={() => navigate({ to: "/login", replace: true })}>
                Go to sign in
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (queryError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Card>
          <CardContent className="py-6">
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight">Dashboard unavailable</h1>
              <p className="text-sm text-muted-foreground">
                Could not load dashboard data. Please try again.
              </p>
              {queryErrorReferenceId && (
                <p className="text-xs text-muted-foreground">
                  Reference ID: {queryErrorReferenceId}
                </p>
              )}
              {showAuthDebugPanel && (
                <p className="text-sm text-destructive">{getErrorMessage(queryError)}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    queryClient.invalidateQueries({ queryKey: ["jobs", user.id, asPartner] });
                    queryClient.invalidateQueries({ queryKey: ["job-order", user.id, scopeKey] });
                    queryClient.invalidateQueries({ queryKey: ["accountants"] });
                  }}
                >
                  Retry
                </Button>
                <Button variant="outline" onClick={() => navigate({ to: "/login", replace: true })}>
                  Go to sign in
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your jobs</h1>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "Showing all jobs (admin view)"
              : impersonatingId
                ? `Impersonating partner: ${impersonatingName ?? impersonatingId}`
                : isPartner
                  ? "Showing jobs assigned to you"
                  : accessStatus === "verification_failed"
                    ? showAuthDebugPanel
                      ? (accessError ?? "Could not verify your portal access")
                      : "Could not verify your portal access"
                    : accessType === "unauthorized"
                      ? "Your account is not linked to an admin or accountant profile yet"
                      : "Checking your portal access"}
          </p>
        </div>
        {hasPortalAccess && (
          <div className="flex w-full flex-col gap-3 sm:w-auto">
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {isRealAdmin && (
                <div className="flex items-center gap-2">
                  <label htmlFor="partner-impersonation" className="text-xs text-muted-foreground">
                    Partner view
                  </label>
                  <div className="relative">
                    <select
                      id="partner-impersonation"
                      value={asPartner}
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) {
                          stopImpersonation();
                        } else {
                          const name = accountants.find((a) => a.id === id)?.fields.Name ?? id;
                          startImpersonation(id, name);
                        }
                      }}
                      className="h-9 min-w-52 appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm"
                    >
                      <option value="">All partners (admin)</option>
                      {accountants.map((a) => (
                        <option key={a.id} value={a.id}>
                          View as: {a.fields.Name ?? a.id}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground h-4 w-4" />
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="h-9 min-w-44 appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm"
                  >
                    <option value="all">All statuses</option>
                    {JOB_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 pointer-events-none text-muted-foreground" />
                </div>
                <label className="text-xs text-muted-foreground">Filters</label>
                <label className="inline-flex h-9 items-center gap-2 rounded-full border border-input bg-background px-3 text-sm">
                  <input
                    type="checkbox"
                    checked={hideCompleted}
                    onChange={(e) => setHideCompleted(e.target.checked)}
                  />
                  Hide Completed
                </label>
                <label className="inline-flex h-9 items-center gap-2 rounded-full border border-input bg-background px-3 text-sm">
                  <input
                    type="checkbox"
                    checked={hideToAssign}
                    onChange={(e) => setHideToAssign(e.target.checked)}
                  />
                  Hide To Assign
                </label>
                <label className="inline-flex h-9 items-center gap-2 rounded-full border border-input bg-background px-3 text-sm">
                  <input
                    type="checkbox"
                    checked={activePartnerWorkOnly}
                    onChange={(e) => setActivePartnerWorkOnly(e.target.checked)}
                  />
                  Active partner work
                </label>
                {(statusFilter !== "all" ||
                  hideCompleted ||
                  hideToAssign ||
                  activePartnerWorkOnly) && (
                  <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                    Filters active
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <div className="relative">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="h-9 min-w-56 appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm"
                >
                  <option value="manual">Manual order (drag & drop)</option>
                  <option value="code">Sort by Job Code</option>
                  <option value="status">Sort by Status</option>
                  <option value="tier">Sort by Tier</option>
                  <option value="sla">Sort by SLA</option>
                </select>
                <ChevronDown className="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 pointer-events-none text-muted-foreground" />
              </div>
              {sortBy === "manual" && (dirty || savedOrder.length > 0) && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => saveMut.mutate()}
                    disabled={!dirty || saveMut.isPending}
                  >
                    {saveMut.isPending ? "Saving…" : "Save order"}
                  </Button>
                  {savedOrder.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => clearMut.mutate()}
                      disabled={clearMut.isPending}
                    >
                      Clear saved order
                    </Button>
                  )}
                  {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {impersonatingId && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-medium text-amber-900">
            Viewing as partner: {impersonatingName ?? impersonatingId}
          </p>
          <Button size="sm" variant="outline" onClick={stopImpersonation}>
            Exit impersonation
          </Button>
        </div>
      )}

      {hasPortalAccess && sortBy === "manual" && savedOrder.length > 0 && newJobIds.length > 0 && (
        <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          You're viewing your saved custom order. {newJobIds.length} new job
          {newJobIds.length === 1 ? " has" : "s have"} been added since and{" "}
          {newJobIds.length === 1 ? "is" : "are"} placed at the bottom. Drag and save to include{" "}
          {newJobIds.length === 1 ? "it" : "them"} in your order.
        </div>
      )}

      {hasPortalAccess && isLoadingJobs && (
        <div className="mt-6 grid gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card text-card-foreground shadow">
              <div className="flex flex-col space-y-1.5 p-6 pb-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="h-4 w-2/5 animate-shimmer rounded bg-muted" />
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-16 animate-shimmer rounded-full bg-muted/50" />
                    <div className="h-5 w-20 animate-shimmer rounded-full bg-muted/50" />
                  </div>
                </div>
              </div>
              <div className="p-6 pt-0">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <div className="h-3 w-32 animate-shimmer rounded bg-muted/50" />
                  <div className="h-3 w-24 animate-shimmer rounded bg-muted/50" />
                  <div className="h-3 w-28 animate-shimmer rounded bg-muted/50" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {!isLoadingJobs && accessStatus === "verification_failed" && (
        <Card className="mt-8 border-destructive/40">
          <CardContent className="py-6 text-sm text-muted-foreground">
            <p>
              {showAuthDebugPanel
                ? (accessError ??
                  "Could not verify portal access. Please contact the administrator.")
                : "Could not verify portal access. Please contact the administrator."}
            </p>
            {showAuthDebugPanel && (
              <dl className="mt-4 grid gap-1 text-xs">
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">Client project host:</dt>
                  <dd>{clientProjectHost ?? "unknown"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">Client session:</dt>
                  <dd>{session ? "present" : "missing"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">Access token:</dt>
                  <dd>{clientTokenDiagnostics.exists ? "present" : "missing"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">Token shape:</dt>
                  <dd>{clientTokenDiagnostics.headerValue}</dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>
      )}
      {!isLoadingJobs && accessStatus === "unauthorized" && (
        <Card className="mt-8">
          <CardContent className="py-6 text-sm text-muted-foreground">
            <p>
              Your Supabase account exists, but it is not linked to an admin or accountant profile
              yet.
            </p>
            <p className="mt-2">
              Please contact the My Greek Tax administrator to enable your portal access.
            </p>
          </CardContent>
        </Card>
      )}
      {!isLoadingJobs && hasPortalAccess && serverFunctionAuthError && (
        <Card className="mt-8 border-destructive/40">
          <CardContent className="py-6 text-sm text-muted-foreground">
            <p>
              {showAuthDebugPanel
                ? getErrorMessage(serverFunctionAuthError)
                : "Could not verify your session. Please sign in again or try again shortly."}
            </p>
            {!showAuthDebugPanel && serverFunctionErrorReferenceId && (
              <p className="mt-2 text-xs text-muted-foreground">
                Reference ID: {serverFunctionErrorReferenceId}
              </p>
            )}
            {showAuthDebugPanel && (
              <dl className="mt-4 grid gap-1 text-xs">
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">Client project host:</dt>
                  <dd>{clientProjectHost ?? "unknown"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">Client session:</dt>
                  <dd>{session ? "present" : "missing"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">Access token:</dt>
                  <dd>{clientTokenDiagnostics.exists ? "present" : "missing"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-foreground">Token shape:</dt>
                  <dd>{clientTokenDiagnostics.headerValue}</dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>
      )}

      {hasPortalAccess && (
        <div className="mt-6">
          {sortBy === "manual" ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={filtered.map((j) => j.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="grid gap-3">
                  {filtered.map((job) => (
                    <SortableJobRow
                      key={job.id}
                      job={job}
                      isNew={newJobIds.includes(job.id)}
                      isAdmin={isAdmin}
                      asPartner={asPartner}
                      clientName={clientNames[job.fields.Client?.[0] ?? ""]}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div className="grid gap-3">
              {filtered.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  isAdmin={isAdmin}
                  asPartner={asPartner}
                  clientName={clientNames[job.fields.Client?.[0] ?? ""]}
                />
              ))}
            </div>
          )}
          {!isLoadingJobs && filtered.length === 0 && (isAdmin || isPartner) && (
            <p className="text-sm text-muted-foreground">
              {jobs.length === 0 ? "No jobs available yet." : "No jobs match this filter."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

type JobLite = {
  id: string;
  fields: {
    "Job Code"?: string;
    "Service Name"?: string[];
    Tier?: string[];
    Status?: string;
    "Next Action Needed"?: string;
    Client?: string[];
    "Client Code"?: string[];
    "SLA Deadline"?: string;
    "Client Fee (\u20ac)"?: number;
    "Accountant Fee (\u20ac)"?: number;
  };
};

function JobCardInner({
  job,
  isAdmin,
  asPartner,
  clientName,
}: {
  job: JobLite;
  isAdmin: boolean;
  asPartner: string;
  clientName?: string;
}) {
  const code = job.fields["Client Code"]?.[0] ?? "—";
  return (
    <Card className="transition-colors hover:border-primary/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">
            {job.fields["Job Code"] ?? "Untitled"} ·{" "}
            <span className="font-normal text-muted-foreground">
              {job.fields["Service Name"]?.[0] ?? "—"}
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <TierBadge tier={job.fields.Tier?.[0]} />
            <StatusBadge status={job.fields.Status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span>
            Client:{" "}
            {clientName ? (
              <span className="text-foreground">
                {clientName} <span className="text-muted-foreground">({code})</span>
              </span>
            ) : (
              code
            )}
          </span>
          <span>SLA: {formatDate(job.fields["SLA Deadline"])}</span>
          <span className="inline-flex items-center gap-1">
            Next:{" "}
            <NextActionBadge value={job.fields["Next Action Needed"]} className="align-middle" />
          </span>
          <span>
            {isAdmin && !asPartner
              ? `Client fee: \u20ac${job.fields["Client Fee (\u20ac)"] ?? "—"}`
              : `Your fee: \u20ac${job.fields["Accountant Fee (\u20ac)"] ?? "—"}`}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function JobCard(props: {
  job: JobLite;
  isAdmin: boolean;
  asPartner: string;
  clientName?: string;
}) {
  return (
    <Link to="/jobs/$jobId" params={{ jobId: props.job.id }}>
      <JobCardInner {...props} />
    </Link>
  );
}

function SortableJobRow(props: {
  job: JobLite;
  isNew: boolean;
  isAdmin: boolean;
  asPartner: string;
  clientName?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.job.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="flex items-stretch gap-2">
      <button
        type="button"
        className="flex items-center px-1 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1 relative">
        {props.isNew && (
          <span className="absolute -top-2 right-2 z-10 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
            New
          </span>
        )}
        <Link to="/jobs/$jobId" params={{ jobId: props.job.id }} className="block">
          <JobCardInner
            job={props.job}
            isAdmin={props.isAdmin}
            asPartner={props.asPartner}
            clientName={props.clientName}
          />
        </Link>
      </div>
    </div>
  );
}
