import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { listJobs, listAccountants } from "@/lib/jobs.functions";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, TierBadge } from "@/lib/badges";
import { JOB_STATUSES } from "@/lib/airtable-shared";

export const Route = createFileRoute("/dashboard")({ component: Dashboard });

function Dashboard() {
  const {
    user,
    loading,
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
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const fetchJobs = useServerFn(listJobs);
  const fetchAccountants = useServerFn(listAccountants);
  const asPartner = impersonatingId ?? "";
  const { data, isLoading, error } = useQuery({
    queryKey: ["jobs", user?.id, asPartner],
    queryFn: () => fetchJobs({ data: asPartner ? { asAccountantId: asPartner } : {} }),
    enabled: !!user,
  });
  const accQ = useQuery({
    queryKey: ["accountants"],
    queryFn: () => fetchAccountants(),
    enabled: !!isRealAdmin,
  });

  if (!user) return null;

  const jobs = data?.jobs ?? [];
  const filtered = filter === "all" ? jobs : jobs.filter((j) => j.fields.Status === filter);

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
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">All partners (admin)</option>
            {accQ.data?.accountants.map((a) => (
              <option key={a.id} value={a.id}>View as: {a.fields.Name ?? a.id}</option>
            ))}
          </select>
        )}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        </div>
      </div>

      {isLoading && <p className="mt-8 text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="mt-8 text-sm text-destructive">{(error as Error).message}</p>}
      {!isLoading && !isAdmin && !isPartner && (
        <Card className="mt-8">
          <CardContent className="py-6 text-sm text-muted-foreground">
            Your account is not yet linked to an Accountant in Airtable. Make sure your
            login email matches the Email field on your Accountant record, then sign out and sign back in.
          </CardContent>
        </Card>
      )}

      <div className="mt-6 grid gap-3">
        {filtered.map((job) => (
          <Link key={job.id} to="/jobs/$jobId" params={{ jobId: job.id }}>
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
                  <span>Client: {job.fields["Client Code"]?.[0] ?? "—"}</span>
                  <span>SLA: {job.fields["SLA Deadline"] ?? "—"}</span>
                  <span>
                    {isAdmin && !asPartner
                      ? `Client fee: €${job.fields["Client Fee (\u20ac)"] ?? "—"}`
                      : `Your fee: €${job.fields["Accountant Fee (\u20ac)"] ?? "—"}`}
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
        {!isLoading && filtered.length === 0 && (isAdmin || isPartner) && (
          <p className="text-sm text-muted-foreground">No jobs match this filter.</p>
        )}
      </div>
    </div>
  );
}