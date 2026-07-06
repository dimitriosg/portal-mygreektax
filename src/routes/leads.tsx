import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, AlertTriangle, GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  listLeads,
  updateLead,
  createLead,
  listLeadThread,
  listLeadActivity,
  deleteLead,
} from "@/lib/leads.functions";
import { listJobs } from "@/lib/jobs.functions";
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
import { CLIENT_STAGES, LEAD_URGENCY_OPTIONS } from "@/lib/leads-shared";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import type { AirtableRecord, ClientFields, JobFields, MessageFields } from "@/lib/airtable.server";

export const Route = createFileRoute("/leads")({ component: LeadsPage });

const COLLAPSED_STORAGE_KEY = "mgt-leads-collapsed-stages";

// Color coding per stage — used for column headers, the stage select, and badges
// so a stage is recognizable at a glance across both views. Stage vocabulary is
// unified across the whole client lifecycle (Task 4): a "lead" is just a Client
// record with Stage = "Potential".
const STAGE_STYLES: Record<string, string> = {
  Potential: "border-sky-300 bg-sky-100 text-sky-900",
  Quoted: "border-amber-300 bg-amber-100 text-amber-900",
  Active: "border-teal-300 bg-teal-100 text-teal-900",
  Parked: "border-orange-300 bg-orange-100 text-orange-900",
  Complete: "border-green-300 bg-green-100 text-green-900",
  Lost: "border-destructive/30 bg-destructive/10 text-destructive",
};

function stageStyle(stage?: string | null) {
  return (stage && STAGE_STYLES[stage]) || "bg-muted text-muted-foreground border-border";
}

type Lead = AirtableRecord<ClientFields>;
type Job = AirtableRecord<JobFields>;

// Ticket B2 — the three fields that write back individually/optimistically,
// from both the board and the detail dialog.
type QuickUpdateVars = {
  leadId: string;
  stage?: string;
  nextAction?: string;
  nextActionDate?: string | null;
};

function leadValueLabel(value?: number | null) {
  if (value === undefined || value === null) return "—";
  return `€${value.toLocaleString("en-IE")}`;
}

const CLOSED_STAGES = new Set(["Complete", "Lost"]);

