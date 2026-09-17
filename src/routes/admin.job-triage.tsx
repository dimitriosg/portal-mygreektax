import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  assignJobToCase,
  listUnfiledJobs,
  listClientCases,
  type UnfiledClientGroup,
  type UnfiledJob,
} from "@/lib/cases.functions";
import { getErrorMessage } from "@/lib/auth-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { stageBadgeClass } from "@/lib/stage-colors";
import { formatDate } from "@/lib/utils";

export const Route = createFileRoute("/admin/job-triage")({
  component: JobTriagePage,
});

// Job triage.
//
// Every job that has no case, grouped by client, with a File button per job.
//
// Grouped by client because the client is what decides where a job can go. Of
// the jobs with no case today, none belongs to a client with more than one
// case: almost every row is either "there is exactly one case, confirm it" or
// "there is no case yet, so open one first". A flat list of jobs would bury
// the only fact that matters.
//
// There is deliberately NO bulk action. "A person confirms every assignment,
// including where the evidence looks unambiguous" is a rule of this system, and
// one button that files twenty jobs is not twenty confirmations. The grouping
// is what makes it quick; the clicking is what makes it deliberate.
//
// The reason is optional, per the same decision taken for the /leads move
// control: demanding one for an obvious filing just trains people to type "x".

const CANCELLED = "Cancelled / NMF";

