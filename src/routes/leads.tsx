import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, AlertTriangle } from "lucide-react";
import { listLeads, updateLead, createLead, listLeadThread } from "@/lib/leads.functions";
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
import type {
  AirtableRecord,
  LeadFields,
  ClientFields,
  JobFields,
  MessageFields,
  ActivityFields,
} from "@/lib/airtable.server";

export const Route = createFileRoute("/leads")({ component: LeadsPage });

const COLLAPSED_STORAGE_KEY = "mgt-leads-collapsed-stages";

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
  return (
    <Badge className={`font-medium hover:opacity-100 ${stageStyle(stage)}`}>{stage ?? "—"}</Badge>
  );
}

type Lead = AirtableRecord<LeadFields>;
type Client = AirtableRecord<ClientFields>;
type Job = AirtableRecord<JobFields>;

function leadValueLabel(value?: number | null) {
  if (value === undefined || value === null) return "—";
  return `€${value.toLocaleString("en-IE")}`;
}

function isLeadLinked(lead: Lead) {
  return Boolean(lead.fields["Ops Client Record ID"]);
}

const CLOSED_STAGES = new Set(["Won", "Lost"]);

function isOverdue(lead: Lead) {
  const dateStr = lead.fields["Next action date"];
  if (!dateStr) return false;
  if (CLOSED_STAGES.has(lead.fields.Stage ?? "")) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dateStr) < today;
}

function urgencyTextClass(urgency?: string | null) {
  if (urgency === "Within a week") return "font-semibold text-destructive";
  if (urgency === "This month") return "text-amber-700";
  return "text-muted-foreground";
}

