import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  listJobs,
  listAccountants,
  getJobOrder,
  saveJobOrder,
  clearJobOrder,
} from "@/lib/jobs.functions";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, TierBadge } from "@/lib/badges";
import { JOB_STATUSES } from "@/lib/airtable-shared";
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

export const Route = createFileRoute("/dashboard")({ component: Dashboard });

function Dashboard() {
  const {
    user,
    loading,
    sessionReady,
    isAdmin,
    isRealAdmin,
    isPartner,
    impersonatingId,
    impersonatingName,
    startImpersonation,
    stopImpersonation,
  } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("manual");
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const fetchJobs = useServerFn(listJobs);
  const fetchAccountants = useServerFn(listAccountants);
  const fetchOrder = useServerFn(getJobOrder);
  const persistOrder = useServerFn(saveJobOrder);
  const resetOrder = useServerFn(clearJobOrder);
  const queryClient = useQueryClient();
  const asPartner = impersonatingId ?? "";
  const scopeKey = asPartner ? `partner:${asPartner}` : isAdmin ? "admin" : "self";

  // `sessionReady` ensures we never fire server functions during Supabase's
  // internal _initialize/_recoverAndRefresh cycle, where the token is not yet
  // valid even though `user` is non-null.
  const { data, isLoading, error } = useQuery({
    queryKey: ["jobs", user?.id, asPartner],
    queryFn: () => fetchJobs({ data: asPartner ? { asAccountantId: asPartner } : {} }),
    enabled: !!user && sessionReady,
  });
  const accQ = useQuery({
    queryKey: ["accountants"],
    queryFn: () => fetchAccountants(),
    enabled: !!isRealAdmin && sessionReady,
  });
  const orderQ = useQuery({
    queryKey: ["job-order", user?.id, scopeKey],
    queryFn: () => fetchOrder({ data: { scopeKey } }),
    enabled: !!user && sessionReady,
  });
  const isLoadingJobs = isLoading || !sessionReady;

  const savedOrder = orderQ.data?.orderedJobIds ?? [];
  const jobs = data?.jobs ?? [];

  // Local manual ordering (initialised from saved order; new jobs appended)
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
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

  const newJobIds = useMemo(() => {
    if (savedOrder.length === 0) return [] as string[];
    return jobs.map((j) => j.id).filter((id) => !savedOrder.includes(id));
  }, [jobs, savedOrder]);

  const saveMut = useMutation({
    mutationFn: () => persistOrder({ data: { scopeKey, orderedJobIds: manualOrder } }),
    onSuccess: () => {
      toast.success("Order saved");
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["job-order", user?.id, scopeKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const clearMut = useMutation({
    mutationFn: () => resetOrder({ data: { scopeKey } }),
    onSuccess: () => {
      toast.success("Custom order cleared");
      queryClient.invalidateQueries({ queryKey: ["job-order", user?.id, scopeKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const sortedJobs = useMemo(() => {
    if (sortBy === "manual") {
      const map = new Map(jobs.map((j) => [j.id, j]));
      return manualOrder.map((id) => map.get(id)).filter(Boolean) as typeof jobs;
    }
    const arr = [...jobs];
    const cmp = (a: string | undefined, b: string | undefined) =>
      (a ?? "").localeCompare(b ?? "");
    if (sortBy === "code") arr.sort((a, b) => cmp(a.fields["Job Code"], b.fields["Job Code"]));
    else if (sortBy === "status") arr.sort((a, b) => cmp(a.fields.Status, b.fields.Status));
    else if (sortBy === "tier") arr.sort((a, b) => cmp(a.fields.Tier?.[0], b.fields.Tier?.[0]));
    else if (sortBy === "sla")
      arr.sort((a, b) => cmp(a.fields["SLA Deadline"], b.fields["SLA Deadline"]));
    return arr;
  }, [jobs, manualOrder, sortBy]);

  const filtered =
    filter === "all" ? sortedJobs : sortedJobs.filter((j) => j.fields.Status === filter);

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

  if (!user) return null;

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
                : "No partner profile linked yet"}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
        {isRealAdmin && (
          <div className="relative">
          <select
            value={asPartner}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) {
                stopImpersonation();
              } else {
                const name = accQ.data?.accountants.find((a) => a.id === id)?.fields.Name ?? id;
                startImpersonation(id, name);
              }
            }}
            className="appearance-none pr-8 rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">All partners (admin)</option>
            {accQ.data?.accountants.map((a) => (
              <option key={a.id} value={a.id}>View as: {a.fields.Name ?? a.id}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground h-4 w-4" />
          </div>
        )}
        <div className="relative">
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="appearance-none pr-8 rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="manual">Manual order (drag & drop)</option>
          <option value="code">Sort by Job Code</option>
          <option value="status">Sort by Status</option>
          <option value="tier">Sort by Tier</option>
          <option value="sla">Sort by SLA</option>
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground h-4 w-4" />
        </div>
        <div className="relative">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="appearance-none pr-8 rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground h-4 w-4" />
        </div>
        </div>
      </div>

      {sortBy === "manual" && savedOrder.length > 0 && newJobIds.length > 0 && (
        <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          You're viewing your saved custom order. {newJobIds.length} new job
          {newJobIds.length === 1 ? " has" : "s have"} been added since and{" "}
          {newJobIds.length === 1 ? "is" : "are"} placed at the bottom. Drag and save to include {newJobIds.length === 1 ? "it" : "them"} in your order.
        </div>
      )}
      {sortBy === "manual" && (dirty || savedOrder.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => saveMut.mutate()} disabled={!dirty || saveMut.isPending}>
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

      {isLoadingJobs && (
        <div className="mt-6 grid gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border bg-card text-card-foreground shadow"
            >
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
      {error && <p className="mt-8 text-sm text-destructive">{(error as Error).message}</p>}
      {!isLoadingJobs && !isAdmin && !isPartner && (
        <Card className="mt-8">
          <CardContent className="py-6 text-sm text-muted-foreground">
            Your account is not yet linked to an Accountant in Airtable. Make sure your
            login email matches the Email field on your Accountant record, then sign out and sign back in.
          </CardContent>
        </Card>
      )}

      <div className="mt-6">
        {sortBy === "manual" ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map((j) => j.id)} strategy={verticalListSortingStrategy}>
              <div className="grid gap-3">
                {filtered.map((job) => (
                  <SortableJobRow
                    key={job.id}
                    job={job}
                    isNew={newJobIds.includes(job.id)}
                    isAdmin={isAdmin}
                    asPartner={asPartner}
                    clientName={data?.clientNames?.[job.fields.Client?.[0] ?? ""]}
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
                clientName={data?.clientNames?.[job.fields.Client?.[0] ?? ""]}
              />
            ))}
          </div>
        )}
        {!isLoadingJobs && filtered.length === 0 && (isAdmin || isPartner) && (
          <p className="text-sm text-muted-foreground">No jobs match this filter.</p>
        )}
      </div>
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