function JobRow({
  job,
  group,
  onFiled,
}: {
  job: UnfiledJob;
  group: UnfiledClientGroup;
  onFiled: () => void;
}) {
  const assign = useServerFn(assignJobToCase);
  const fetchCases = useServerFn(listClientCases);
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState("");

  // Only fetched when the client has a real choice to make. With one case there
  // is nothing to pick, and with none there is nothing to pick from.
  const casesQ = useQuery({
    queryKey: ["leads", "cases", group.clientId],
    queryFn: () => fetchCases({ data: { clientId: group.clientId } }),
    enabled: group.liveCases > 1,
  });

  const mut = useMutation({
    mutationFn: (vars: { jobId: string; caseId: string; reason?: string }) =>
      assign({ data: vars }),
    onSuccess: (result) => {
      toast.success(
        result.unchanged ? `${job.jobCode} was already filed there` : `${job.jobCode} filed`,
      );
      onFiled();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const targetCaseId = group.liveCases === 1 ? group.onlyCaseId : picked || null;

  const file = () => {
    if (!targetCaseId) return;
    mut.mutate({ jobId: job.jobId, caseId: targetCaseId, reason: reason.trim() || undefined });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5 text-xs">
      <span className="font-mono font-medium">{job.jobCode}</span>
      <span
        className={
          job.status === CANCELLED ? "text-muted-foreground line-through" : "text-muted-foreground"
        }
      >
        {job.status ?? "—"}
      </span>
      {job.serviceName ? <span className="text-muted-foreground">{job.serviceName}</span> : null}
      {job.dateSent ? (
        <span className="text-muted-foreground">{formatDate(job.dateSent)}</span>
      ) : null}
      {job.clientFee != null ? (
        <span className="text-muted-foreground">€{job.clientFee}</span>
      ) : null}

      {/* Code evidence, where any exists. Shown as a suggestion and nothing
          more -- it never preselects and never files. Two codes on one job is
          a conflict for a person to settle, not something to average out. */}
      {job.evidenceCodes.length > 0 ? (
        <span
          className={`rounded border px-1.5 py-0.5 text-[11px] ${
            job.evidenceCodes.length > 1
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-border text-muted-foreground"
          }`}
          title={`Seen in: ${job.evidenceSources.join(", ")}`}
        >
          {job.evidenceCodes.length > 1 ? "conflicting: " : "seen as "}
          {job.evidenceCodes.join(" / ")}
        </span>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-1">
        {group.liveCases === 0 ? (
          <span className="text-muted-foreground">needs a case first</span>
        ) : (
          <>
            {group.liveCases > 1 && (
              <select
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
                // 16px on mobile, compact from sm up: iOS Safari zooms the page
                // when a control under 16px takes focus, and this one is the
                // single place on the screen where a real choice gets made.
                className="rounded border border-input bg-background px-1.5 py-1 text-base sm:text-xs"
                aria-label={`Case for ${job.jobCode ?? "this job"}`}
              >
                <option value="">— Which case? —</option>
                {(casesQ.data?.cases ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.caseSerialId ?? c.id}
                    {c.title ? ` — ${c.title}` : ""}
                  </option>
                ))}
              </select>
            )}
            <Input
              value={reason}
              placeholder="Why? (optional)"
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !mut.isPending && targetCaseId) {
                  e.preventDefault();
                  file();
                }
              }}
              className="h-7 w-44 text-xs"
            />
            <Button
              size="sm"
              className="h-7 shrink-0 px-2 text-xs"
              disabled={mut.isPending || !targetCaseId}
              onClick={file}
            >
              {mut.isPending
                ? "Filing…"
                : group.liveCases === 1
                  ? `File into ${shortCode(group.onlyCaseSerialId)}`
                  : "File"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** MGT-CS002-CLT0039 -> CS002, for a button that has to stay narrow. */
function shortCode(serial: string | null): string {
  if (!serial) return "the case";
  const m = serial.match(/(CS\d+)/);
  return m ? m[1] : serial;
}

function ClientGroup({ group, onFiled }: { group: UnfiledClientGroup; onFiled: () => void }) {
  return (
    <div className="space-y-1.5 rounded border border-border bg-muted/20 p-2">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-medium">{group.clientCode}</span>
        {group.clientName ? (
          <span className="text-muted-foreground">{group.clientName}</span>
        ) : null}
        {group.clientStage ? (
          <span
            className={`rounded border px-1.5 py-0.5 text-[11px] ${stageBadgeClass(group.clientStage)}`}
          >
            {group.clientStage}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {group.jobs.length} job{group.jobs.length === 1 ? "" : "s"}
        </span>
        {group.liveCases === 0 ? (
          <span className="text-amber-600 dark:text-amber-500">
            no case yet —{" "}
            <Link to="/admin/case-proposals" className="underline">
              open one
            </Link>
          </span>
        ) : group.liveCases === 1 ? (
          <span className="text-muted-foreground">
            one case: <span className="font-mono">{group.onlyCaseSerialId}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{group.liveCases} cases — pick per job</span>
        )}
      </div>

      {group.jobs.map((job) => (
        <JobRow key={job.jobId} job={job} group={group} onFiled={onFiled} />
      ))}
    </div>
  );
}

function JobTriagePage() {
  const qc = useQueryClient();
  const fetchUnfiled = useServerFn(listUnfiledJobs);
  const [hideCancelled, setHideCancelled] = useState(true);

  const q = useQuery({
    queryKey: ["cases", "unfiled-jobs"],
    queryFn: () => fetchUnfiled(),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["cases", "unfiled-jobs"] });
    void qc.invalidateQueries({ queryKey: ["leads"] });
    void qc.invalidateQueries({ queryKey: ["jobs"] });
  };

  const allGroups = q.data?.groups ?? [];
  const cancelledCount = allGroups.reduce(
    (n, g) => n + g.jobs.filter((j) => j.status === CANCELLED).length,
    0,
  );

  // Cancelled jobs still need a case eventually — the end state is zero jobs
  // without one — but they are the least useful place to start, so they are out
  // of the way by default rather than absent.
  const groups = hideCancelled
    ? allGroups
        .map((g) => ({ ...g, jobs: g.jobs.filter((j) => j.status !== CANCELLED) }))
        .filter((g) => g.jobs.length > 0)
    : allGroups;

  const shown = groups.reduce((n, g) => n + g.jobs.length, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Job triage</h1>
          <p className="text-sm text-muted-foreground">
            Jobs with no case, grouped by client. Nothing is filed until you press File, one job at
            a time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link to="/admin/case-proposals">Case proposals</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin">Admin</Link>
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : q.error ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            {getErrorMessage(q.error)}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-sm">
              <span>
                <span className="font-semibold">{q.data?.jobCount ?? 0}</span> without a case
              </span>
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{q.data?.readyCount ?? 0}</span>{" "}
                ready to file
              </span>
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground">{q.data?.blockedCount ?? 0}</span>{" "}
                waiting on a case being opened
              </span>
              {cancelledCount > 0 && (
                <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={hideCancelled}
                    onChange={(e) => setHideCancelled(e.target.checked)}
                  />
                  Hide cancelled ({cancelledCount})
                </label>
              )}
            </CardContent>
          </Card>

          {groups.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                {allGroups.length === 0
                  ? "Every job is filed under a case."
                  : "Nothing left once cancelled jobs are hidden."}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                Showing {shown} job{shown === 1 ? "" : "s"} across {groups.length} client
                {groups.length === 1 ? "" : "s"}.
              </div>
              <div className="space-y-2">
                {groups.map((g) => (
                  <ClientGroup key={g.clientId} group={g} onFiled={refresh} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