function isOverdue(lead: Lead) {
  const dateStr = lead.fields["Next Action Date"];
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

// Ticket C — human-readable rendering for a History row's old/new values.
// Metadata values come straight out of Airtable field values via
// updateLead's diff loop, so this just needs to handle the plain JSON
// primitives that show up there (string/number/boolean/null).
function formatHistoryValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
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
// top: leads with an overdue/soonest Next Action Date first, undated leads
// last (sorted by oldest created-time so they don't get forgotten either).
function compareLeads(a: Lead, b: Lead) {
  const aNext = a.fields["Next Action Date"];
  const bNext = b.fields["Next Action Date"];
  const aTime = aNext ? new Date(aNext).getTime() : Number.POSITIVE_INFINITY;
  const bTime = bNext ? new Date(bNext).getTime() : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime();
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
  const deleteLeadFn = useServerFn(deleteLead);
  const fetchJobs = useServerFn(listJobs);
  const qc = useQueryClient();

  const leadsQ = useQuery({
    queryKey: ["leads", "admin"],
    queryFn: () => fetchLeads(),
    enabled: !!isAdmin && sessionReady,
  });
  const jobsQ = useQuery({
    queryKey: ["jobs", "admin"],
    queryFn: () => fetchJobs(),
    enabled: !!isAdmin && sessionReady,
  });

  useEffect(() => {
    const authError = [leadsQ.error, jobsQ.error].find(isAuthSessionError);
    if (authError) navigate({ to: "/login", replace: true });
  }, [leadsQ.error, jobsQ.error, navigate]);

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

  const removeLead = useMutation({
    mutationFn: (vars: { leadId: string }) => deleteLeadFn({ data: vars }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["leads", "admin"] });
      const previous = qc.getQueryData<{ leads: Lead[] }>(["leads", "admin"]);
      qc.setQueryData<{ leads: Lead[] } | undefined>(["leads", "admin"], (old) => {
        if (!old) return old;
        return { leads: old.leads.filter((lead) => lead.id !== vars.leadId) };
      });
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) qc.setQueryData(["leads", "admin"], context.previous);
      handleMutationError(error);
    },
    onSuccess: () => {
      toast.success("Lead deleted");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });

  // Ticket B2: Stage, Next Action, and Next Action Date each write back
  // individually and optimistically (board dropdown/drag, board+list inline
  // inputs, and the same three fields in the Client detail dialog all share
  // this one mutation) - update the local cache immediately, then confirm
  // against the real Airtable write; roll back and toast on failure. This is
  // deliberately separate from the `update` mutation above, which still
  // handles the rest of the detail dialog's fields via the batch Save button
  // exactly as before.
  const quickUpdate = useMutation({
    mutationFn: (vars: QuickUpdateVars) => updateLeadFn({ data: vars }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["leads", "admin"] });
      const previous = qc.getQueryData<{ leads: Lead[] }>(["leads", "admin"]);
      qc.setQueryData<{ leads: Lead[] } | undefined>(["leads", "admin"], (old) => {
        if (!old) return old;
        return {
          leads: old.leads.map((l) => {
            if (l.id !== vars.leadId) return l;
            const fields: ClientFields = { ...l.fields };
            if (vars.stage !== undefined) fields.Stage = vars.stage;
            if (vars.nextAction !== undefined) fields["Next Action"] = vars.nextAction;
            if (vars.nextActionDate !== undefined) {
              fields["Next Action Date"] = vars.nextActionDate ?? undefined;
            }
            return { ...l, fields };
          }),
        };
      });
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) qc.setQueryData(["leads", "admin"], context.previous);
      if (isAuthSessionError(error)) {
        navigate({ to: "/login", replace: true });
        return;
      }
      toast.error(`Change reverted — ${getErrorMessage(error)}`);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });

  const leads = leadsQ.data?.leads ?? [];
  const jobs = jobsQ.data?.jobs ?? [];

  // A lead IS a Client record (Task 4) — no separate linking step. Jobs are
  // matched directly off the Client link on the Jobs table.
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
        lead.fields["Full Name"],
        lead.fields.Email,
        lead.fields.Phone,
        lead.fields["Client Code"],
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [leads, search, stageFilter]);

  const leadsByStage = useMemo(() => {
    const map = new Map<string, Lead[]>();
    for (const stage of CLIENT_STAGES) map.set(stage, []);
    for (const lead of filteredLeads) {
      const stage = lead.fields.Stage ?? "Potential";
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
    let completeCount = 0;
    let overdueCount = 0;
    for (const lead of leads) {
      const stage = lead.fields.Stage ?? "Potential";
      if (!CLOSED_STAGES.has(stage)) {
        activeValue += lead.fields["Lead Value (€)"] ?? 0;
      }
      if (stage === "Complete") completeCount += 1;
      if (isOverdue(lead)) overdueCount += 1;
    }
    return { total: leads.length, activeValue, completeCount, overdueCount };
  }, [leads]);

  const errors: Array<{ label: string; error: unknown }> = [
    { label: "Leads", error: leadsQ.error },
    { label: "Jobs", error: jobsQ.error },
  ].filter((e) => e.error) as Array<{ label: string; error: unknown }>;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleBoardDragEnd = (event: DragEndEvent) => {
    const overId = event.over?.id;
    if (!overId) return;
    const targetStage = String(overId);
    if (!(CLIENT_STAGES as readonly string[]).includes(targetStage)) return;
    const leadId = String(event.active.id);
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.fields.Stage === targetStage) return;
    quickUpdate.mutate({ leadId, stage: targetStage });
  };

  if (!isAdmin) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Your daily driver — every client from first contact through to a completed job, in one
            place. Edits here write straight back to the Ops Airtable base. New leads from the web
            form/inbox show up here directly (no separate CRM sync to wait on).
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
            <div className="text-xs text-muted-foreground">Completed (all-time)</div>
            <div className="text-lg font-semibold">{stats.completeCount}</div>
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
          placeholder="Search name, email, client code…"
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
            {CLIENT_STAGES.map((s) => (
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleBoardDragEnd}
        >
          <div className="flex gap-3 overflow-x-auto pb-2">
            {CLIENT_STAGES.map((stage) => (
              <PipelineColumn
                key={stage}
                stage={stage}
                leads={leadsByStage.get(stage) ?? []}
                collapsed={collapsedStages.has(stage)}
                onToggleCollapse={() => toggleCollapsed(stage)}
                onOpen={setEditingLead}
                quickUpdate={quickUpdate.mutate}
              />
            ))}
          </div>
        </DndContext>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2">Urgency</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">Jobs</th>
                <th className="px-3 py-2">Next action</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(stageFilter ? [stageFilter] : CLIENT_STAGES).map((stage) => {
                const stageLeads = leadsByStage.get(stage) ?? [];
                if (stageLeads.length === 0) return null;
                const collapsed = !stageFilter && collapsedStages.has(stage); // rows always show when a stage filter hides the collapse toggle
                return (
                  <>
                    {!stageFilter && (
                      <tr key={`${stage}-hdr`}>
                        <td colSpan={8} className="p-0">
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
                      stageLeads.map((lead) => (
                        <LeadListRow
                          key={lead.id}
                          lead={lead}
                          clientJobs={jobsByClientId.get(lead.id) ?? []}
                          onOpen={setEditingLead}
                          quickUpdate={quickUpdate.mutate}
                        />
                      ))}
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
          clientJobs={jobsByClientId.get(editingLead.id) ?? []}
          onClose={() => setEditingLead(null)}
          onSave={(vars) =>
            update.mutate(
              { leadId: editingLead.id, ...vars },
              { onSuccess: () => setEditingLead(null) },
            )
          }
          saving={update.isPending}
          onQuickUpdate={(vars) => quickUpdate.mutate({ leadId: editingLead.id, ...vars })}
          canDelete={isAdmin}
          deleting={removeLead.isPending}
          onDelete={() =>
            removeLead.mutate({ leadId: editingLead.id }, { onSuccess: () => setEditingLead(null) })
          }
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

// One droppable Stage column on the board. Extracted so useDroppable (a
// hook) isn't called inside a .map() callback in the parent.
function PipelineColumn({
  stage,
  leads,
  collapsed,
  onToggleCollapse,
  onOpen,
  quickUpdate,
}: {
  stage: string;
  leads: Lead[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpen: (lead: Lead) => void;
  quickUpdate: (vars: QuickUpdateVars) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  if (collapsed) {
    return (
      <button
        onClick={onToggleCollapse}
        title={`Expand ${stage}`}
        className={`flex w-10 shrink-0 flex-col items-center justify-start gap-2 rounded-md border px-1 py-2 ${stageStyle(stage)}`}
        style={{ minHeight: 240 }}
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0 rounded-full bg-background/70 px-1.5 text-[10px]">
          {leads.length}
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
    <div className="min-w-[260px] max-w-[280px] flex-1">
      <button
        onClick={onToggleCollapse}
        className={`mb-2 flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-xs font-semibold uppercase tracking-wide ${stageStyle(stage)}`}
        title={`Collapse ${stage}`}
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown className="h-3.5 w-3.5" />
          {stage}
        </span>
        <span className="rounded-full bg-background/70 px-2 py-0.5 text-[10px] normal-case">
          {leads.length}
        </span>
      </button>
      <div
        ref={setNodeRef}
        className={`space-y-2 rounded-md p-1 transition-colors ${isOver ? "bg-muted ring-2 ring-primary/40" : ""}`}
        style={{ minHeight: 60 }}
      >
        {leads.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            stage={stage}
            onOpen={onOpen}
            quickUpdate={quickUpdate}
          />
        ))}
        {leads.length === 0 && <p className="px-1 text-xs text-muted-foreground">No leads</p>}
      </div>
    </div>
  );
}

// One draggable board card. Stage changes via the dropdown or by dragging
// the card (grip handle only, so the rest of the card stays click-to-open
// and the dropdown/inputs stay independently clickable) both call the same
// optimistic quickUpdate mutation as the detail dialog.
function LeadCard({
  lead,
  stage,
  onOpen,
  quickUpdate,
}: {
  lead: Lead;
  stage: string;
  onOpen: (lead: Lead) => void;
  quickUpdate: (vars: QuickUpdateVars) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
  });
  const overdue = isOverdue(lead);
  const [nextActionDraft, setNextActionDraft] = useState(lead.fields["Next Action"] ?? "");

  useEffect(() => {
    setNextActionDraft(lead.fields["Next Action"] ?? "");
  }, [lead.id, lead.fields["Next Action"]]);

  const style = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: "relative" as const,
  };

  const commitNextAction = () => {
    if (nextActionDraft !== (lead.fields["Next Action"] ?? "")) {
      quickUpdate({ leadId: lead.id, nextAction: nextActionDraft });
    }
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={`cursor-pointer border-l-4 transition-shadow hover:shadow-md ${stageStyle(stage).split(" ")[0]} ${overdue ? "ring-1 ring-destructive" : ""}`}
      onClick={() => onOpen(lead)}
    >
      <CardContent className="space-y-2 py-3">
        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
              aria-label="Drag to change stage"
              onClick={(e) => e.stopPropagation()}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
            <div className="truncate font-medium leading-tight">
              {lead.fields["Full Name"] ?? "—"}
            </div>
          </div>
          {overdue && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
        </div>
        <div className="truncate text-xs text-muted-foreground">{lead.fields.Email ?? "—"}</div>
        <div className="flex items-center justify-between text-xs">
          <span className={urgencyTextClass(lead.fields.Urgency)}>
            {lead.fields.Urgency ?? "—"}
          </span>
          <span className="font-medium">{leadValueLabel(lead.fields["Lead Value (€)"])}</span>
        </div>
        {lead.fields["Client Code"] && (
          <div className="truncate text-xs text-muted-foreground">{lead.fields["Client Code"]}</div>
        )}
        <select
          value={lead.fields.Stage ?? ""}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            quickUpdate({ leadId: lead.id, stage: e.target.value });
          }}
          className={`w-full rounded border px-2 py-1 text-xs ${stageStyle(lead.fields.Stage)}`}
        >
          {CLIENT_STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Input
          value={nextActionDraft}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setNextActionDraft(e.target.value)}
          onBlur={commitNextAction}
          placeholder="Next action…"
          className="h-7 text-xs"
        />
        <Input
          type="date"
          value={
            lead.fields["Next Action Date"] ? lead.fields["Next Action Date"].slice(0, 10) : ""
          }
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            quickUpdate({ leadId: lead.id, nextActionDate: e.target.value || null });
          }}
          className="h-7 text-xs"
        />
      </CardContent>
    </Card>
  );
}

// One row in the list view. Same quickUpdate mutation as the board; no drag
// here (grouped-by-stage sections plus the dropdown already cover it).
function LeadListRow({
  lead,
  clientJobs,
  onOpen,
  quickUpdate,
}: {
  lead: Lead;
  clientJobs: Job[];
  onOpen: (lead: Lead) => void;
  quickUpdate: (vars: QuickUpdateVars) => void;
}) {
  const overdue = isOverdue(lead);
  const [nextActionDraft, setNextActionDraft] = useState(lead.fields["Next Action"] ?? "");

  useEffect(() => {
    setNextActionDraft(lead.fields["Next Action"] ?? "");
  }, [lead.id, lead.fields["Next Action"]]);

  const commitNextAction = () => {
    if (nextActionDraft !== (lead.fields["Next Action"] ?? "")) {
      quickUpdate({ leadId: lead.id, nextAction: nextActionDraft });
    }
  };

  return (
    <tr className={`border-t border-border ${overdue ? "bg-destructive/5" : ""}`}>
      <td className="px-3 py-2 font-medium">{lead.fields["Full Name"] ?? "—"}</td>
      <td className="px-3 py-2 text-muted-foreground">{lead.fields.Email ?? "—"}</td>
      <td className="px-3 py-2">
        <select
          value={lead.fields.Stage ?? ""}
          onChange={(e) => quickUpdate({ leadId: lead.id, stage: e.target.value })}
          className={`rounded border px-2 py-1 text-xs ${stageStyle(lead.fields.Stage)}`}
        >
          {CLIENT_STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </td>
      <td className={`px-3 py-2 ${urgencyTextClass(lead.fields.Urgency)}`}>
        {lead.fields.Urgency ?? "—"}
      </td>
      <td className="px-3 py-2">{leadValueLabel(lead.fields["Lead Value (€)"])}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {clientJobs.length > 0 ? (
          <div>
            {clientJobs
              .map((j) => `${j.fields["Job Code"] ?? "Job"} (${j.fields.Status ?? "—"})`)
              .join(", ")}
          </div>
        ) : (
          "No jobs yet"
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-1">
          <Input
            value={nextActionDraft}
            onChange={(e) => setNextActionDraft(e.target.value)}
            onBlur={commitNextAction}
            placeholder="Next action…"
            className="h-7 text-xs"
          />
          <Input
            type="date"
            value={
              lead.fields["Next Action Date"] ? lead.fields["Next Action Date"].slice(0, 10) : ""
            }
            onChange={(e) =>
              quickUpdate({ leadId: lead.id, nextActionDate: e.target.value || null })
            }
            className={`h-7 text-xs ${overdue ? "border-destructive text-destructive" : ""}`}
          />
        </div>
      </td>
      <td className="px-3 py-2">
        <Button size="sm" variant="outline" onClick={() => onOpen(lead)}>
          Edit
        </Button>
      </td>
    </tr>
  );
}

function LeadThread({ leadId }: { leadId: string }) {
  const fetchThread = useServerFn(listLeadThread);
  const threadQ = useQuery({
    queryKey: ["leads", "thread", leadId],
    queryFn: () => fetchThread({ data: { leadId } }),
  });

  const messages = useMemo(() => {
    const list = threadQ.data?.messages ?? [];
    return [...list].sort(
      (a, b) =>
        new Date(b.fields.Timestamp ?? 0).getTime() - new Date(a.fields.Timestamp ?? 0).getTime(),
    );
  }, [threadQ.data]);

  if (threadQ.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading activity…</p>;
  }
  if (threadQ.error) {
    return <p className="text-xs text-destructive">{getErrorMessage(threadQ.error)}</p>;
  }
  if (messages.length === 0) {
    return <p className="text-xs text-muted-foreground">No emails logged yet.</p>;
  }

  return (
    <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
      {messages.map((m: AirtableRecord<MessageFields>) => (
        <div key={m.id} className="rounded border border-border p-2 text-xs">
          <div className="mb-0.5 flex items-center justify-between gap-2">
            <Badge variant="outline" className="text-[10px]">
              {m.fields.Direction ?? "Message"}
            </Badge>
            <span className="text-muted-foreground">{formatDate(m.fields.Timestamp)}</span>
          </div>
          {m.fields.Subject && <div className="font-medium">{m.fields.Subject}</div>}
          {m.fields.Body && (
            <div className="mt-0.5 line-clamp-3 text-muted-foreground">{m.fields.Body}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// Ticket C, Part 2b — read-only per-client audit trail, newest first.
// Reads the same activity_events stream every logActivityEvent call writes
// to (Stage changes + the Ticket C field-diff entries + lead_created);
// nothing here is editable from the UI.
function LeadHistory({ leadId }: { leadId: string }) {
  const fetchHistory = useServerFn(listLeadActivity);
  const historyQ = useQuery({
    queryKey: ["leads", "history", leadId],
    queryFn: () => fetchHistory({ data: { leadId } }),
  });

  const events = historyQ.data?.events ?? [];

  if (historyQ.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading history…</p>;
  }
  if (historyQ.error) {
    return <p className="text-xs text-destructive">{getErrorMessage(historyQ.error)}</p>;
  }
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">No changes logged yet.</p>;
  }

  return (
    <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
      {events.map((ev) => {
        const md = (ev.metadata ?? {}) as Record<string, unknown>;
        const actor = ev.actor_name || ev.actor_email || "Someone";
        const when = formatDate(ev.occurred_at);
        const description =
          ev.event_type === "lead_created" ? (
            "created this lead"
          ) : (
            <>
              changed <span className="font-medium">{String(md.field ?? "a field")}</span> from{" "}
              <span className="text-muted-foreground">{formatHistoryValue(md.from)}</span> to{" "}
              <span className="font-medium">{formatHistoryValue(md.to)}</span>
            </>
          );
        return (
          <div key={ev.id} className="rounded border border-border p-2 text-xs">
            <span className="font-medium">{actor}</span> {description}
            <span className="text-muted-foreground"> — {when}</span>
          </div>
        );
      })}
    </div>
  );
}

// Money fields are only shown once there is something to quote — Potential
// leads with no quote yet don't need an empty wall of € inputs.
const MONEY_RELEVANT_STAGES = new Set(["Quoted", "Active", "Parked", "Complete"]);

function euroField(value?: number | null) {
  return value !== undefined && value !== null ? String(value) : "";
}

function LeadEditDialog({
  lead,
  clientJobs,
  onClose,
  onSave,
  saving,
  onQuickUpdate,
  canDelete,
  deleting,
  onDelete,
}: {
  lead: Lead;
  clientJobs: Job[];
  onClose: () => void;
  onSave: (vars: {
    fullName?: string;
    clientCode?: string;
    urgency?: string | null;
    leadValue?: number | null;
    notes?: string;
    lostReason?: string;
    email?: string;
    phone?: string;
    nationality?: string;
    afm?: string;
    taxisnetAccess?: boolean;
    cadence?: string;
    caseCode?: string;
    quoteSentDate?: string | null;
    quoteAmount?: number | null;
    deposit?: number | null;
    balanceDue?: number | null;
    partnerFee?: number | null;
    parkedReason?: string;
    status?: string;
    source?: string;
    clientVisibleNote?: string;
    threadId?: string;
  }) => void;
  saving: boolean;
  canDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
  // Ticket B2 — Stage / Next Action / Next Action Date save instantly
  // (optimistic, same mutation the board uses) instead of waiting for the
  // batch Save button below.
  onQuickUpdate: (vars: {
    stage?: string;
    nextAction?: string;
    nextActionDate?: string | null;
  }) => void;
}) {
  const [fullName, setFullName] = useState(lead.fields["Full Name"] ?? "");
  const [clientCode, setClientCode] = useState(lead.fields["Client Code"] ?? "");
  const [status, setStatus] = useState(lead.fields.Status ?? "");
  const [source, setSource] = useState(lead.fields.Source ?? "");
  const [stage, setStage] = useState(lead.fields.Stage ?? "Potential");
  const [urgency, setUrgency] = useState(lead.fields.Urgency ?? "");
  const [leadValue, setLeadValue] = useState(euroField(lead.fields["Lead Value (€)"]));
  const [notes, setNotes] = useState(lead.fields.Notes ?? "");
  const [lostReason, setLostReason] = useState(lead.fields["Lost Reason"] ?? "");
  const [email, setEmail] = useState(lead.fields.Email ?? "");
  const [phone, setPhone] = useState(lead.fields.Phone ?? "");
  const [nationality, setNationality] = useState(lead.fields.Nationality ?? "");
  const [afm, setAfm] = useState(lead.fields.AFM ?? "");
  const [taxisnetAccess, setTaxisnetAccess] = useState(Boolean(lead.fields["TAXISnet Access"]));
  const [cadence, setCadence] = useState(lead.fields.Cadence ?? "");
  const [caseCode, setCaseCode] = useState(lead.fields["Case Code"] ?? "");
  const [quoteSentDate, setQuoteSentDate] = useState(
    lead.fields["Quote Sent Date"] ? lead.fields["Quote Sent Date"].slice(0, 10) : "",
  );
  const [quoteAmount, setQuoteAmount] = useState(euroField(lead.fields["Quote Amount €"]));
  const [deposit, setDeposit] = useState(euroField(lead.fields["Deposit €"]));
  const [balanceDue, setBalanceDue] = useState(euroField(lead.fields["Balance Due €"]));
  const [partnerFee, setPartnerFee] = useState(euroField(lead.fields["Partner Fee €"]));
  const [parkedReason, setParkedReason] = useState(lead.fields["Parked Reason"] ?? "");
  const [clientVisibleNote, setClientVisibleNote] = useState(
    lead.fields["Client Visible Note"] ?? "",
  );
  const [threadId, setThreadId] = useState(lead.fields["Thread ID"] ?? "");
  const [nextActionDraft, setNextActionDraft] = useState(lead.fields["Next Action"] ?? "");
  const [nextActionDate, setNextActionDate] = useState(
    lead.fields["Next Action Date"] ? lead.fields["Next Action Date"].slice(0, 10) : "",
  );
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState("");

  useEffect(() => {
    setNextActionDraft(lead.fields["Next Action"] ?? "");
    setNextActionDate(
      lead.fields["Next Action Date"] ? lead.fields["Next Action Date"].slice(0, 10) : "",
    );
  }, [lead.id, lead.fields["Next Action"], lead.fields["Next Action Date"]]);

  const commitNextAction = () => {
    if (nextActionDraft !== (lead.fields["Next Action"] ?? "")) {
      onQuickUpdate({ nextAction: nextActionDraft });
    }
  };

  const showMoney = MONEY_RELEVANT_STAGES.has(stage);
  const canConfirmDelete = deleteConfirmationText === "DELETE";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{lead.fields["Full Name"] ?? "Lead"}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Full name</Label>
              <Input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Client code</Label>
              <Input
                value={clientCode}
                onChange={(e) => setClientCode(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Nationality</Label>
              <Input
                value={nationality}
                onChange={(e) => setNationality(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>AFM</Label>
              <Input value={afm} onChange={(e) => setAfm(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Cadence</Label>
              <Input
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                className="mt-1"
                placeholder="e.g. Annual, Monthly"
              />
            </div>
            <div>
              <Label>Case code</Label>
              <Input
                value={caseCode}
                onChange={(e) => setCaseCode(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Status</Label>
              <Input value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Source</Label>
              <Input value={source} onChange={(e) => setSource(e.target.value)} className="mt-1" />
            </div>
            <label className="col-span-2 mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={taxisnetAccess}
                onChange={(e) => setTaxisnetAccess(e.target.checked)}
                className="h-4 w-4"
              />
              TAXISnet access
            </label>
          </div>

          <div className="rounded border border-border bg-muted/20 p-2 text-xs">
            <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
              Jobs
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

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Email history
            </div>
            <LeadThread leadId={lead.id} />
          </div>

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              History
            </div>
            <LeadHistory leadId={lead.id} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Stage</Label>
              <select
                value={stage}
                onChange={(e) => {
                  const next = e.target.value;
                  setStage(next);
                  onQuickUpdate({ stage: next });
                }}
                className={`mt-1 w-full rounded border px-2 py-2 text-sm ${stageStyle(stage)}`}
              >
                {CLIENT_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Next action</Label>
              <Input
                value={nextActionDraft}
                onChange={(e) => setNextActionDraft(e.target.value)}
                onBlur={commitNextAction}
                placeholder="Next action…"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Next action date</Label>
              <Input
                type="date"
                value={nextActionDate}
                onChange={(e) => {
                  const next = e.target.value;
                  setNextActionDate(next);
                  onQuickUpdate({ nextActionDate: next || null });
                }}
                className="mt-1"
              />
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
          {stage === "Parked" && (
            <div>
              <Label>Parked reason</Label>
              <Input
                value={parkedReason}
                onChange={(e) => setParkedReason(e.target.value)}
                className="mt-1"
              />
            </div>
          )}

          {showMoney && (
            <div className="rounded border border-border p-2">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Money
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Quote sent</Label>
                  <Input
                    type="date"
                    value={quoteSentDate}
                    onChange={(e) => setQuoteSentDate(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Quote amount (€)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={quoteAmount}
                    onChange={(e) => setQuoteAmount(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Deposit (€)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Balance due (€)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={balanceDue}
                    onChange={(e) => setBalanceDue(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Partner fee (€)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={partnerFee}
                    onChange={(e) => setPartnerFee(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
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
          <div>
            <Label>Client visible note</Label>
            <Textarea
              value={clientVisibleNote}
              onChange={(e) => setClientVisibleNote(e.target.value)}
              className="mt-1 min-h-[80px]"
            />
          </div>
          <div>
            <Label>Thread ID</Label>
            <Input
              value={threadId}
              onChange={(e) => setThreadId(e.target.value)}
              className="mt-1"
            />
          </div>
          {canDelete && (
            <div className="rounded border border-destructive/30 bg-destructive/5 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-destructive">
                Danger zone
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Permanently remove this lead from the pipeline.
              </p>
              <Button
                type="button"
                variant="destructive"
                className="mt-3"
                disabled={deleting}
                onClick={() => setConfirmDeleteOpen(true)}
              >
                Delete lead
              </Button>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() =>
              onSave({
                fullName: fullName || undefined,
                clientCode: clientCode || undefined,
                urgency: urgency === "" ? null : urgency,
                leadValue: leadValue === "" ? null : Number(leadValue),
                notes,
                lostReason: stage === "Lost" ? lostReason : undefined,
                email: email || undefined,
                phone: phone || undefined,
                nationality: nationality || undefined,
                afm: afm || undefined,
                taxisnetAccess,
                cadence: cadence || undefined,
                caseCode: caseCode || undefined,
                status: status || undefined,
                source: source || undefined,
                parkedReason: stage === "Parked" ? parkedReason : undefined,
                quoteSentDate: showMoney
                  ? quoteSentDate === ""
                    ? null
                    : quoteSentDate
                  : undefined,
                quoteAmount: showMoney
                  ? quoteAmount === ""
                    ? null
                    : Number(quoteAmount)
                  : undefined,
                deposit: showMoney ? (deposit === "" ? null : Number(deposit)) : undefined,
                balanceDue: showMoney ? (balanceDue === "" ? null : Number(balanceDue)) : undefined,
                partnerFee: showMoney ? (partnerFee === "" ? null : Number(partnerFee)) : undefined,
                clientVisibleNote: clientVisibleNote || undefined,
                threadId: threadId || undefined,
              })
            }
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
      <Dialog
        open={confirmDeleteOpen}
        onOpenChange={(open) => {
          setConfirmDeleteOpen(open);
          if (!open) setDeleteConfirmationText("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete lead</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Type <span className="font-semibold text-foreground">DELETE</span> to confirm.
            </p>
            <Input
              value={deleteConfirmationText}
              onChange={(e) => setDeleteConfirmationText(e.target.value)}
              placeholder="DELETE"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting || !canConfirmDelete}
              onClick={onDelete}
            >
              {deleting ? "Deleting…" : "Delete lead"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    urgency?: string;
    situation?: string;
  }) => void;
  saving: boolean;
}) {
  const [leadName, setLeadName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
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
            automation. Starts at Stage = Potential.
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
