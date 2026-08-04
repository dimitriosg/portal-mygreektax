import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { listAccountants, listServices, updateJob } from "@/lib/jobs.functions";
import { JOB_STATUSES, NEXT_ACTION_OPTIONS } from "@/lib/airtable-shared";
import type { AirtableRecord, JobFields } from "@/lib/airtable.server";
import { StatusBadge } from "@/lib/badges";

type Job = AirtableRecord<JobFields>;

function euroField(value?: number | null) {
  return value !== undefined && value !== null ? String(value) : "";
}

// Quick-edit pop-up for a job, opened from the pipeline so a job can be
// updated without leaving /leads. Tracking links, events and change requests
// stay on the full job page, linked below.
export function JobEditDialog({ job, onClose }: { job: Job; onClose: () => void }) {
  const qc = useQueryClient();
  const updateFn = useServerFn(updateJob);
  const servicesFn = useServerFn(listServices);
  const accountantsFn = useServerFn(listAccountants);

  const servicesQ = useQuery({
    queryKey: ["services"],
    queryFn: () => servicesFn(),
  });
  const accQ = useQuery({
    queryKey: ["accountants"],
    queryFn: () => accountantsFn(),
  });

  const previous = useMemo(
    () => ({
      status: job.fields.Status ?? "To Assign",
      nextAction: job.fields["Next Action Needed"] ?? "",
      slaDeadline: job.fields["SLA Deadline"]?.slice(0, 10) ?? "",
      dateSent: job.fields["Date Sent"]?.slice(0, 10) ?? "",
      clientFee: euroField(job.fields["Client Fee (€)"]),
      accountantFee: euroField(job.fields["Accountant Fee (€)"]),
      serviceId: job.fields["Service Catalog"]?.[0] ?? "",
      accountantId: job.fields["Assigned Accountant"]?.[0] ?? "",
      adminInternalNotes: job.fields["Admin Internal Notes"] ?? "",
      partnerProgressNotes: job.fields["Partner Progress Notes"] ?? "",
      clientVisibleNote: job.fields["Client Visible Note"] ?? "",
    }),
    [job],
  );

  const [status, setStatus] = useState(previous.status);
  const [nextAction, setNextAction] = useState(previous.nextAction);
  const [slaDeadline, setSlaDeadline] = useState(previous.slaDeadline);
  const [dateSent, setDateSent] = useState(previous.dateSent);
  const [clientFee, setClientFee] = useState(previous.clientFee);
  const [accountantFee, setAccountantFee] = useState(previous.accountantFee);
  const [serviceId, setServiceId] = useState(previous.serviceId);
  const [accountantId, setAccountantId] = useState(previous.accountantId);
  const [adminInternalNotes, setAdminInternalNotes] = useState(previous.adminInternalNotes);
  const [partnerProgressNotes, setPartnerProgressNotes] = useState(previous.partnerProgressNotes);
  const [clientVisibleNote, setClientVisibleNote] = useState(previous.clientVisibleNote);

  const save = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          jobId: job.id,
          status:
            status !== previous.status ? (status as (typeof JOB_STATUSES)[number]) : undefined,
          nextActionNeeded:
            nextAction && nextAction !== previous.nextAction
              ? (nextAction as (typeof NEXT_ACTION_OPTIONS)[number])
              : undefined,
          slaDeadline: slaDeadline !== previous.slaDeadline ? slaDeadline || null : undefined,
          dateSent: dateSent !== previous.dateSent ? dateSent || null : undefined,
          clientFee:
            clientFee !== previous.clientFee
              ? clientFee === ""
                ? null
                : Number(clientFee)
              : undefined,
          accountantFee:
            accountantFee !== previous.accountantFee
              ? accountantFee === ""
                ? null
                : Number(accountantFee)
              : undefined,
          serviceId: serviceId && serviceId !== previous.serviceId ? serviceId : undefined,
          accountantId: accountantId !== previous.accountantId ? accountantId || null : undefined,
          adminInternalNotes:
            adminInternalNotes !== previous.adminInternalNotes ? adminInternalNotes : undefined,
          partnerProgressNotes:
            partnerProgressNotes !== previous.partnerProgressNotes
              ? partnerProgressNotes
              : undefined,
          clientVisibleNote:
            clientVisibleNote !== previous.clientVisibleNote ? clientVisibleNote : undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Job updated");
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["job", job.id] });
      // A status change can move the client's stage (job→stage sync trigger).
      qc.invalidateQueries({ queryKey: ["leads"] });
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to update job");
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>{job.fields["Job Code"] ?? "Job"}</DialogTitle>
            <StatusBadge status={job.fields.Status} />
          </div>
          <div className="text-xs text-muted-foreground">
            {job.fields["Service Name"] ?? "—"}
            {" · "}
            <Link
              to="/jobs/$jobId"
              params={{ jobId: job.id }}
              className="text-primary hover:underline"
            >
              Open full job page →
            </Link>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Status</Label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {JOB_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Next action needed</Label>
              <select
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">—</option>
                {NEXT_ACTION_OPTIONS.map((s) => (
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
                value={slaDeadline}
                onChange={(e) => setSlaDeadline(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Date sent</Label>
              <Input type="date" value={dateSent} onChange={(e) => setDateSent(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Client fee (€)</Label>
              <Input
                type="number"
                min="0"
                value={clientFee}
                onChange={(e) => setClientFee(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Accountant fee (€)</Label>
              <Input
                type="number"
                min="0"
                value={accountantFee}
                onChange={(e) => setAccountantFee(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Service</Label>
              <select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  — Select service —
                </option>
                {(servicesQ.data?.services ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.code || s.id}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Assigned accountant</Label>
              <select
                value={accountantId}
                onChange={(e) => setAccountantId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">— Unassigned —</option>
                {(accQ.data?.accountants ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fields.Name ?? a.id}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Admin internal notes</Label>
            <Textarea
              value={adminInternalNotes}
              onChange={(e) => setAdminInternalNotes(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-1">
            <Label>Partner progress notes</Label>
            <Textarea
              value={partnerProgressNotes}
              onChange={(e) => setPartnerProgressNotes(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-1">
            <Label>Client visible note</Label>
            <Textarea
              value={clientVisibleNote}
              onChange={(e) => setClientVisibleNote(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
