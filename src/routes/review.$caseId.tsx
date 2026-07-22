import { useEffect, useState, useCallback, useRef } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { AiReviewDesk } from "@/components/AiReviewDesk";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CaseReplyBox } from "@/components/case-reply-box";
import { updateLead } from "@/lib/leads.functions";
import { CLIENT_STAGES } from "@/lib/leads-shared";
import { stageBadgeClass } from "@/lib/stage-colors";
import { CaseSummary } from "@/components/case-summary";

// Case review page (new spine). The route param $caseId is a
// brain_conversations.id. This page shows the full conversation from
// brain_events, lets Jim read it, then Generate a draft on demand, then
// review/edit/send it via AiReviewDesk. Read first, decide, then generate.
//
// The header also exposes the linked lead's Stage / Next action / Next action
// date. These are the same public.clients columns the /leads page edits, saved
// through the same updateLead server function, so both screens are one source
// of truth and the change is audit-logged either way.

interface ConversationInfo {
  id: string;
  case_serial_id: string | null;
  customer_email: string | null;
  stage: string | null;
  client_id: string | null;
}

interface ClientInfo {
  full_name: string | null;
  email: string | null;
  client_code: string | null;
  stage: string | null;
  next_action: string | null;
  next_action_date: string | null;
}

interface EventRow {
  id: string;
  event_type: string | null;
  actor: string | null;
  direction: string | null;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  occurred_at: string | null;
}

// Conversation display: nothing, the latest message only, or the full thread.
type ConvView = "collapsed" | "latest" | "all";

// Gmail sync progress tuning. Make runs asynchronously and gives the browser no
// hard "finished" signal, so the button tracks the actual import instead: it
// stays busy while messages are still arriving, ends once they have been quiet
// for QUIET_MS, gives up waiting for a first message after NO_ACTIVITY_MS (a
// long grace so the initial Gmail fetch has time to start landing rows), and is
// hard-capped by MAX_MS.
const SYNC_POLL_MS = 2500;
const SYNC_QUIET_MS = 12000;
const SYNC_NO_ACTIVITY_MS = 45000;
const SYNC_MAX_MS = 240000;

