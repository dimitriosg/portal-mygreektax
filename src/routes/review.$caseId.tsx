import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { updateLead } from "@/lib/leads.functions";
import { CLIENT_STAGES } from "@/lib/leads-shared";
import { CaseSummary } from "@/components/case-summary";
import { CaseNotes } from "@/components/CaseNotes";
import { CaseThread } from "@/components/case-thread";
import { CaseRail } from "@/components/case-rail";
import { CaseDraftDesk } from "@/components/case-draft-desk";
import { CaseKnowledge } from "@/components/case-knowledge";
import { CaseComposer } from "@/components/case-composer";
import { getCaseRail, type CaseRailData } from "@/lib/case-workspace.functions";
import { isPartnerEvent, type ThreadEvent } from "@/lib/case-thread";
import type { DraftVersionRow } from "@/lib/case-draft-versions";
import { getErrorMessage } from "@/lib/auth-errors";

// Case workspace. The route param $caseId is a brain_conversations.id.
//
// One screen, three zones: a left rail (who the client is, the money, the open
// items), a centre conversation built from brain_events with tabbed Client /
// Partner / All threads, and a right desk (draft, notes, summary, knowledge).
// One composer sits below the workspace and can write to either party, with
// the same rules binding both.
//
// The header exposes the linked lead's Stage / Next action / Next action date.
// These are the same public.clients columns the /leads page edits, saved
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
  nationality: string | null;
  afm: string | null;
  taxisnet_access: boolean | null;
  quote_amount: number | null;
  deposit: number | null;
  balance_due: number | null;
}

type DeskTab = "draft" | "notes" | "summary" | "knowledge";

const DESK_TABS: Array<{ id: DeskTab; label: string }> = [
  { id: "draft", label: "Draft" },
  { id: "notes", label: "Notes" },
  { id: "summary", label: "Summary" },
  { id: "knowledge", label: "Knowledge" },
];

// brain_events fetch cap. Fetched newest-first so a long history loses its
// oldest messages, not its newest, then reversed so the thread reads oldest
// first. The largest real case holds ~400 rows; normal cases sit far below.
const EVENT_FETCH_LIMIT = 500;

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

export const Route = createFileRoute("/review/$caseId")({
  component: ReviewCase,
});

