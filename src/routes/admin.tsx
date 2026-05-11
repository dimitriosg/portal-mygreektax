import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  listJobs,
  listAccountants,
  assignPartner,
  createClientToken,
  listClients,
  listServices,
  createJob,
} from "@/lib/jobs.functions";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge, TierBadge } from "@/lib/badges";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { JOB_STATUSES } from "@/lib/airtable-shared";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { CalendarIcon } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import type { DateRange } from "react-day-picker";
import { PartnersSection } from "@/components/admin-partners";
import { AdminAnalytics } from "@/components/admin-analytics";
import { track } from "@/lib/analytics";

export const Route = createFileRoute("/admin")({ component: AdminPage });

// Column widths for the 8-column table skeleton (tailwind w-* classes)
const SKELETON_COL_WIDTHS = ["w-16", "w-24", "w-28", "w-12", "w-20", "w-16", "w-20", "w-24"];

function AdminTableSkeleton() {
  return (
    <>
      <style>{`
        @keyframes admin-shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .admin-skeleton-bar {
          display: inline-block;
          height: 0.75rem;
          border-radius: 0.25rem;
          background: linear-gradient(
            90deg,
            hsl(var(--muted)) 25%,
            hsl(var(--muted-foreground) / 0.15) 50%,
            hsl(var(--muted)) 75%
          );
          background-size: 200% 100%;
          animation: admin-shimmer 1.5s ease-in-out infinite;
        }
      `}</style>
      {Array.from({ length: 5 }).map((_, rowIdx) => (
        <tr key={rowIdx} className="border-t border-border">
          {SKELETON_COL_WIDTHS.map((w, colIdx) => (
            <td key={colIdx} className="px-3 py-3">
              <span className={`admin-skeleton-bar ${w}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function AdminPage() {
  const { user, loading, sessionReady, isAdmin, isRealAdmin } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", replace: true });
      return;
    }
    if (!sessionReady) return;
    if (!isAdmin) navigate({ to: "/dashboard", replace: true });
  }, [loading, sessionReady, user, isAdmin, navigate]);

  const fetchJobs = useServerFn(listJobs);
  const fetchAccountants = useServerFn(listAccountants);
  const assignFn = useServerFn(assignPartner);
  const createTokenFn = useServerFn(createClientToken);
  const fetchClients = useServerFn(listClients);
  const fetchServices = useServerFn(listServices);
  const createJobFn = useServerFn(createJob);
  const qc = useQueryClient();

  const jobsQ = useQuery({
    queryKey: ["jobs", "admin"],
    queryFn: () => fetchJobs(),
    enabled: !!isAdmin && sessionReady,
  });
  const accQ = useQuery({
    queryKey: ["accountants"],
    queryFn: () => fetchAccountants(),
    enabled: !!isAdmin && sessionReady,
  });
  const clientsQ = useQuery({
    queryKey: ["clients"],
    queryFn: () => fetchClients(),
    enabled: !!isAdmin && sessionReady,
  });
  const servicesQ = useQuery({
    queryKey: ["services"],
    queryFn: () => fetchServices(),
    enabled: !!isAdmin && sessionReady,
  });

  useEffect(() => {
    const authError = [jobsQ.error, accQ.error, clientsQ.error, servicesQ.error].find(
      isAuthSessionError,
    );
    if (authError) {
      navigate({ to: "/login", replace: true });
    }
  }, [accQ.error, clientsQ.error, jobsQ.error, navigate, servicesQ.error]);
  const handleMutationError = (error: unknown) => {
    if (isAuthSessionError(error)) {
      navigate({ to: "/login", replace: true });
      return;
    }
    toast.error(getErrorMessage(error));
  };

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    clientId: "",
    serviceId: "",
    accountantId: "",
    status: "To Assign" as (typeof JOB_STATUSES)[number],
    slaDeadline: "",
    dateSent: "",
    notes: "",
  });

  const createMut = useMutation({
    mutationFn: (vars: Parameters<typeof createJobFn>[0]["data"]) => createJobFn({ data: vars }),
    onSuccess: (_res, vars) => {
      toast.success("Job created");
      const svc = (servicesQ.data?.services ?? []).find((s) => s.id === vars.serviceId);
      track("job_created", {
        tier: svc?.tier ?? "unknown",
        status: vars.status ?? "To Assign",
        assigned: vars.accountantId ? "yes" : "no",
      });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      setOpen(false);
      setForm({
        clientId: "",
        serviceId: "",
        accountantId: "",
        status: "To Assign",
        slaDeadline: "",
        dateSent: "",
        notes: "",
      });
    },
    onError: handleMutationError,
  });

  const assign = useMutation({
    mutationFn: (vars: { jobId: string; accountantId: string }) => assignFn({ data: vars }),
    onSuccess: () => {
      toast.success("Partner assigned");
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: handleMutationError,
  });

  const makeLink = useMutation({
    mutationFn: (vars: { jobId: string }) => createTokenFn({ data: vars }),
    onSuccess: async ({ token, email }) => {
      const url = `${window.location.origin}/track/${token}`;
      track("tracking_link_created");
      try {
        await navigator.clipboard.writeText(url);
        toast.success(`Tracking link copied (for ${email})`);
      } catch {
        toast.success(`Tracking link created for ${email}`, { description: url });
      }
    },
    onError: handleMutationError,
  });

  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [tierFilter, setTierFilter] = useState<string>("");
  const [partnerFilter, setPartnerFilter] = useState<string>("");
  const [slaRange, setSlaRange] = useState<DateRange | undefined>(undefined);

  if (loading || (!!user && !sessionReady)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground">Loading...</div>
    );
  }
  if (!isAdmin) return null;

  const jobs = jobsQ.data?.jobs ?? [];
  const accountants = accQ.data?.accountants ?? [];

  const tiers = Array.from(
    new Set(jobs.map((j) => j.fields.Tier?.[0]).filter(Boolean)),
  ) as string[];

  const filteredJobs = (() => {
    const q = filter.trim().toLowerCase();
    return jobs.filter((job) => {
      if (statusFilter && job.fields.Status !== statusFilter) return false;
      if (tierFilter && job.fields.Tier?.[0] !== tierFilter) return false;
      if (partnerFilter) {
        const accId = job.fields["Assigned Accountant"]?.[0] ?? "";
        if (partnerFilter === "__unassigned__" ? accId !== "" : accId !== partnerFilter)
          return false;
      }
      if (slaRange?.from || slaRange?.to) {
        const slaStr = job.fields["SLA Deadline"];
        if (!slaStr) return false;
        const sla = new Date(slaStr);
        if (slaRange.from && sla < new Date(slaRange.from.toDateString())) return false;
        if (slaRange.to && sla > new Date(new Date(slaRange.to).setHours(23, 59, 59, 999)))
          return false;
      }
      if (!q) return true;
      const clientId = job.fields.Client?.[0] ?? "";
      const clientName = jobsQ.data?.clientNames?.[clientId] ?? "";
      const accId = job.fields["Assigned Accountant"]?.[0];
      const accName = accountants.find((a) => a.id === accId)?.fields.Name ?? "";
      const haystack = [
        job.fields["Job Code"],
        clientName,
        job.fields["Client Code"]?.[0],
        job.fields["Service Name"]?.[0],
        job.fields.Tier?.[0],
        job.fields.Status,
        job.fields["SLA Deadline"],
        accName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  })();

  // Sort by Job Code ascending (e.g. JB100, JB101, JB102…). Uses natural
  // (numeric-aware) compare so JB9 < JB10 even if widths ever differ.
  filteredJobs.sort((a, b) =>
    (a.fields["Job Code"] ?? "").localeCompare(b.fields["Job Code"] ?? "", undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );

  const counts = jobs.reduce<Record<string, number>>((acc, j) => {
    const s = j.fields.Status ?? "—";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const overdue = jobs.filter((j) => {
    const sla = j.fields["SLA Deadline"];
    return sla && new Date(sla) < new Date() && j.fields.Status !== "Completed";
  }).length;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6 sm:space-y-8">
      <div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Admin overview</h1>
            <p className="text-sm text-muted-foreground">All jobs across all partners.</p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/admin/tracking-links">
              <Button variant="outline">Tracking links</Button>
            </Link>
            <Link to="/admin/change-requests">
              <Button variant="outline">Change requests</Button>
            </Link>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button>+ New job</Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Create new job</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>Client</Label>
                    <select
                      value={form.clientId}
                      onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                      className="w-full rounded border border-input bg-background px-2 py-2 text-sm"
                    >
                      <option value="">— Select client —</option>
                      {(clientsQ.data?.clients ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.fields["Full Name"] ?? c.fields["Client Code"] ?? c.id}
                          {c.fields["Client Code"] ? ` (${c.fields["Client Code"]})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>Service</Label>
                    <select
                      value={form.serviceId}
                      onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
                      className="w-full rounded border border-input bg-background px-2 py-2 text-sm"
                    >
                      <option value="">— Select service —</option>
                      {(servicesQ.data?.services ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {[s.code, s.name, s.tier, s.category].filter(Boolean).join(" / ")}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label>Assign partner (optional)</Label>
                    <select
                      value={form.accountantId}
                      onChange={(e) => setForm({ ...form, accountantId: e.target.value })}
                      className="w-full rounded border border-input bg-background px-2 py-2 text-sm"
                    >
                      <option value="">— Unassigned —</option>
                      {accountants.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.fields.Name ?? a.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Status</Label>
                      <select
                        value={form.status}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            status: e.target.value as (typeof JOB_STATUSES)[number],
                          })
                        }
                        className="w-full rounded border border-input bg-background px-2 py-2 text-sm"
                      >
                        {JOB_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label>SLA deadline</Label>
                      <Input
                        type="date"
                        value={form.slaDeadline}
                        onChange={(e) => setForm({ ...form, slaDeadline: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label>Date sent</Label>
                    <Input
                      type="date"
                      value={form.dateSent}
                      onChange={(e) => setForm({ ...form, dateSent: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Notes</Label>
                    <Textarea
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    disabled={!form.clientId || !form.serviceId || createMut.isPending}
                    onClick={() =>
                      createMut.mutate({
                        clientId: form.clientId,
                        serviceId: form.serviceId,
                        accountantId: form.accountantId || undefined,
                        status: form.status,
                        slaDeadline: form.slaDeadline || undefined,
                        dateSent: form.dateSent || undefined,
                        notes: form.notes || undefined,
                      })
                    }
                  >
                    {createMut.isPending ? "Creating…" : "Create job"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total jobs" value={jobs.length} />
        <Stat label="In progress" value={counts["In Progress"] ?? 0} />
        <Stat label="Overdue" value={overdue} highlight={overdue > 0} />
        <Stat label="Completed" value={counts["Completed"] ?? 0} />
      </div>

      {[jobsQ.error, accQ.error, clientsQ.error, servicesQ.error].some(Boolean) && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            {getErrorMessage(jobsQ.error ?? accQ.error ?? clientsQ.error ?? servicesQ.error)}
          </CardContent>
        </Card>
      )}

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">All jobs</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full sm:w-56"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded border border-input bg-background px-2 py-2 text-sm"
            >
              <option value="">All statuses</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
              className="rounded border border-input bg-background px-2 py-2 text-sm"
            >
              <option value="">All tiers</option>
              {tiers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={partnerFilter}
              onChange={(e) => setPartnerFilter(e.target.value)}
              className="rounded border border-input bg-background px-2 py-2 text-sm"
            >
              <option value="">All partners</option>
              <option value="__unassigned__">Unassigned</option>
              {accountants.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fields.Name ?? a.id}
                </option>
              ))}
            </select>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "justify-start font-normal",
                    !slaRange?.from && "text-muted-foreground",
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {slaRange?.from
                    ? slaRange.to
                      ? `${formatDate(slaRange.from)} – ${formatDate(slaRange.to)}`
                      : formatDate(slaRange.from)
                    : "SLA range"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="range"
                  selected={slaRange}
                  onSelect={setSlaRange}
                  numberOfMonths={2}
                  initialFocus
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
            {(filter || statusFilter || tierFilter || partnerFilter || slaRange?.from) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFilter("");
                  setStatusFilter("");
                  setTierFilter("");
                  setPartnerFilter("");
                  setSlaRange(undefined);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Service</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">SLA</th>
                <th className="px-3 py-2">Assigned to</th>
                <th className="px-3 py-2">Client link</th>
              </tr>
            </thead>
            <tbody>
              {jobsQ.isLoading ? (
                <AdminTableSkeleton />
              ) : (
                filteredJobs.map((job) => {
                  const currentAcc = job.fields["Assigned Accountant"]?.[0] ?? "";
                  const clientId = job.fields.Client?.[0] ?? "";
                  const clientName = jobsQ.data?.clientNames?.[clientId];
                  return (
                    <tr key={job.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <Link
                          to="/jobs/$jobId"
                          params={{ jobId: job.id }}
                          className="font-medium hover:underline"
                        >
                          {job.fields["Job Code"]}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <div>{clientName ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {job.fields["Client Code"]?.[0] ?? ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {job.fields["Service Name"]?.[0] ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <TierBadge tier={job.fields.Tier?.[0]} />
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={job.fields.Status} />
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatDate(job.fields["SLA Deadline"])}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={currentAcc}
                          onChange={(e) =>
                            assign.mutate({ jobId: job.id, accountantId: e.target.value })
                          }
                          className="rounded border border-input bg-background px-2 py-1 text-xs"
                        >
                          <option value="">— Unassigned —</option>
                          {accountants.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.fields.Name ?? a.id}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => makeLink.mutate({ jobId: job.id })}
                          disabled={makeLink.isPending}
                        >
                          Copy tracking link
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <PartnersSection accountants={accountants} enabled={sessionReady && isRealAdmin} />

      <AdminAnalytics enabled={sessionReady && isRealAdmin} />
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold ${highlight ? "text-destructive" : ""}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
