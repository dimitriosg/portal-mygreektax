import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getJob, updateJob, createClientToken, listJobEvents, getJobTrackingStats, extendClientToken, getClientTokenHistory, listJobChangeRequests, requestJobChange, cancelChangeRequest, decideChangeRequest } from "@/lib/jobs.functions";
import { JOB_STATUSES } from "@/lib/airtable-shared";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge, TierBadge } from "@/lib/badges";
import { toast } from "sonner";
import { formatDate, formatDateTime } from "@/lib/utils";
import { track } from "@/lib/analytics";

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
  const fetchEvents = useServerFn(listJobEvents);
  const fetchTrackingStats = useServerFn(getJobTrackingStats);
  const extendFn = useServerFn(extendClientToken);
  const fetchTokenHistory = useServerFn(getClientTokenHistory);
  const listRequestsFn = useServerFn(listJobChangeRequests);
  const requestChangeFn = useServerFn(requestJobChange);
  const cancelRequestFn = useServerFn(cancelChangeRequest);
  const decideRequestFn = useServerFn(decideChangeRequest);
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => fetchJob({ data: { jobId } }),
    enabled: !!user,
  });
  const eventsQ = useQuery({
    queryKey: ["job-events", jobId],
    queryFn: () => fetchEvents({ data: { jobId } }),
    enabled: !!user,
  });
  const trackingQ = useQuery({
    queryKey: ["job-tracking", jobId],
    queryFn: () => fetchTrackingStats({ data: { jobId } }),
    enabled: !!user && !!isAdmin,
  });
  const tokenForHistory = trackingQ.data?.token?.token;
  const historyQ = useQuery({
    queryKey: ["token-history", tokenForHistory],
    queryFn: () => fetchTokenHistory({ data: { token: tokenForHistory! } }),
    enabled: !!tokenForHistory,
  });
  const requestsQ = useQuery({
    queryKey: ["job-change-requests", jobId],
    queryFn: () => listRequestsFn({ data: { jobId } }),
    enabled: !!user,
  });

  const [reqField, setReqField] = useState<"sla_deadline" | "status" | "notes">("sla_deadline");
  const [reqValue, setReqValue] = useState("");
  const [reqReason, setReqReason] = useState("");

  const submitRequest = useMutation({
    mutationFn: () => requestChangeFn({ data: { jobId, field: reqField, requestedValue: reqValue, reason: reqReason || undefined } }),
    onSuccess: () => {
      toast.success("Change request submitted for admin approval");
      setReqValue(""); setReqReason("");
      qc.invalidateQueries({ queryKey: ["job-change-requests", jobId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const cancelRequest = useMutation({
    mutationFn: (id: string) => cancelRequestFn({ data: { id } }),
    onSuccess: () => { toast.success("Request cancelled"); qc.invalidateQueries({ queryKey: ["job-change-requests", jobId] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  const decideRequest = useMutation({
    mutationFn: (vars: { id: string; decision: "approved" | "rejected" }) => decideRequestFn({ data: vars }),
    onSuccess: () => {
      toast.success("Decision recorded");
      qc.invalidateQueries({ queryKey: ["job-change-requests", jobId] });
      qc.invalidateQueries({ queryKey: ["job", jobId] });
      qc.invalidateQueries({ queryKey: ["job-events", jobId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const extendMut = useMutation({
    mutationFn: (days: number) =>
      extendFn({ data: { token: tokenForHistory!, days } }),
    onSuccess: ({ expires_at }) => {
      toast.success(`Link extended — new expiry ${formatDate(expires_at)}`);
      qc.invalidateQueries({ queryKey: ["job-tracking", jobId] });
      qc.invalidateQueries({ queryKey: ["token-history", tokenForHistory] });
    },
    onError: (e) => toast.error((e as Error).message),
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
      const previous = data?.job?.fields.Status ?? "";
      if (status && status !== previous) {
        track("job_status_changed", { from: previous || "unknown", to: status });
      }
      qc.invalidateQueries({ queryKey: ["job", jobId] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["job-events", jobId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const sendLink = useMutation({
    mutationFn: () => tokenFn({ data: { jobId } }),
    onSuccess: ({ token, email }) => {
      const url = `${window.location.origin}/track/${token}`;
      track("tracking_link_created");
      navigator.clipboard?.writeText(url).catch(() => {});
      toast.success(`Tracking link copied for ${email}`);
      qc.invalidateQueries({ queryKey: ["job-tracking", jobId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const [showOpens, setShowOpens] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [extendDays, setExtendDays] = useState<number>(90);

  if (!user) return null;
  if (isLoading) return <p className="mx-auto max-w-3xl px-4 py-8 text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="mx-auto max-w-3xl px-4 py-8 text-sm text-destructive">{(error as Error).message}</p>;
  if (!data) return null;

  const j = data.job.fields;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <Link
        to="/dashboard"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to dashboard
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{j["Job Code"]}</h1>
          <p className="text-sm text-muted-foreground">{j["Service Name"]?.[0] ?? "—"}</p>
        </div>
        <div className="flex items-center gap-2">
          <TierBadge tier={j.Tier?.[0]} />
          <StatusBadge status={j.Status} />
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          <div><div className="text-muted-foreground">Client</div><div>{data.client?.fields["Full Name"] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Client code</div><div>{j["Client Code"]?.[0] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Date sent</div><div>{formatDate(j["Date Sent"])}</div></div>
          <div><div className="text-muted-foreground">SLA deadline</div><div>{formatDate(j["SLA Deadline"])}</div></div>
          {isAdmin && (
            <div><div className="text-muted-foreground">Client fee</div><div>€{j["Client Fee (\u20ac)"] ?? "—"}</div></div>
          )}
          <div><div className="text-muted-foreground">Your fee</div><div>€{j["Accountant Fee (\u20ac)"] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Category</div><div>{j.Category?.[0] ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Tier</div><div><TierBadge tier={j.Tier?.[0]} /></div></div>
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

      <Card>
        <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
        <CardContent>
          {eventsQ.isLoading && <p className="text-sm text-muted-foreground">Loading history…</p>}
          {!eventsQ.isLoading && (eventsQ.data?.events.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
          )}
          <ol className="space-y-4">
            {eventsQ.data?.events.map((ev) => (
              <li key={ev.id} className="border-l-2 border-border pl-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {ev.actor_name ?? ev.actor_email ?? "Someone"}
                  </span>
                  <span>{formatDateTime(ev.created_at)}</span>
                </div>
                {ev.event_type === "status_change" ? (
                  <p className="mt-1 text-sm">
                    Changed status from{" "}
                    <span className="font-medium">{ev.from_status ?? "—"}</span> to{" "}
                    <span className="font-medium">{ev.to_status ?? "—"}</span>
                  </p>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap text-sm">{ev.comment}</p>
                )}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {isAdmin && trackingQ.data?.token && (
        <Card>
          <CardHeader><CardTitle className="text-base">Tracking link</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <div>
                <span className="font-semibold">{trackingQ.data.token.open_count}</span>{" "}
                <span className="text-muted-foreground">opens</span>
              </div>
              <div className="text-muted-foreground">
                {trackingQ.data.token.last_opened_at
                  ? <>Last opened {formatDateTime(trackingQ.data.token.last_opened_at)}{trackingQ.data.token.last_country ? ` from ${trackingQ.data.token.last_country}` : ""}</>
                  : "Not opened yet"}
              </div>
              <div className="text-muted-foreground">
                Expires {formatDate(trackingQ.data.token.expires_at)}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={extendDays}
                onChange={(e) => setExtendDays(Number(e.target.value))}
                className="rounded border border-input bg-background px-2 py-1.5 text-xs"
              >
                <option value={30}>+30 days</option>
                <option value={60}>+60 days</option>
                <option value={90}>+90 days</option>
                <option value={180}>+180 days</option>
                <option value={365}>+365 days</option>
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => extendMut.mutate(extendDays)}
                disabled={extendMut.isPending}
              >
                {extendMut.isPending ? "Extending…" : "Extend expiry"}
              </Button>
            </div>
            {trackingQ.data.opens.length > 0 && (
              <>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setShowOpens((v) => !v)}
                >
                  {showOpens ? "Hide" : "Show"} recent opens ({trackingQ.data.opens.length})
                </button>
                {showOpens && (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full min-w-[480px] text-xs">
                      <thead className="bg-muted/50 text-left">
                        <tr>
                          <th className="px-2 py-1.5">When</th>
                          <th className="px-2 py-1.5">Country</th>
                          <th className="px-2 py-1.5">Device</th>
                          <th className="px-2 py-1.5">Browser</th>
                          <th className="px-2 py-1.5">IP</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trackingQ.data.opens.map((o) => (
                          <tr key={o.id} className="border-t border-border">
                            <td className="px-2 py-1.5 whitespace-nowrap">{formatDateTime(o.opened_at)}</td>
                            <td className="px-2 py-1.5">{o.country ?? "—"}</td>
                            <td className="px-2 py-1.5">{o.device ?? "—"}</td>
                            <td className="px-2 py-1.5">{o.browser ?? "—"}</td>
                            <td className="px-2 py-1.5 font-mono text-[11px]">{o.ip ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            {(historyQ.data?.events.length ?? 0) > 0 && (
              <>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setShowHistory((v) => !v)}
                >
                  {showHistory ? "Hide" : "Show"} link history ({historyQ.data!.events.length})
                </button>
                {showHistory && (
                  <ol className="space-y-2 text-xs">
                    {historyQ.data!.events.map((ev) => (
                      <li key={ev.id} className="border-l-2 border-border pl-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-2 text-muted-foreground">
                          <span className="font-medium text-foreground">{ev.actor_name ?? ev.actor_email ?? "Admin"}</span>
                          <span>{formatDateTime(ev.occurred_at)}</span>
                        </div>
                        {ev.event_type === "extended" ? (
                          <p className="mt-1">
                            Extended by <span className="font-medium">{ev.metadata.days_added} days</span>
                            {ev.metadata.new_expires_at && <> · new expiry {formatDate(ev.metadata.new_expires_at)}</>}
                          </p>
                        ) : (
                          <p className="mt-1">{ev.event_type}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Change requests workflow */}
      {!isAdmin && (
        <Card>
          <CardHeader><CardTitle className="text-base">Request a change</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">Only admins can change job data. Submit a request and an admin will approve or reject it.</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select value={reqField} onChange={(e) => { setReqField(e.target.value as any); setReqValue(""); }} className="rounded border border-input bg-background px-2 py-2 text-sm">
                <option value="sla_deadline">SLA deadline</option>
                <option value="status">Status</option>
                <option value="notes">Notes</option>
              </select>
              {reqField === "status" ? (
                <select value={reqValue} onChange={(e) => setReqValue(e.target.value)} className="rounded border border-input bg-background px-2 py-2 text-sm sm:col-span-2">
                  <option value="">— Select status —</option>
                  {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : reqField === "sla_deadline" ? (
                <input type="date" value={reqValue} onChange={(e) => setReqValue(e.target.value)} className="rounded border border-input bg-background px-2 py-2 text-sm sm:col-span-2" />
              ) : (
                <Textarea value={reqValue} onChange={(e) => setReqValue(e.target.value)} rows={2} className="sm:col-span-2" placeholder="New notes" />
              )}
            </div>
            <Textarea value={reqReason} onChange={(e) => setReqReason(e.target.value)} rows={2} placeholder="Reason (optional)" />
            <Button size="sm" onClick={() => submitRequest.mutate()} disabled={!reqValue || submitRequest.isPending}>
              {submitRequest.isPending ? "Submitting…" : "Submit request"}
            </Button>
          </CardContent>
        </Card>
      )}

      {(requestsQ.data?.requests.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Change requests</CardTitle></CardHeader>
          <CardContent>
            <ol className="space-y-3 text-sm">
              {requestsQ.data!.requests.map((r) => (
                <li key={r.id} className="border-l-2 border-border pl-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{r.requester_name ?? r.requester_email ?? "Partner"}</span>
                    <span>{formatDateTime(r.created_at)}</span>
                  </div>
                  <p className="mt-1">
                    <span className="font-medium">{r.field_name}</span>: {r.current_value || "—"} → <span className="font-medium">{r.requested_value || "—"}</span>
                    {" "}<span className="text-xs text-muted-foreground">[{r.status}]</span>
                  </p>
                  {r.reason && <p className="mt-1 text-xs text-muted-foreground">Reason: {r.reason}</p>}
                  {r.decision_note && <p className="mt-1 text-xs text-muted-foreground">Admin: {r.decision_note}</p>}
                  {r.status === "pending" && isAdmin && (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => decideRequest.mutate({ id: r.id, decision: "approved" })} disabled={decideRequest.isPending}>Approve</Button>
                      <Button size="sm" variant="outline" onClick={() => decideRequest.mutate({ id: r.id, decision: "rejected" })} disabled={decideRequest.isPending}>Reject</Button>
                    </div>
                  )}
                  {r.status === "pending" && !isAdmin && (
                    <Button size="sm" variant="ghost" className="mt-2" onClick={() => cancelRequest.mutate(r.id)}>Cancel</Button>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}