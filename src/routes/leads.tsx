import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { listLeads, updateLead } from "@/lib/leads.functions";
import { listClients, listJobs } from "@/lib/jobs.functions";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { LEAD_STAGES, LEAD_STATUSES, LEAD_URGENCY_OPTIONS } from "@/lib/leads-shared";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import type { AirtableRecord, LeadFields, ClientFields, JobFields } from "@/lib/airtable.server";

export const Route = createFileRoute("/leads")({ component: LeadsPage });

// Color coding per stage — used for column headers, the stage select, and badges
// so a stage is recognizable at a glance across both views.
const STAGE_STYLES: Record<string, string> = {
  New: "border-sky-300 bg-sky-100 text-sky-900",
  Contacted: "border-amber-300 bg-amber-100 text-amber-900",
  Qualified: "border-teal-300 bg-teal-100 text-teal-900",
  Quoted: "border-orange-300 bg-orange-100 text-orange-900",
  Won: "border-green-300 bg-green-100 text-green-900",
  Lost: "border-destructive/30 bg-destructive/10 text-destructive",
};

const STAGE_DOT: Record<string, string> = {
  New: "bg-sky-500",
  Contacted: "bg-amber-500",
  Qualified: "bg-teal-500",
  Quoted: "bg-orange-500",
  Won: "bg-green-500",
  Lost: "bg-destructive",
};

function stageStyle(stage?: string | null) {
  return (stage && STAGE_STYLES[stage]) || "bg-muted text-muted-foreground border-border";
}

function StageBadge({ stage }: { stage?: string | null }) {
  return <Badge className={`font-medium hover:opacity-100 ${stageStyle(stage)}`}>{stage ?? "—"}</Badge>;
}

type Lead = AirtableRecord<LeadFields>;
type Client = AirtableRecord<ClientFields>;
type Job = AirtableRecord<JobFields>;

function leadValueLabel(value?: number | null) {
  if (value === undefined || value === null) return "—";
  return `€${value.toLocaleString("en-IE")}`;
}