function ReviewCase() {
  const { caseId } = Route.useParams(); // brain_conversations.id
  const [conversation, setConversation] = useState<ConversationInfo | null>(null);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  // Total rows in the database for this case, which can exceed the fetched
  // window; drives the truncation notice and the sync progress counter.
  const [eventTotal, setEventTotal] = useState(0);
  const [eventsTruncated, setEventsTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string>("");
  const [hasDraft, setHasDraft] = useState(false);
  // case_drafts.proposed_draft: what the send desk below the thread will send.
  // The Draft tab reads case_draft_versions and compares against this, so a
  // generation the version trigger failed to record is visible rather than
  // silently presented as the current draft.
  const [draftText, setDraftText] = useState<string>("");
  // case_drafts.is_approved: this draft has already been sent. The Brain's
  // upsert resets it to false on every regeneration, so it describes the draft
  // currently in the row rather than the case as a whole.
  const [draftApproved, setDraftApproved] = useState(false);
  const [draftStamp, setDraftStamp] = useState<string>("none");
  // The newest case_draft_versions row, reported up by the Draft tab so the
  // Knowledge tab can show what that version drew on.
  const [currentVersion, setCurrentVersion] = useState<DraftVersionRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string>("");
  const [deskTab, setDeskTab] = useState<DeskTab>("draft");

  // Left-rail money and open items, via the admin server fn (payments and jobs
  // have no browser RLS policies).
  const [rail, setRail] = useState<CaseRailData | null>(null);
  const [railError, setRailError] = useState<string>("");

  // Editable lead fields (draft state, seeded once from the client row).
  const [stageDraft, setStageDraft] = useState<string>("");
  const [nextActionDraft, setNextActionDraft] = useState<string>("");
  const [nextActionDateDraft, setNextActionDateDraft] = useState<string>("");
  const [leadSaveMsg, setLeadSaveMsg] = useState<string>("");
  const seededRef = useRef<string | null>(null);

  const updateLeadFn = useServerFn(updateLead);
  const getCaseRailFn = useServerFn(getCaseRail);

  // Sync progress tracking (refs so the poll interval reads fresh values).
  const syncRef = useRef<{ start: number; lastActivity: number; baseline: number } | null>(null);
  const eventCountRef = useRef(0);
  const prevCountRef = useRef(0);
  // Monotonic guard: overlapping load() calls (realtime fires one per insert)
  // can resolve out of order, and an older snapshot must not overwrite a newer
  // one. Only the most recently started load commits its results.
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;

    const { data: convData } = await supabase
      .from("brain_conversations")
      .select("id, case_serial_id, customer_email, stage, client_id")
      .eq("id", caseId)
      .maybeSingle();
    const conv = (convData as ConversationInfo | null) ?? null;

    let clientRow: ClientInfo | null = null;
    if (conv?.client_id) {
      const { data: clientData } = await supabase
        .from("clients")
        .select(
          "full_name, email, client_code, stage, next_action, next_action_date, nationality, afm, taxisnet_access, quote_amount, deposit, balance_due",
        )
        .eq("id", conv.client_id)
        .maybeSingle();
      clientRow = (clientData as ClientInfo | null) ?? null;
    }

    // Newest first so the cap trims history, not the present; reversed so the
    // thread renders oldest first, newest at the bottom. The exact count keeps
    // the truncation notice and the sync progress honest past the cap.
    const { data: eventData, count: eventCount } = await supabase
      .from("brain_events")
      .select("id, event_type, actor, direction, from_email, subject, body_text, occurred_at", {
        count: "exact",
      })
      .eq("conversation_id", caseId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(EVENT_FETCH_LIMIT);
    const rows = ((eventData as ThreadEvent[] | null) ?? []).slice().reverse();
    const total = eventCount ?? rows.length;

    // Does a draft already exist for this case?
    const { data: draftData } = await supabase
      .from("case_drafts")
      .select("case_id, proposed_draft, last_updated, is_approved")
      .eq("case_id", caseId)
      .maybeSingle();

    if (seq !== loadSeqRef.current) return;

    setConversation(conv);
    if (conv?.client_id) setClient(clientRow);
    setEvents(rows);
    setEventTotal(total);
    setEventsTruncated(total > rows.length);
    setHasDraft(!!draftData?.proposed_draft);
    setDraftText((draftData?.proposed_draft as string) || "");
    setDraftApproved(Boolean(draftData?.is_approved));
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

  // The rail data only moves when the linked client changes (payments and jobs
  // have no realtime feed here), so it loads once per client, not per load().
  const clientId = conversation?.client_id ?? null;
  useEffect(() => {
    if (!clientId) {
      setRail(null);
      setRailError("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await getCaseRailFn({ data: { clientId } });
        if (!cancelled) {
          setRail(data);
          setRailError("");
        }
      } catch (err) {
        if (!cancelled) {
          setRail(null);
          setRailError(`Could not load payments and jobs: ${getErrorMessage(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, getCaseRailFn]);

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

  // Track the database event count (not the fetched window, which pins at the
  // cap) and, during a sync, note when it grows (activity).
  useEffect(() => {
    const grew = eventTotal > prevCountRef.current;
    prevCountRef.current = eventTotal;
    eventCountRef.current = eventTotal;
    if (syncing && syncRef.current && grew) {
      syncRef.current.lastActivity = Date.now();
    }
  }, [eventTotal, syncing]);

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
    syncRef.current = { start: Date.now(), lastActivity: Date.now(), baseline: eventTotal };
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

  const syncSlot = (
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
  );

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

      {/* The workspace: left rail, conversation, desk. */}
      <div className="ws">
        <aside className="ws-rail">
          <CaseRail client={client} rail={rail} railError={railError} loading={loading} />
        </aside>

        <CaseThread
          events={events}
          loading={loading}
          clientName={client?.full_name ?? null}
          conversationId={caseId}
          truncated={eventsTruncated}
          syncSlot={syncSlot}
          statusLine={syncMsg}
          onSynced={load}
        />

        <aside className="ws-desk">
          <section className="card">
            <div className="desk-tabs" role="tablist" aria-label="Case desk">
              {DESK_TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={deskTab === t.id}
                  onClick={() => setDeskTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tabs stay mounted (hidden, not unmounted) so notes keep loading
                and in-progress edits survive a tab switch. */}
            <div className="desk-body" hidden={deskTab !== "draft"}>
              <CaseDraftDesk
                conversationId={caseId}
                refreshKey={draftStamp}
                currentDraftText={draftText}
                currentDraftUpdatedAt={draftStamp === "none" ? null : draftStamp}
                draftApproved={draftApproved}
                onCurrentVersionChange={setCurrentVersion}
                generateSlot={
                  <>
                    <div className="reply-foot" style={{ marginTop: 0 }}>
                      <button
                        className={hasDraft ? "btn btn-sm" : "btn btn-solid btn-sm"}
                        onClick={generate}
                        disabled={generating}
                        title={
                          hasDraft
                            ? "Regenerate: runs the Brain again and adds a new version"
                            : "Runs the Brain once for this case. Costs a single AI call."
                        }
                      >
                        {generating
                          ? hasDraft
                            ? "Regenerating..."
                            : "Generating..."
                          : hasDraft
                            ? "Regenerate draft"
                            : "Generate draft"}
                      </button>
                    </div>
                    {/* The Brain currently reads the whole thread; per-message
                        and per-note selection is not wired into drafting yet,
                        so no claim about included context is made here. */}
                    <p className="stamp">
                      Runs the Brain once over the full case thread. The in-context toggles are not
                      read by drafting yet.
                    </p>

                    {generating && (
                      <p className="empty">
                        The Brain is reading the conversation and drafting a reply. This usually
                        takes about a minute.
                      </p>
                    )}
                    {genError && (
                      <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
                        {genError}
                      </p>
                    )}
                  </>
                }
              />
            </div>

            <div className="desk-body" hidden={deskTab !== "notes"}>
              <CaseNotes conversationId={caseId} />
            </div>

            <div className="desk-body desk-flush" hidden={deskTab !== "summary"}>
              <CaseSummary caseId={caseId} caseSerialId={conversation?.case_serial_id ?? null} />
            </div>

            <div className="desk-body" hidden={deskTab !== "knowledge"}>
              <CaseKnowledge currentVersion={currentVersion} />
            </div>
          </section>
        </aside>
      </div>

      {/* One composer for both directions. It replaces the separate client and
          partner boxes: the same R2 and R7 checks bind whichever target is
          selected, which is the reason for merging them. The old boxes and the
          review desk are superseded and removed in PR 4, once nothing else
          depends on them. */}
      {/* Keyed on the case so none of the composer's state can outlive it.
          The route component is reused when :caseId changes, and everything
          the composer holds is case-specific: a half-written body, a loaded
          Brain draft, an in-flight generate poll. Carrying any of that into
          another case would mean writing to one client and sending to the
          next. No link in the app goes case to case today, so this is not a
          live path; it costs one attribute to make it impossible before one
          exists. */}
      <CaseComposer
        key={caseId}
        conversationId={caseId}
        caseSerialId={conversation?.case_serial_id ?? null}
        clientName={client?.full_name ?? null}
        clientEmail={email || null}
        // brain_conversations.stage is the fallback so a case with no linked
        // client row still gates: without it clientStage is null, the gate
        // reads "not before deposit", and R7 would let gated content through
        // on exactly the cases we know least about. Same precedence /drafts
        // already uses.
        clientStage={client?.stage ?? conversation?.stage ?? null}
        // A recorded deposit opens the gate whatever the stage says, which is
        // what keeps a paid case that was later parked from being gated.
        clientDeposit={client?.deposit ?? null}
        events={events}
        // case_drafts.proposed_draft is what the send path sends, and it is
        // the only one of the two that always exists for a drafted case. The
        // version row is passed alongside it purely to attribute the send.
        currentDraftText={draftText}
        currentDraftApproved={draftApproved}
        currentVersion={currentVersion}
        onSent={load}
      />
    </div>
  );
}