const ACTOR_LABELS: Record<string, string> = {
  customer: "Client",
  partner: "Partner",
  ai_agent: "Brain",
  internal: "You",
  system: "System",
  dimitris: "You",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export const Route = createFileRoute("/review/$caseId")({
  component: ReviewCase,
});

function ReviewCase() {
  const { caseId } = Route.useParams(); // brain_conversations.id
  const [conversation, setConversation] = useState<ConversationInfo | null>(null);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string>("");
  const [hasDraft, setHasDraft] = useState(false);
  const [draftStamp, setDraftStamp] = useState<string>("none");
  const [convView, setConvView] = useState<ConvView>("latest");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string>("");

  // Editable lead fields (draft state, seeded once from the client row).
  const [stageDraft, setStageDraft] = useState<string>("");
  const [nextActionDraft, setNextActionDraft] = useState<string>("");
  const [nextActionDateDraft, setNextActionDateDraft] = useState<string>("");
  const [leadSaveMsg, setLeadSaveMsg] = useState<string>("");
  const seededRef = useRef<string | null>(null);

  const updateLeadFn = useServerFn(updateLead);

  // Sync progress tracking (refs so the poll interval reads fresh values).
  const syncRef = useRef<{ start: number; lastActivity: number; baseline: number } | null>(null);
  const eventCountRef = useRef(0);
  const prevCountRef = useRef(0);

  const load = useCallback(async () => {
    const { data: convData } = await supabase
      .from("brain_conversations")
      .select("id, case_serial_id, customer_email, stage, client_id")
      .eq("id", caseId)
      .maybeSingle();

    const conv = (convData as ConversationInfo | null) ?? null;
    setConversation(conv);

    if (conv?.client_id) {
      const { data: clientData } = await supabase
        .from("clients")
        .select("full_name, email, client_code, stage, next_action, next_action_date")
        .eq("id", conv.client_id)
        .maybeSingle();
      setClient((clientData as ClientInfo | null) ?? null);
    }

    const { data: eventData } = await supabase
      .from("brain_events")
      .select("id, event_type, actor, direction, from_email, subject, body_text, occurred_at")
      .eq("conversation_id", caseId)
      .order("occurred_at", { ascending: true })
      .limit(100);
    setEvents((eventData as EventRow[] | null) ?? []);

    // Does a draft already exist for this case?
    const { data: draftData } = await supabase
      .from("case_drafts")
      .select("case_id, proposed_draft, last_updated")
      .eq("case_id", caseId)
      .maybeSingle();
    setHasDraft(!!(draftData as any)?.proposed_draft);
    setDraftStamp(((draftData as any)?.last_updated as string) || "none");

    setLoading(false);
  }, [caseId]);

  useEffect(() => {
    load();

    // Refresh when a draft lands (so the desk appears right after Generate),
    // and when events land (so synced Gmail messages appear as they import).
    const channel = supabase
      .channel(`realtime:case-review:${caseId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "case_drafts", filter: `case_id=eq.${caseId}` },
        () => load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "brain_events", filter: `conversation_id=eq.${caseId}` },
        () => load(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [caseId, load]);

  // Seed the editable lead fields once per client, when the row first loads.
  // Not re-seeded on later load() calls (e.g. during a Gmail sync), so an
  // in-progress edit is never clobbered by background refreshes.
  useEffect(() => {
    const cid = conversation?.client_id ?? null;
    if (cid && client && seededRef.current !== cid) {
      seededRef.current = cid;
      setStageDraft(client.stage ?? "");
      setNextActionDraft(client.next_action ?? "");
      setNextActionDateDraft(client.next_action_date ?? "");
    }
  }, [conversation?.client_id, client]);

  // Track the event count and, during a sync, note when it grows (activity).
  useEffect(() => {
    const grew = events.length > prevCountRef.current;
    prevCountRef.current = events.length;
    eventCountRef.current = events.length;
    if (syncing && syncRef.current && grew) {
      syncRef.current.lastActivity = Date.now();
    }
  }, [events.length, syncing]);

  // While syncing, poll (refreshing events in case realtime lags) and decide
  // when the import has finished.
  useEffect(() => {
    if (!syncing) return;
    const tick = async () => {
      await load();
      const s = syncRef.current;
      if (!s) return;
      const now = Date.now();
      const elapsed = now - s.start;
      const quiet = now - s.lastActivity;
      const imported = eventCountRef.current - s.baseline;
      const finish = (msg: string) => {
        setSyncMsg(msg);
        setSyncing(false);
        syncRef.current = null;
      };
      const plural = imported === 1 ? "" : "s";
      if (elapsed > SYNC_MAX_MS) {
        finish(
          imported > 0
            ? `Sync finished. ${imported} new message${plural} imported. If the thread still looks incomplete, sync again.`
            : "Sync finished without importing anything. If you expected mail, try again.",
        );
      } else if (imported > 0 && quiet > SYNC_QUIET_MS) {
        finish(`Sync complete. ${imported} new message${plural} imported.`);
      } else if (imported === 0 && elapsed > SYNC_NO_ACTIVITY_MS) {
        finish("Sync complete. No new messages to import.");
      }
    };
    const id = setInterval(tick, SYNC_POLL_MS);
    return () => clearInterval(id);
  }, [syncing, load]);

  const generate = async () => {
    setGenError("");
    setGenerating(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/webhooks/generate-draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ conversation_id: caseId }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail =
          typeof payload?.detail === "string" ? payload.detail : payload?.error ?? `HTTP ${res.status}`;
        setGenError(`Generation failed: ${detail}`);
      } else {
        await load();
      }
    } catch (err) {
      setGenError(
        `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setGenerating(false);
    }
  };

  const title =
    client?.full_name ||
    client?.email ||
    conversation?.customer_email ||
    `Case ${caseId.slice(0, 8)}`;

  const email = client?.email || conversation?.customer_email || "";

  // Save one or more lead fields through the same server function /leads uses.
  const saveLead = async (patch: {
    stage?: string;
    nextAction?: string;
    nextActionDate?: string | null;
  }) => {
    const leadId = conversation?.client_id;
    if (!leadId) return;
    setLeadSaveMsg("Saving...");
    try {
      await updateLeadFn({ data: { leadId, ...patch } });
      setClient((c) =>
        c
          ? {
              ...c,
              ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
              ...(patch.nextAction !== undefined ? { next_action: patch.nextAction } : {}),
              ...(patch.nextActionDate !== undefined
                ? { next_action_date: patch.nextActionDate }
                : {}),
            }
          : c,
      );
      setLeadSaveMsg("Saved");
      setTimeout(() => setLeadSaveMsg((m) => (m === "Saved" ? "" : m)), 1500);
    } catch (err) {
      setLeadSaveMsg(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSync = async () => {
    if (!email) {
      setSyncMsg("No customer email on this case, so there is nothing to search Gmail for.");
      return;
    }
    setSyncMsg("");
    syncRef.current = { start: Date.now(), lastActivity: Date.now(), baseline: events.length };
    setSyncing(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/webhooks/gmail-sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          conversationId: caseId,
          email,
          caseSerialId: conversation?.case_serial_id ?? undefined,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.ok) {
        const detail =
          typeof payload?.detail === "string" ? payload.detail : payload?.error ?? `HTTP ${res.status}`;
        setSyncing(false);
        syncRef.current = null;
        setSyncMsg(`Sync could not start: ${detail}`);
        return;
      }
      // Leave the button busy; the poll effect ends it when the import quiesces.
      setSyncMsg(
        "Importing from Gmail. Long histories can take up to a minute to finish, and the button stays active until they do.",
      );
    } catch (err) {
      setSyncing(false);
      syncRef.current = null;
      setSyncMsg(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Which events to render for the current view.
  const visibleEvents =
    convView === "all" ? events : convView === "latest" ? events.slice(-1) : [];

  const fieldClass =
    "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400";
  const labelClass = "text-[11px] font-medium text-slate-500 uppercase tracking-wide";

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <Link to="/drafts" className="text-sm text-slate-500 hover:text-slate-800">
          Back to cases
        </Link>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <h1 className="text-2xl font-serif font-semibold text-slate-900">{title}</h1>
          {conversation?.case_serial_id && (
            <span className="text-xs font-mono text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">
              {conversation.case_serial_id}
            </span>
          )}
        </div>
        {email && <p className="text-sm text-slate-500">{email}</p>}

        {/* Linked lead fields. Same public.clients row as /leads, saved through
            updateLead, so edits sync both ways and are audit-logged. */}
        {conversation?.client_id && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Stage</label>
              <select
                value={stageDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setStageDraft(v);
                  saveLead({ stage: v });
                }}
                className={`rounded-md border px-2 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-slate-400 ${stageBadgeClass(stageDraft)}`}
              >
                {!stageDraft && <option value="">Select stage</option>}
                {CLIENT_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
              <label className={labelClass}>Next action</label>
              <input
                type="text"
                value={nextActionDraft}
                placeholder="Next action..."
                onChange={(e) => setNextActionDraft(e.target.value)}
                onBlur={() => {
                  if ((client?.next_action ?? "") !== nextActionDraft) {
                    saveLead({ nextAction: nextActionDraft });
                  }
                }}
                className={`${fieldClass} w-full`}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass}>Date</label>
              <input
                type="date"
                value={nextActionDateDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setNextActionDateDraft(v);
                  saveLead({ nextActionDate: v || null });
                }}
                className={fieldClass}
              />
            </div>

            {leadSaveMsg && (
              <span className="text-xs text-slate-400 pb-2">{leadSaveMsg}</span>
            )}
          </div>
        )}
      </div>

      {/* The conversation: read this before deciding to generate. */}
      <Card className="border-slate-200">
        <CardContent className="py-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
              Conversation
            </h2>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                onClick={handleSync}
                disabled={syncing || !email}
                className="h-7 px-2.5 text-xs"
                title="Search Gmail for this customer and import the whole thread into this case"
              >
                {syncing ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
                    Syncing...
                  </span>
                ) : (
                  "Sync from Gmail"
                )}
              </Button>
              {!loading && events.length > 0 && (
                <>
                  <span className="mx-0.5 h-4 w-px bg-slate-200" />
                  <Button
                    variant={convView === "collapsed" ? "default" : "outline"}
                    onClick={() => setConvView("collapsed")}
                    className={`h-7 px-2.5 text-xs ${convView === "collapsed" ? "bg-[#0B192C] text-white" : ""}`}
                  >
                    Collapse
                  </Button>
                  <Button
                    variant={convView === "latest" ? "default" : "outline"}
                    onClick={() => setConvView("latest")}
                    className={`h-7 px-2.5 text-xs ${convView === "latest" ? "bg-[#0B192C] text-white" : ""}`}
                  >
                    Latest
                  </Button>
                  <Button
                    variant={convView === "all" ? "default" : "outline"}
                    onClick={() => setConvView("all")}
                    className={`h-7 px-2.5 text-xs ${convView === "all" ? "bg-[#0B192C] text-white" : ""}`}
                  >
                    All ({events.length})
                  </Button>
                </>
              )}
            </div>
          </div>

          {syncMsg && <p className="text-xs text-slate-500">{syncMsg}</p>}

          {loading && <p className="text-sm text-slate-400">Loading conversation...</p>}
          {!loading && events.length === 0 && (
            <p className="text-sm text-slate-400">
              No messages logged for this case yet. Use Sync from Gmail to pull the history.
            </p>
          )}

          {visibleEvents.map((row) => (
            <div key={row.id} className="border-l-2 border-slate-200 pl-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-700">
                  {ACTOR_LABELS[row.actor ?? ""] ?? row.actor ?? "Unknown"}
                </span>
                {row.direction && (
                  <span className="text-xs text-slate-400">({row.direction})</span>
                )}
                <span className="text-xs text-slate-400">{formatWhen(row.occurred_at)}</span>
              </div>
              {row.subject && (
                <p className="text-xs text-slate-500 mt-1">Subject: {row.subject}</p>
              )}
              <p className="text-sm text-slate-600 whitespace-pre-wrap mt-1">
                {row.body_text ?? ""}
              </p>
            </div>
          ))}

          {!loading && convView === "latest" && events.length > 1 && (
            <p className="text-xs text-slate-400 italic">
              Showing the latest message only. {events.length - 1} earlier hidden.
            </p>
          )}
          {!loading && convView === "collapsed" && events.length > 0 && (
            <p className="text-xs text-slate-400 italic">
              Conversation collapsed. {events.length} message{events.length === 1 ? "" : "s"} hidden.
            </p>
          )}
        </CardContent>
      </Card>

      <CaseSummary caseId={caseId} caseSerialId={conversation?.case_serial_id ?? null} />

      {/* Case Reply Box */}
      <CaseReplyBox
        conversationId={caseId}
        clientEmail={email}
        clientName={client?.full_name ?? undefined}
        caseSerialId={conversation?.case_serial_id ?? undefined}
        replyToSubject={events.length ? events[events.length - 1].subject ?? undefined : undefined}
        onSent={load}
      />

      {/* Generate control: only shown when no draft exists yet. Once a draft
          is present, AiReviewDesk below takes over with edit + send. */}
      {!loading && !hasDraft && (
        <div className="flex flex-col items-start gap-2">
          <Button
            onClick={generate}
            disabled={generating}
            className="bg-[#0B192C] hover:bg-slate-800 text-white"
          >
            {generating ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                Generating draft...
              </span>
            ) : (
              "Generate draft"
            )}
          </Button>
          <p className="text-xs text-slate-400">
            Runs the Brain once for this case. Costs a single AI call. Nothing is sent until you
            review and approve.
          </p>
          {generating && (
            <div className="flex items-center gap-2 text-sm text-slate-600 border border-slate-200 bg-slate-50 rounded px-3 py-2">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
              The Brain is reading the conversation and drafting a reply. This usually takes a few
              seconds.
            </div>
          )}
          {genError && (
            <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
              {genError}
            </p>
          )}
        </div>
      )}

      {/* When a draft exists, the desk shows it for edit + approve + send, and
          offers a regenerate path. */}
      {hasDraft && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={generate}
              disabled={generating}
              className="h-8 px-3 text-xs"
              title="Regenerate: runs the Brain again and replaces the current draft"
            >
              {generating ? "Regenerating..." : "Regenerate draft"}
            </Button>
            {genError && <span className="text-sm text-red-600">{genError}</span>}
          </div>
          <AiReviewDesk key={draftStamp} jobId={caseId} />
        </div>
      )}
    </div>
  );
}