function LeadsPage() {
  const { user, loading, sessionReady, isAdmin } = useAuth();
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

  const fetchLeads = useServerFn(listLeads);
  const updateLeadFn = useServerFn(updateLead);
  const fetchClients = useServerFn(listClients);
  const fetchJobs = useServerFn(listJobs);
  const qc = useQueryClient();

  const leadsQ = useQuery({
    queryKey: ["leads", "admin"],
    queryFn: () => fetchLeads(),
    enabled: !!isAdmin && sessionReady,
  });
  const clientsQ = useQuery({
    queryKey: ["clients"],
    queryFn: () => fetchClients(),
    enabled: !!isAdmin && sessionReady,
  });
  const jobsQ = useQuery({
    queryKey: ["jobs", "admin"],
    queryFn: () => fetchJobs(),
    enabled: !!isAdmin && sessionReady,
  });

  useEffect(() => {
    const authError = [leadsQ.error, clientsQ.error, jobsQ.error].find(isAuthSessionError);
    if (authError) navigate({ to: "/login", replace: true });
  }, [leadsQ.error, clientsQ.error, jobsQ.error, navigate]);

  const handleMutationError = (error: unknown) => {
    if (isAuthSessionError(error)) {
      navigate({ to: "/login", replace: true });
      return;
    }
    toast.error(getErrorMessage(error));
  };

  const update = useMutation({
    mutationFn: (vars: Parameters<typeof updateLeadFn>[0]["data"]) =>
      updateLeadFn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: handleMutationError,
  });

  const leads = leadsQ.data?.leads ?? [];
  const clients = clientsQ.data?.clients ?? [];
  const jobs = jobsQ.data?.jobs ?? [];

  // Lead -> Client -> Jobs linkage. The CRM<->Ops sync writes Leads."Ops Client
  // Record ID" automatically once a lead converts; we only ever read it here.
  const clientsById = useMemo(() => {
    const map = new Map<string, Client>();
    for (const c of clients) map.set(c.id, c);
    return map;
  }, [clients]);

  const jobsByClientId = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const job of jobs) {
      for (const clientId of job.fields.Client ?? []) {
        if (!map.has(clientId)) map.set(clientId, []);
        map.get(clientId)!.push(job);
      }
    }
    return map;
  }, [jobs]);

  function getLinkedClient(lead: Lead): Client | undefined {
    const clientId = lead.fields["Ops Client Record ID"];
    return clientId ? clientsById.get(clientId) : undefined;
  }

  const [view, setView] = useState<"board" | "list">("board");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("");
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set());

  const toggleCollapsed = (stage: string) =>
    setCollapsedStages((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });

  const filteredLeads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (stageFilter && (lead.fields.Stage ?? "") !== stageFilter) return false;
      if (!q) return true;
      const haystack = [
        lead.fields["Lead Name"],
        lead.fields.Email,
        lead.fields.Company,
        lead.fields.Phone,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [leads, search, stageFilter]);

  const leadsByStage = useMemo(() => {
    const map = new Map<string, Lead[]>();
    for (const stage of LEAD_STAGES) map.set(stage, []);
    for (const lead of filteredLeads) {
      const stage = lead.fields.Stage ?? "New";
      if (!map.has(stage)) map.set(stage, []);
      map.get(stage)!.push(lead);
    }
    return map;
  }, [filteredLeads]);

  if (!isAdmin) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Lead Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Internal view — edits here write straight back to the CRM Airtable base.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border p-1 text-sm">
          <button
            onClick={() => setView("board")}
            className={`rounded px-3 py-1 ${view === "board" ? "bg-muted font-medium" : "text-muted-foreground"}`}
          >
            Board
          </button>
          <button
            onClick={() => setView("list")}
            className={`rounded px-3 py-1 ${view === "list" ? "bg-muted font-medium" : "text-muted-foreground"}`}
          >
            List by status
          </button>
        </div>
      </div>

      {leadsQ.error && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">
            {getErrorMessage(leadsQ.error)}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name, email, company…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-64"
        />
        {view === "list" && (
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="rounded border border-input bg-background px-2 py-2 text-sm"
          >
            <option value="">All statuses</option>
            {LEAD_STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>

      {leadsQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading leads…</p>
      ) : view === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {LEAD_STAGES.map((stage) => {
            const stageLeads = leadsByStage.get(stage) ?? [];
            const collapsed = collapsedStages.has(stage);
            if (collapsed) {
              return (
                <button
                  key={stage}
                  onClick={() => toggleCollapsed(stage)}
                  title={`Expand ${stage}`}
                  className={`flex w-10 shrink-0 flex-col items-center gap-2 rounded-md border px-1 py-2 ${stageStyle(stage)}`}
                  style={{ minHeight: 240 }}
                >
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  <span className="shrink-0 rounded-full bg-background/70 px-1.5 text-[10px]">
                    {stageLeads.length}
                  </span>
                  <span
                    className="mt-1 flex-1 text-xs font-semibold uppercase tracking-wide"
                    style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
                  >
                    {stage}
                  </span>
                </button>
              );
            }
            return (
              <div key={stage} className="min-w-[260px] max-w-[280px] flex-1">
                <button
                  onClick={() => toggleCollapsed(stage)}
                  className={`mb-2 flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-xs font-semibold uppercase tracking-wide ${stageStyle(stage)}`}
                  title={`Collapse ${stage}`}
                >
                  <span className="flex items-center gap-1.5">
                    <ChevronDown className="h-3.5 w-3.5" />
                    {stage}
                  </span>
                  <span className="rounded-full bg-background/70 px-2 py-0.5 text-[10px] normal-case">
                    {stageLeads.length}
                  </span>
                </button>
                <div className="space-y-2">
                    {stageLeads.map((lead) => {
                      const client = getLinkedClient(lead);
                      return (
                        <Card
                          key={lead.id}
                          className={`cursor-pointer border-l-4 transition-shadow hover:shadow-md ${stageStyle(stage).split(" ")[0]}`}
                          onClick={() => setEditingLead(lead)}
                        >
                          <CardContent className="space-y-2 py-3">
                            <div className="font-medium leading-tight">
                              {lead.fields["Lead Name"] ?? "—"}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {lead.fields.Email ?? "—"}
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">
                                {lead.fields.Urgency ?? "—"}
                              </span>
                              <span className="font-medium">
                                {leadValueLabel(lead.fields["Lead value"])}
                              </span>
                            </div>
                            {client && (
                              <div className="truncate text-xs text-muted-foreground">
                                Client: {client.fields["Client Code"] ?? client.fields["Full Name"]}
                              </div>
                            )}
                            <select
                              value={lead.fields.Stage ?? ""}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                e.stopPropagation();
                                update.mutate({ leadId: lead.id, stage: e.target.value });
                              }}
                              className={`w-full rounded border px-2 py-1 text-xs ${stageStyle(lead.fields.Stage)}`}
                            >
                              {LEAD_STAGES.map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                            </select>
                          </CardContent>
                        </Card>
                      );
                    })}
                    {stageLeads.length === 0 && (
                      <p className="px-1 text-xs text-muted-foreground">No leads</p>
                    )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2">Lead status</th>
                <th className="px-3 py-2">Urgency</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">Client / Jobs</th>
                <th className="px-3 py-2">Next action</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(stageFilter ? [stageFilter] : LEAD_STAGES).map((stage) => {
                const stageLeads = leadsByStage.get(stage) ?? [];
                if (stageLeads.length === 0) return null;
                const collapsed = collapsedStages.has(stage);
                return (
                  <>
                    {!stageFilter && (
                      <tr key={`${stage}-hdr`}>
                        <td colSpan={9} className="p-0">
                          <button
                            onClick={() => toggleCollapsed(stage)}
                            className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-semibold uppercase ${stageStyle(stage)}`}
                          >
                            {collapsed ? (
                              <ChevronRight className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )}
                            {stage} · {stageLeads.length}
                          </button>
                        </td>
                      </tr>
                    )}
                    {!collapsed &&
                      stageLeads.map((lead) => {
                        const client = getLinkedClient(lead);
                        const clientJobs = client ? jobsByClientId.get(client.id) ?? [] : [];
                        return (
                          <tr key={lead.id} className="border-t border-border">
                            <td className="px-3 py-2 font-medium">
                              {lead.fields["Lead Name"] ?? "—"}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {lead.fields.Email ?? "—"}
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={lead.fields.Stage ?? ""}
                                onChange={(e) =>
                                  update.mutate({ leadId: lead.id, stage: e.target.value })
                                }
                                className={`rounded border px-2 py-1 text-xs ${stageStyle(lead.fields.Stage)}`}
                              >
                                {LEAD_STAGES.map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2">
                              <StageBadge stage={lead.fields["Lead status"]} />
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {lead.fields.Urgency ?? "—"}
                            </td>
                            <td className="px-3 py-2">{leadValueLabel(lead.fields["Lead value"])}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {client ? (
                                <div className="space-y-0.5">
                                  <div className="font-medium text-foreground">
                                    {client.fields["Client Code"] ?? client.fields["Full Name"]}
                                  </div>
                                  {clientJobs.length > 0 ? (
                                    <div>
                                      {clientJobs
                                        .map((j) => `${j.fields["Job Code"] ?? "Job"} (${j.fields.Status ?? "—"})`)
                                        .join(", ")}
                                    </div>
                                  ) : (
                                    <div>No jobs yet</div>
                                  )}
                                </div>
                              ) : (
                                "Not linked"
                              )}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {formatDate(lead.fields["Next action date"])}
                            </td>
                            <td className="px-3 py-2">
                              <Button size="sm" variant="outline" onClick={() => setEditingLead(lead)}>
                                Edit
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editingLead && (
        <LeadEditDialog
          lead={editingLead}
          client={getLinkedClient(editingLead)}
          clientJobs={(() => {
            const client = getLinkedClient(editingLead);
            return client ? jobsByClientId.get(client.id) ?? [] : [];
          })()}
          onClose={() => setEditingLead(null)}
          onSave={(vars) =>
            update.mutate(
              { leadId: editingLead.id, ...vars },
              { onSuccess: () => setEditingLead(null) },
            )
          }
          saving={update.isPending}
        />
      )}
    </div>
  );
}

function LeadEditDialog({
  lead,
  client,
  clientJobs,
  onClose,
  onSave,
  saving,
}: {
  lead: Lead;
  client?: Client;
  clientJobs: Job[];
  onClose: () => void;
  onSave: (vars: {
    stage?: string;
    leadStatus?: string;
    urgency?: string;
    leadValue?: number | null;
    notes?: string;
    lostReason?: string;
  }) => void;
  saving: boolean;
}) {
  const [stage, setStage] = useState(lead.fields.Stage ?? "New");
  const [leadStatus, setLeadStatus] = useState(lead.fields["Lead status"] ?? "New");
  const [urgency, setUrgency] = useState(lead.fields.Urgency ?? "");
  const [leadValue, setLeadValue] = useState(
    lead.fields["Lead value"] !== undefined ? String(lead.fields["Lead value"]) : "",
  );
  const [notes, setNotes] = useState(lead.fields.Notes ?? "");
  const [lostReason, setLostReason] = useState(lead.fields["Lost reason"] ?? "");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{lead.fields["Lead Name"] ?? "Lead"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            {lead.fields.Email} {lead.fields.Phone ? `· ${lead.fields.Phone}` : ""}
          </div>
          {lead.fields.Situation && (
            <div className="rounded bg-muted/40 p-2 text-xs text-muted-foreground">
              {lead.fields.Situation}
            </div>
          )}

          <div className="rounded border border-border bg-muted/20 p-2 text-xs">
            <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
              Linked client &amp; jobs
            </div>
            {client ? (
              <div className="space-y-1">
                <div>
                  <span className="font-medium">{client.fields["Client Code"] ?? "—"}</span>{" "}
                  {client.fields["Full Name"]}
                </div>
                {clientJobs.length > 0 ? (
                  <ul className="space-y-0.5">
                    {clientJobs.map((j) => (
                      <li key={j.id}>
                        {j.fields["Job Code"] ?? j.id} — {j.fields.Status ?? "—"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted-foreground">No jobs created yet.</div>
                )}
              </div>
            ) : (
              <div className="text-muted-foreground">
                Not linked yet — the CRM↔Ops sync links this automatically once the lead
                converts to a client.
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Stage</Label>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                className={`mt-1 w-full rounded border px-2 py-2 text-sm ${stageStyle(stage)}`}
              >
                {LEAD_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Lead status</Label>
              <select
                value={leadStatus}
                onChange={(e) => setLeadStatus(e.target.value)}
                className="mt-1 w-full rounded border border-input bg-background px-2 py-2 text-sm"
              >
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Urgency</Label>
              <select
                value={urgency}
                onChange={(e) => setUrgency(e.target.value)}
                className="mt-1 w-full rounded border border-input bg-background px-2 py-2 text-sm"
              >
                <option value="">—</option>
                {LEAD_URGENCY_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Lead value (€)</Label>
              <Input
                type="number"
                min={0}
                value={leadValue}
                onChange={(e) => setLeadValue(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          {stage === "Lost" && (
            <div>
              <Label>Lost reason</Label>
              <Input
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                className="mt-1"
              />
            </div>
          )}
          <div>
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 min-h-[100px]"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() =>
              onSave({
                stage,
                leadStatus,
                urgency: urgency || undefined,
                leadValue: leadValue === "" ? null : Number(leadValue),
                notes,
                lostReason: stage === "Lost" ? lostReason : undefined,
              })
            }
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
