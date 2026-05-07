import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listJobs, listAccountants, assignPartner, createClientToken } from "@/lib/jobs.functions";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge, TierBadge } from "@/lib/badges";
import { Button } from "@/components/ui/button";
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
  const qc = useQueryClient();

  const jobsQ = useQuery({ queryKey: ["jobs", "admin"], queryFn: () => fetchJobs(), enabled: !!isAdmin });
  const accQ = useQuery({ queryKey: ["accountants"], queryFn: () => fetchAccountants(), enabled: !!isAdmin });

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
        <h1 className="text-2xl font-semibold tracking-tight">Admin overview</h1>
        <p className="text-sm text-muted-foreground">All jobs across all partners.</p>
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