function loadCollapsedStages(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

// Sort within a stage so the leads that need attention soonest float to the
// top: leads with an overdue/soonest "Next action date" first, undated leads
// last (sorted by oldest submission so they don't get forgotten either).
function compareLeads(a: Lead, b: Lead) {
  const aNext = a.fields["Next action date"];
  const bNext = b.fields["Next action date"];
  const aTime = aNext ? new Date(aNext).getTime() : Number.POSITIVE_INFINITY;
  const bTime = bNext ? new Date(bNext).getTime() : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  const aSub = a.fields["Submission date"];
  const bSub = b.fields["Submission date"];
  const aSubTime = aSub ? new Date(aSub).getTime() : 0;
  const bSubTime = bSub ? new Date(bSub).getTime() : 0;
  return aSubTime - bSubTime;
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
  const createLeadFn = useServerFn(createLead);
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
    mutationFn: (vars: Parameters<typeof updateLeadFn>[0]["data"]) => updateLeadFn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: handleMutationError,
  });

  const create = useMutation({
    mutationFn: (vars: Parameters<typeof createLeadFn>[0]["data"]) => createLeadFn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Lead added");
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
  const [creatingLead, setCreatingLead] = useState(false);
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(() => loadCollapsedStages());

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_STORAGE_KEY,
        JSON.stringify(Array.from(collapsedStages)),
      );
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }, [collapsedStages]);

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
    for (const arr of map.values()) arr.sort(compareLeads);
    return map;
  }, [filteredLeads]);

  // Pipeline-wide stats — computed off the full unfiltered list so the strip
  // always reflects the whole funnel, not just the current search/filter.
  const stats = useMemo(() => {
    let activeValue = 0;
    let wonCount = 0;
    let overdueCount = 0;
    for (const lead of leads) {
      const stage = lead.fields.Stage ?? "New";
      if (!CLOSED_STAGES.has(stage)) {
        activeValue += lead.fields["Lead value"] ?? 0;
      }
      if (stage === "Won") wonCount += 1;
      if (isOverdue(lead)) overdueCount += 1;
    }
    return { total: leads.length, activeValue, wonCount, overdueCount };
  }, [leads]);

  const errors: Array<{ label: string; error: unknown }> = [
    { label: "Leads", error: leadsQ.error },
    { label: "Clients", error: clientsQ.error },
    { label: "Jobs", error: jobsQ.error },
  ].filter((e) => e.error) as Array<{ label: string; error: unknown }>;

  if (!isAdmin) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Lead Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Internal view — edits here write straight back to the CRM Airtable base. Synced with the
            inbound/outbound CRM automation every ~15 minutes, so very recent emails may take a few
            minutes to show up here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setCreatingLead(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New lead
          </Button>
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
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted-foreground">Total leads</div>
            <div className="text-lg font-semibold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted-foreground">Active pipeline value</div>
            <div className="text-lg font-semibold">{leadValueLabel(stats.activeValue)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted-foreground">Won (all-time)</div>
            <div className="text-lg font-semibold">{stats.wonCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {stats.overdueCount > 0 && <AlertTriangle className="h-3 w-3 text-destructive" />}
              Overdue follow-ups
            </div>
            <div
              className={`text-lg font-semibold ${stats.overdueCount > 0 ? "text-destructive" : ""}`}
            >
              {stats.overdueCount}
            </div>
          </CardContent>
        </Card>
      </div>

      {errors.map(({ label, error }) => (
        <Card key={label}>
          <CardContent className="py-4 text-sm text-destructive">
            {label} failed to load: {getErrorMessage(error)}
          </CardContent>
        </Card>
      ))}

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
                  className={`flex w-10 shrink-0 flex-col items-center justify-start gap-2 rounded-md border px-1 py-2 ${stageStyle(stage)}`}
                  style={{ minHeight: 240 }}
                >
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  <span className="shrink-0 rounded-full bg-background/70 px-1.5 text-[10px]">
                    {stageLeads.length}
                  </span>
                  <span
                    className="mt-1 whitespace-nowrap text-xs font-semibold uppercase tracking-wide"
                    style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
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
                    const linked = isLeadLinked(lead);
                    const overdue = isOverdue(lead);
                    return (
                      <Card
                        key={lead.id}
                        className={`cursor-pointer border-l-4 transition-shadow hover:shadow-md ${stageStyle(stage).split(" ")[0]} ${overdue ? "ring-1 ring-destructive" : ""}`}
                        onClick={() => setEditingLead(lead)}
                      >
                        <CardContent className="space-y-2 py-3">
                          <div className="flex items-center justify-between gap-1">
                            <div className="font-medium leading-tight">
                              {lead.fields["Lead Name"] ?? "—"}
                            </div>
                            {overdue && (
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                            )}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {lead.fields.Email ?? "—"}
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className={urgencyTextClass(lead.fields.Urgency)}>
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
                            disabled={linked}
                            title={linked ? "Managed by the CRM↔Ops sync once linked" : undefined}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation();
                              update.mutate({ leadId: lead.id, stage: e.target.value });
                            }}
                            className={`w-full rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${stageStyle(lead.fields.Stage)}`}
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
                        const clientJobs = client ? (jobsByClientId.get(client.id) ?? []) : [];
                        const linked = isLeadLinked(lead);
                        const overdue = isOverdue(lead);
                        return (
                          <tr
                            key={lead.id}
                            className={`border-t border-border ${overdue ? "bg-destructive/5" : ""}`}
                          >
                            <td className="px-3 py-2 font-medium">
                              {lead.fields["Lead Name"] ?? "—"}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {lead.fields.Email ?? "—"}
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={lead.fields.Stage ?? ""}
                                disabled={linked}
                                title={
                                  linked ? "Managed by the CRM↔Ops sync once linked" : undefined
                                }
                                onChange={(e) =>
                                  update.mutate({ leadId: lead.id, stage: e.target.value })
                                }
                                className={`rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${stageStyle(lead.fields.Stage)}`}
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
                            <td className={`px-3 py-2 ${urgencyTextClass(lead.fields.Urgency)}`}>
                              {lead.fields.Urgency ?? "—"}
                            </td>
                            <td className="px-3 py-2">
                              {leadValueLabel(lead.fields["Lead value"])}
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {client ? (
                                <div className="space-y-0.5">
                                  <div className="font-medium text-foreground">
                                    {client.fields["Client Code"] ?? client.fields["Full Name"]}
                                  </div>
                                  {clientJobs.length > 0 ? (
                                    <div>
                                      {clientJobs
                                        .map(
                                          (j) =>
                                            `${j.fields["Job Code"] ?? "Job"} (${j.fields.Status ?? "—"})`,
                                        )
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
                            <td
                              className={`px-3 py-2 ${overdue ? "font-semibold text-destructive" : "text-muted-foreground"}`}
                            >
                              {overdue && <AlertTriangle className="mr-1 inline h-3 w-3" />}
                              {formatDate(lead.fields["Next action date"])}
                            </td>
                            <td className="px-3 py-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setEditingLead(lead)}
                              >
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
            return client ? (jobsByClientId.get(client.id) ?? []) : [];
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

      {creatingLead && (
        <NewLeadDialog
          onClose={() => setCreatingLead(false)}
          onSave={(vars) => create.mutate(vars, { onSuccess: () => setCreatingLead(false) })}
          saving={create.isPending}
        />
      )}
    </div>
  );
}

function LeadThread({ leadId }: { leadId: string }) {
  const fetchThread = useServerFn(listLeadThread);
  const threadQ = useQuery({
    queryKey: ["leads", "thread", leadId],
    queryFn: () => fetchThread({ data: { leadId } }),
  });

  type TimelineItem =
    | { kind: "message"; date: string; record: AirtableRecord<MessageFields> }
    | { kind: "activity"; date: string; record: AirtableRecord<ActivityFields> };

  const timeline = useMemo<TimelineItem[]>(() => {
    const messages = threadQ.data?.messages ?? [];
    const activities = threadQ.data?.activities ?? [];
    const items: TimelineItem[] = [
      ...messages.map((m) => ({
        kind: "message" as const,
        date: m.fields.Timestamp ?? "",
        record: m,
      })),
      ...activities.map((a) => ({
        kind: "activity" as const,
        date: a.fields.Date ?? "",
        record: a,
      })),
    ];
    return items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [threadQ.data]);

  if (threadQ.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading activity…</p>;
  }
  if (threadQ.error) {
    return <p className="text-xs text-destructive">{getErrorMessage(threadQ.error)}</p>;
  }
  if (timeline.length === 0) {
    return <p className="text-xs text-muted-foreground">No emails or activity logged yet.</p>;
  }

  return (
    <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
      {timeline.map((item) =>
        item.kind === "message" ? (
          <div key={`m-${item.record.id}`} className="rounded border border-border p-2 text-xs">
            <div className="mb-0.5 flex items-center justify-between gap-2">
              <Badge variant="outline" className="text-[10px]">
                {item.record.fields.Direction ?? "Message"}
              </Badge>
              <span className="text-muted-foreground">
                {formatDate(item.record.fields.Timestamp)}
              </span>
            </div>
            {item.record.fields.Subject && (
              <div className="font-medium">{item.record.fields.Subject}</div>
            )}
            {item.record.fields.Body && (
              <div className="mt-0.5 line-clamp-3 text-muted-foreground">
                {item.record.fields.Body}
              </div>
            )}
          </div>
        ) : (
          <div
            key={`a-${item.record.id}`}
            className="rounded border border-dashed border-border p-2 text-xs"
          >
            <div className="mb-0.5 flex items-center justify-between gap-2">
              <Badge variant="outline" className="text-[10px]">
                {item.record.fields.Type ?? "Activity"}
              </Badge>
              <span className="text-muted-foreground">{formatDate(item.record.fields.Date)}</span>
            </div>
            {item.record.fields.Title && (
              <div className="font-medium">{item.record.fields.Title}</div>
            )}
            {item.record.fields.Details && (
              <div className="mt-0.5 line-clamp-3 text-muted-foreground">
                {item.record.fields.Details}
              </div>
            )}
          </div>
        ),
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
    email?: string;
    phone?: string;
    company?: string;
  }) => void;
  saving: boolean;
}) {
  const linked = isLeadLinked(lead);
  const [stage, setStage] = useState(lead.fields.Stage ?? "New");
  const [leadStatus, setLeadStatus] = useState(lead.fields["Lead status"] ?? "New");
  const [urgency, setUrgency] = useState(lead.fields.Urgency ?? "");
  const [leadValue, setLeadValue] = useState(
    lead.fields["Lead value"] !== undefined ? String(lead.fields["Lead value"]) : "",
  );
  const [notes, setNotes] = useState(lead.fields.Notes ?? "");
  const [lostReason, setLostReason] = useState(lead.fields["Lost reason"] ?? "");
  const [email, setEmail] = useState(lead.fields.Email ?? "");
  const [phone, setPhone] = useState(lead.fields.Phone ?? "");
  const [company, setCompany] = useState(lead.fields.Company ?? "");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{lead.fields["Lead Name"] ?? "Lead"}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          {lead.fields.Situation && (
            <div className="rounded bg-muted/40 p-2 text-xs text-muted-foreground">
              {lead.fields.Situation}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1" />
            </div>
            <div className="col-span-2">
              <Label>Company</Label>
              <Input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

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
                Not linked yet — the CRM↔Ops sync links this automatically once the lead converts to
                a client.
              </div>
            )}
          </div>

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Email &amp; activity history
            </div>
            <LeadThread leadId={lead.id} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Stage</Label>
              <select
                value={stage}
                disabled={linked}
                onChange={(e) => setStage(e.target.value)}
                className={`mt-1 w-full rounded border px-2 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${stageStyle(stage)}`}
              >
                {LEAD_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {linked && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Linked to a client — managed automatically by the CRM↔Ops sync.
                </p>
              )}
            </div>
            <div>
              <Label>Lead status</Label>
              <select
                value={leadStatus}
                disabled={linked}
                onChange={(e) => setLeadStatus(e.target.value)}
                className="mt-1 w-full rounded border border-input bg-background px-2 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
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
                stage: linked ? undefined : stage,
                leadStatus: linked ? undefined : leadStatus,
                urgency: urgency || undefined,
                leadValue: leadValue === "" ? null : Number(leadValue),
                notes,
                lostReason: !linked && stage === "Lost" ? lostReason : undefined,
                email: email || undefined,
                phone: phone || undefined,
                company: company || undefined,
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

function NewLeadDialog({
  onClose,
  onSave,
  saving,
}: {
  onClose: () => void;
  onSave: (vars: {
    leadName: string;
    email: string;
    phone?: string;
    company?: string;
    urgency?: string;
    situation?: string;
  }) => void;
  saving: boolean;
}) {
  const [leadName, setLeadName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [urgency, setUrgency] = useState("");
  const [situation, setSituation] = useState("");

  const canSave = leadName.trim().length > 0 && email.trim().length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New lead</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            For leads that came in by phone, in person, or anywhere else outside the web form/inbox
            automation. Starts at Stage = New.
          </p>
          <div>
            <Label>Name *</Label>
            <Input
              value={leadName}
              onChange={(e) => setLeadName(e.target.value)}
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Email *</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1" />
            </div>
            <div className="col-span-2">
              <Label>Company</Label>
              <Input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="mt-1"
              />
            </div>
            <div className="col-span-2">
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
          </div>
          <div>
            <Label>Situation / notes</Label>
            <Textarea
              value={situation}
              onChange={(e) => setSituation(e.target.value)}
              className="mt-1 min-h-[80px]"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving || !canSave}
            onClick={() =>
              onSave({
                leadName: leadName.trim(),
                email: email.trim(),
                phone: phone || undefined,
                company: company || undefined,
                urgency: urgency || undefined,
                situation: situation || undefined,
              })
            }
          >
            {saving ? "Saving…" : "Create lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
