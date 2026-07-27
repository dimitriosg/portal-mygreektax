import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AiReviewDesk } from "@/components/AiReviewDesk";
import { CaseReplyBox } from "@/components/case-reply-box";
import { updateLead } from "@/lib/leads.functions";
import { CLIENT_STAGES } from "@/lib/leads-shared";
import { CaseSummary } from "@/components/case-summary";
import { CaseNotes } from "@/components/CaseNotes";
import { CasePartnerThread } from "@/components/case-partner-thread";
import { DraftHistory } from "@/components/DraftHistory";
import { PopOutSection } from "@/components/section-shell";
import { CasePartnerReplyBox } from "@/components/case-partner-reply-box";

// Case review page (new spine). The route param $caseId is a
// brain_conversations.id. This page shows the full conversation from
// brain_events, lets Jim read it, then Generate a draft on demand, then
// review/edit/send it via AiReviewDesk. Read first, decide, then generate.
//
// The header also exposes the linked lead's Stage / Next action / Next action
// date. These are the same public.clients columns the /leads page edits, saved
// through the same updateLead server function, so both screens are one source
// of truth and the change is audit-logged either way.
//
// Layout: client conversation and partner thread sit side by side at half
// width each, so either can be scrolled without losing the other. Notes and
// summary share the next row at one third and two thirds. The reply runs full
// width below, since it is the thing that actually gets edited.
//
// Partner correspondence is quarantined to its own pane and never rendered in
// the client conversation, so there is no way to confuse the two at a glance.

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
const GEN_POLL_MS = 3000;
const GEN_TIMEOUT_MS = 180000;

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

