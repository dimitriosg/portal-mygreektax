import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getJob, updateJob, createClientToken } from "@/lib/jobs.functions";
import { JOB_STATUSES } from "@/lib/airtable-shared";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/jobs/$jobId")({ component: JobDetail });

function JobDetail() {
  const { jobId } = Route.useParams();
  const { user, loading, isAdmin } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const fetchJob = useServerFn(getJob);
  const updateFn = useServerFn(updateJob);
  const tokenFn = useServerFn(createClientToken);
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => fetchJob({ data: { jobId } }),
    enabled: !!user,
  });

  const [status, setStatus] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  useEffect(() => {
    if (data?.job) {
      setStatus(data.job.fields.Status ?? "");
      setNotes(data.job.fields.Notes ?? "");
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => updateFn({ data: { jobId, status: status || undefined, notes } }),
    onSuccess: () => {
      toast.success("Job updated");
      qc.invalidateQueries({ queryKey: ["job", jobId] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const sendLink = useMutation({
    mutationFn: () => tokenFn({ data: { jobId } }),
    onSuccess: ({ token, email }) => {
      const url = `${window.location.origin}/track/${token}`;
      navigator.clipboard?.writeText(url).catch(() => {});
      toast.success(`Tracking link copied for ${email}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!user) return null;
  if (isLoading) return <p className="mx-auto max-w-3xl px-4 py-8 text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="mx-auto max-w-3xl px-4 py-8 text-sm text-destructive">{(error as Error).message}</p>;
  if (!data) return null;

  const j = data.job.fields;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{j["Job Code"]}</h1>
          <p className="text-sm text-muted-foreground">{j["Service Name"]?.[0] ?? "—"}</p>
        </div>
        <Badge variant="secondary">{j.Status ?? "—"}</Badge>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          <div><div className="text-muted-foreground">Client</div><div>{data.client?.fields["Full Name"] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Client code</div><div>{j["Client Code"]?.[0] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Date sent</div><div>{j["Date Sent"] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">SLA deadline</div><div>{j["SLA Deadline"] ?? "—"}</div></div>
          {isAdmin && (
            <div><div className="text-muted-foreground">Client fee</div><div>€{j["Client Fee (\u20ac)"] ?? "—"}</div></div>
          )}
          <div><div className="text-muted-foreground">Your fee</div><div>€{j["Accountant Fee (\u20ac)"] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Category</div><div>{j.Category?.[0] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Tier</div><div>{j.Tier?.[0] ?? "—"}</div></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Update progress</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={5} className="mt-1" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
            {isAdmin && (
              <Button variant="outline" onClick={() => sendLink.mutate()} disabled={sendLink.isPending}>
                {sendLink.isPending ? "Generating…" : "Copy client tracking link"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}