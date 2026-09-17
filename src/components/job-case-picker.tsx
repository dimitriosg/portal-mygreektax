import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listClientCases, openCase } from "@/lib/cases.functions";
import { getErrorMessage } from "@/lib/auth-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Choose which case a new job belongs to, and open a new one without leaving
// the form. Used by both job-creation paths: the client dialog on /leads and
// the admin jobs page.
//
// One case is preselected, because there is only one answer. With several there
// is deliberately no default -- guessing which case a job belongs to is exactly
// the judgement this design refuses to make on a person's behalf.
//
// The query key matches the one the /leads cases block uses, so opening a case
// here refreshes that list too and neither view goes stale.
export function JobCasePicker({
  clientId,
  value,
  onChange,
  disabled,
}: {
  /** Empty while no client is chosen yet; the picker waits rather than guessing. */
  clientId: string;
  value: string;
  onChange: (caseId: string) => void;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const fetchCases = useServerFn(listClientCases);
  const createCase = useServerFn(openCase);

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const casesQ = useQuery({
    queryKey: ["leads", "cases", clientId],
    queryFn: () => fetchCases({ data: { clientId } }),
    enabled: Boolean(clientId),
  });
  const cases = casesQ.data?.cases ?? [];

  // Preselect the only case there is. Deliberately does not fire when there
  // are several. Depends on the id rather than the array, which is rebuilt on
  // every render and would re-run this effect every time.
  const onlyCaseId = cases.length === 1 ? cases[0].id : null;
  useEffect(() => {
    if (!value && onlyCaseId) onChange(onlyCaseId);
  }, [onlyCaseId, value, onChange]);

  // A case selected for one client must not survive a switch to another.
  useEffect(() => {
    setAdding(false);
    setTitle("");
  }, [clientId]);

  const openCaseMut = useMutation({
    mutationFn: (vars: { clientId: string; title?: string }) => createCase({ data: vars }),
    onSuccess: async (result, submittedFor) => {
      toast.success(`Case ${result.caseSerialId ?? "created"} opened`);
      setAdding(false);
      setTitle("");
      // Refresh the list for the client the case was actually created under,
      // which is not necessarily the one on screen now.
      await qc.invalidateQueries({ queryKey: ["leads", "cases", submittedFor.clientId] });

      // Only select it if the picker still represents that client. onSuccess is
      // rebuilt on every render, so it closes over the CURRENT clientId while
      // result.caseId belongs to the one the request was sent for: switching
      // client mid-request would otherwise write the old client's case into the
      // new client's form. assign_job_to_case would refuse it at save time, but
      // that is an avoidable error presented to a person who did nothing wrong.
      if (submittedFor.clientId !== clientId) return;
      onChange(result.caseId);
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const submitNewCase = () => openCaseMut.mutate({ clientId, title: title.trim() || undefined });

  if (!clientId) {
    return (
      <div className="space-y-1">
        <Label>Case</Label>
        <div className="rounded border border-input bg-muted/30 px-2 py-2 text-sm text-muted-foreground">
          Choose a client first.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label>Case</Label>
        {!adding && (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setAdding(true)}
          >
            + New case
          </button>
        )}
      </div>

      {casesQ.isLoading ? (
        <div className="rounded border border-input bg-muted/30 px-2 py-2 text-sm text-muted-foreground">
          Loading cases…
        </div>
      ) : casesQ.error ? (
        <div className="rounded border border-destructive/50 px-2 py-2 text-sm text-destructive">
          {getErrorMessage(casesQ.error)}
        </div>
      ) : (
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-input bg-background px-2 py-2 text-sm"
        >
          <option value="">
            {cases.length === 0 ? "— No cases yet, create one —" : "— Select case —"}
          </option>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.caseSerialId ?? `Case ${c.caseNumber ?? "?"}`}
              {c.title ? ` — ${c.title}` : ""}
              {c.stage ? ` · ${c.stage}` : ""}
            </option>
          ))}
        </select>
      )}

      {adding && (
        <div className="mt-1 flex items-center gap-1 rounded border border-border bg-muted/20 p-2">
          <Input
            autoFocus
            value={title}
            placeholder="What is the new case about? (optional)"
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !openCaseMut.isPending) {
                e.preventDefault();
                submitNewCase();
              }
              if (e.key === "Escape") {
                setAdding(false);
                setTitle("");
              }
            }}
            className="h-8 text-xs"
          />
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            disabled={openCaseMut.isPending}
            onClick={submitNewCase}
          >
            {openCaseMut.isPending ? "Opening…" : "Create"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 px-2 text-xs"
            onClick={() => {
              setAdding(false);
              setTitle("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
