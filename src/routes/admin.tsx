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

export const Route = createFileRoute("/admin")({ component: AdminPage });

function AdminPage() {
  const { user, loading, isAdmin, isRealAdmin } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!user) navigate({ to: "/login" });
    else if (!isAdmin) navigate({ to: "/dashboard" });
  }, [loading, user, isAdmin, navigate]);

  const fetchJobs = useServerFn(listJobs);
  const fetchAccountants = useServerFn(listAccountants);
  const assignFn = useServerFn(assignPartner);
  const createTokenFn = useServerFn(createClientToken);
  const fetchClients = useServerFn(listClients);
  const fetchServices = useServerFn(listServices);
  const createJobFn = useServerFn(createJob);
  const qc = useQueryClient();

  const jobsQ = useQuery({ queryKey: ["jobs", "admin"], queryFn: () => fetchJobs(), enabled: !!isAdmin });
  const accQ = useQuery({ queryKey: ["accountants"], queryFn: () => fetchAccountants(), enabled: !!isAdmin });
  const clientsQ = useQuery({ queryKey: ["clients"], queryFn: () => fetchClients(), enabled: !!isAdmin });
  const servicesQ = useQuery({ queryKey: ["services"], queryFn: () => fetchServices(), enabled: !!isAdmin });

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
    onSuccess: () => {
      toast.success("Job created");
      qc.invalidateQueries({ queryKey: ["jobs"] });
      setOpen(false);
      setForm({ clientId: "", serviceId: "", accountantId: "", status: "To Assign", slaDeadline: "", dateSent: "", notes: "" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const assign = useMutation({
    mutationFn: (vars: { jobId: string; accountantId: string }) => assignFn({ data: vars }),
    onSuccess: () => {
      toast.success("Partner assigned");
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const makeLink = useMutation({
    mutationFn: (vars: { jobId: string }) => createTokenFn({ data: vars }),
    onSuccess: async ({ token, email }) => {
      const url = `${window.location.origin}/track/${token}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success(`Link copied (for ${email})`);
      } catch {
        toast.success(`Link created for ${email}`, { description: url });
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!isAdmin) return null;

  const jobs = jobsQ.data?.jobs ?? [];
  const accountants = accQ.data?.accountants ?? [];

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
                        {[s.code || s.name, s.tier, s.category].filter(Boolean).join(" / ")}
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
                      <option key={a.id} value={a.id}>{a.fields.Name ?? a.id}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Status</Label>
                    <select
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as (typeof JOB_STATUSES)[number] })}
                      className="w-full rounded border border-input bg-background px-2 py-2 text-sm"
                    >
                      {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
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
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total jobs" value={jobs.length} />
        <Stat label="In progress" value={counts["In Progress"] ?? 0} />
        <Stat label="Overdue" value={overdue} highlight={overdue > 0} />
        <Stat label="Completed" value={counts["Completed"] ?? 0} />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">All jobs</h2>
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
              {jobs.map((job) => {
                const currentAcc = job.fields["Assigned Accountant"]?.[0] ?? "";
                const clientId = job.fields.Client?.[0] ?? "";
                const clientName = jobsQ.data?.clientNames?.[clientId];
                return (
                  <tr key={job.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link to="/jobs/$jobId" params={{ jobId: job.id }} className="font-medium hover:underline">
                        {job.fields["Job Code"]}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <div>{clientName ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{job.fields["Client Code"]?.[0] ?? ""}</div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{job.fields["Service Name"]?.[0] ?? "—"}</td>
                    <td className="px-3 py-2"><TierBadge tier={job.fields.Tier?.[0]} /></td>
                    <td className="px-3 py-2"><StatusBadge status={job.fields.Status} /></td>
                    <td className="px-3 py-2 text-muted-foreground">{job.fields["SLA Deadline"] ?? "—"}</td>
                    <td className="px-3 py-2">
                      <select
                        value={currentAcc}
                        onChange={(e) => assign.mutate({ jobId: job.id, accountantId: e.target.value })}
                        className="rounded border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="">— Unassigned —</option>
                        {accountants.map((a) => (
                          <option key={a.id} value={a.id}>{a.fields.Name ?? a.id}</option>
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
                        Copy magic link
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold ${highlight ? "text-destructive" : ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}