// A partner message is one whose actor is the partner, or whose event type is
// explicitly a partner email. Everything else belongs to the client pane.
function isPartnerEvent(e: EventRow): boolean {
  if (e.actor === "partner") return true;
  return e.event_type === "partner_email_received" || e.event_type === "partner_email_sent";
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
  const [convView, setConvView] = useState<ConvView>("collapsed");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string>("");

  // Context counters, shown next to Generate so the cost of a run is visible
  // before it is spent.
  const [includedNotes, setIncludedNotes] = useState(0);
  const [includedPartner, setIncludedPartner] = useState(0);

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
    setHasDraft(!!draftData?.proposed_draft);
    setDraftStamp((draftData?.last_updated as string) || "none");

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
        {
          event: "*",
          schema: "public",
          table: "brain_events",
          filter: `conversation_id=eq.${caseId}`,
        },
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
      if (!res.ok || !payload?.ok) {
        const detail =
          typeof payload?.detail === "string"
            ? payload.detail
            : (payload?.error ?? `HTTP ${res.status}`);
        setGenError(`Generation failed: ${detail}`);
        return;
      }

      // Async now: the Brain writes to case_drafts in the background, so poll
      // until last_updated moves past the baseline the server handed back.
      const baseline: string | null = payload.previousUpdatedAt ?? null;
      const startedAt = Date.now();

      while (Date.now() - startedAt < GEN_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, GEN_POLL_MS));

        const { data: fresh } = await supabase
          .from("case_drafts")
          .select("proposed_draft, last_updated")
          .eq("case_id", caseId)
          .maybeSingle();

        const stamp = fresh?.last_updated as string | undefined;
        if (stamp && stamp !== baseline) {
          await load();
          return;
        }
      }

      setGenError(
        "The draft is taking longer than expected. It may still finish, so try reloading the page in a minute.",
      );
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
          typeof payload?.detail === "string"
            ? payload.detail
            : (payload?.error ?? `HTTP ${res.status}`);
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

  // Split the thread. Partner messages never appear in the client pane.
  const clientEvents = useMemo(() => events.filter((e) => !isPartnerEvent(e)), [events]);
  const partnerEvents = useMemo(() => events.filter(isPartnerEvent), [events]);

  // Which client events to render for the current view.
  const visibleEvents =
    convView === "all" ? clientEvents : convView === "latest" ? clientEvents.slice(-1) : [];

  const contextLine = `${includedNotes} note${includedNotes === 1 ? "" : "s"} and ${includedPartner} partner message${includedPartner === 1 ? "" : "s"} will be included`;

  return (
    <div className="mgt-case max-w-7xl mx-auto p-6 space-y-3.5">
      <div>
        <Link to="/drafts" className="crumb">
          Back to cases
        </Link>
        <div className="case-title">
          <h1>{title}</h1>
          {conversation?.case_serial_id && (
            <span className="code">{conversation.case_serial_id}</span>
          )}
        </div>
        {email && <div className="mail">{email}</div>}

        {/* Linked lead fields. Same public.clients row as /leads, saved through
            updateLead, so edits sync both ways and are audit-logged. */}
        {conversation?.client_id && (
          <div className="strip">
            <div className="field">
              <label htmlFor="case-stage">Stage</label>
              <select
                id="case-stage"
                className="mc-input"
                value={stageDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setStageDraft(v);
                  saveLead({ stage: v });
                }}
              >
                {!stageDraft && <option value="">Select stage</option>}
                {CLIENT_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="field grow">
              <label htmlFor="case-next">Next action</label>
              <input
                id="case-next"
                type="text"
                className="mc-input"
                value={nextActionDraft}
                placeholder="Next action..."
                onChange={(e) => setNextActionDraft(e.target.value)}
                onBlur={() => {
                  if ((client?.next_action ?? "") !== nextActionDraft) {
                    saveLead({ nextAction: nextActionDraft });
                  }
                }}
              />
            </div>

            <div className="field">
              <label htmlFor="case-date">Date</label>
              <input
                id="case-date"
                type="date"
                className="mc-input"
                value={nextActionDateDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setNextActionDateDraft(v);
                  saveLead({ nextActionDate: v || null });
                }}
              />
            </div>

            {leadSaveMsg && (
              <span className="stamp" style={{ marginLeft: "auto", paddingBottom: 6 }}>
                {leadSaveMsg}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Row 1: client conversation and partner thread, half each. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 items-start">
        <section className="card" data-open={convView !== "collapsed"}>
          <div className="card-head">
            <h2>Client conversation</h2>
            {!loading && clientEvents.length > 0 && (
              <span className="count">{clientEvents.length}</span>
            )}
            <div className="head-actions">
              {!loading && clientEvents.length > 0 && (
                <span className="seg">
                  <button
                    aria-pressed={convView === "collapsed"}
                    onClick={() => setConvView("collapsed")}
                  >
                    Collapse
                  </button>
                  <button
                    aria-pressed={convView === "latest"}
                    onClick={() => setConvView("latest")}
                  >
                    Latest
                  </button>
                  <button aria-pressed={convView === "all"} onClick={() => setConvView("all")}>
                    All ({clientEvents.length})
                  </button>
                </span>
              )}
              <button
                className="icon-btn"
                onClick={handleSync}
                disabled={syncing || !email}
                title="Search Gmail for this customer and import the whole thread into this case"
                aria-label="Sync from Gmail"
              >
                {syncing ? (
                  <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
                ) : (
                  <RefreshCw size={15} />
                )}
              </button>
            </div>
          </div>

          <div className="card-body">
            {syncMsg && <p className="stamp">{syncMsg}</p>}

            {loading && <p className="empty">Loading conversation...</p>}
            {!loading && clientEvents.length === 0 && (
              <p className="empty">
                No messages logged for this case yet. Use Sync from Gmail to pull the history.
              </p>
            )}

            {visibleEvents.length > 0 && (
              <div className={convView === "all" ? "pane" : ""}>
                {visibleEvents.map((row) => (
                  <div key={row.id} className="msg">
                    <div className="msg-head">
                      <span className="who">
                        {ACTOR_LABELS[row.actor ?? ""] ?? row.actor ?? "Unknown"}
                      </span>
                      {row.direction && <span className="when">({row.direction})</span>}
                      <span className="when">{formatWhen(row.occurred_at)}</span>
                    </div>
                    {row.subject && <p className="msg-subject">Subject: {row.subject}</p>}
                    <p>{row.body_text ?? ""}</p>
                  </div>
                ))}
              </div>
            )}

            {!loading && convView === "latest" && clientEvents.length > 1 && (
              <p className="empty">
                Showing the latest message only. {clientEvents.length - 1} earlier hidden.
              </p>
            )}
            {!loading && convView === "collapsed" && clientEvents.length > 0 && (
              <p className="empty">
                Conversation collapsed. {clientEvents.length} message
                {clientEvents.length === 1 ? "" : "s"} hidden.
              </p>
            )}
          </div>
        </section>

        <PopOutSection
          title="Partner thread"
          collapsible={false}
          headerExtras={
            <>
              <span className="tag tag-internal">Internal</span>
              {partnerEvents.length > 0 && <span className="count">{partnerEvents.length}</span>}
            </>
          }
        >
          <CasePartnerThread
            events={partnerEvents}
            loading={loading}
            conversationId={caseId}
            onIncludedCountChange={setIncludedPartner}
            onSynced={load}
          />
        </PopOutSection>
      </div>

      {/* Row 2: notes at one third, summary at two thirds. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5 items-start">
        <div className="lg:col-span-1">
          <PopOutSection title="My notes" defaultCollapsed={false}>
            <CaseNotes conversationId={caseId} onIncludedCountChange={setIncludedNotes} />
          </PopOutSection>
        </div>

        <div className="lg:col-span-2">
          <CaseSummary caseId={caseId} caseSerialId={conversation?.case_serial_id ?? null} />
        </div>
      </div>

      {/* Row 3: the reply, full width. */}
      <CaseReplyBox
        conversationId={caseId}
        clientEmail={email}
        clientName={client?.full_name ?? undefined}
        caseSerialId={conversation?.case_serial_id ?? undefined}
        replyToSubject={
          clientEvents.length
            ? (clientEvents[clientEvents.length - 1].subject ?? undefined)
            : undefined
        }
        onSent={load}
      />

      {/* Follow up with partner: plain compose for now, Brain drafting comes
          with the pricing-compartment work. Logs as partner_email_sent. */}
      <CasePartnerReplyBox
        conversationId={caseId}
        caseSerialId={conversation?.case_serial_id ?? null}
        onSent={load}
      />

      {/* Generate control: only shown when no draft exists yet. Once a draft
          is present, AiReviewDesk below takes over with edit + send. */}
      {!loading && !hasDraft && (
        <div className="flex flex-col items-start gap-2">
          <div className="reply-foot" style={{ marginTop: 0 }}>
            <button className="btn btn-solid" onClick={generate} disabled={generating}>
              {generating ? (
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                  Generating draft...
                </span>
              ) : (
                "Generate draft"
              )}
            </button>
            <DraftHistory conversationId={caseId} refreshKey={draftStamp} />
            <span className="ctx-line">{contextLine}</span>
          </div>
          <p className="stamp">
            Runs the Brain once for this case. Costs a single AI call. Nothing is sent until you
            review and approve.
          </p>
          {generating && (
            <div
              className="flex items-center gap-2"
              style={{
                fontSize: 13,
                color: "var(--mc-ink-2)",
                border: "1px solid var(--mc-line)",
                background: "var(--mc-page)",
                borderRadius: 8,
                padding: "8px 12px",
              }}
            >
              <span className="inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
              The Brain is reading the conversation and drafting a reply. This usually takes about a
              minute.
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
          <div className="reply-foot" style={{ marginTop: 0 }}>
            <button
              className="btn btn-sm"
              onClick={generate}
              disabled={generating}
              title="Regenerate: runs the Brain again and replaces the current draft"
            >
              {generating ? "Regenerating..." : "Regenerate draft"}
            </button>
            <DraftHistory conversationId={caseId} refreshKey={draftStamp} />
            <span className="ctx-line">{contextLine}</span>
            {genError && <span className="text-sm text-red-600">{genError}</span>}
          </div>
          <AiReviewDesk key={draftStamp} jobId={caseId} />
        </div>
      )}
    </div>
  );
}
