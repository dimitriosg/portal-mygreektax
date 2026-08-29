import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  athensDayKey,
  athensDayLabel,
  athensFullStamp,
  athensStamp,
  isPartnerEvent,
  splitQuoted,
  type ThreadEvent,
} from "@/lib/case-thread";

// The centre of the case workspace: one chronological conversation built from
// brain_events, tabbed Client / Partner / All. Oldest first, newest at the
// bottom, sticky day dividers, every card stamped in Athens time.
//
// Quoted reply chains are folded at render time behind a per-message toggle;
// nothing is stripped from the stored rows. Partner cards are visually
// distinct and tagged INTERNAL so they can never be mistaken for client mail.
//
// The per-message "in Brain context" toggle is held in component state, on by
// default for the most recent messages. Like the old partner-thread scope
// control it replaces, nothing persists it yet: it becomes a stored column in
// the same change that teaches the drafting path to read it.

type TabId = "client" | "partner" | "all";

// How many of the newest messages start with "in Brain context" switched on.
const CONTEXT_DEFAULT_COUNT = 10;

interface Props {
  events: ThreadEvent[];
  loading: boolean;
  /** Used to label inbound client messages with the person's name. */
  clientName: string | null;
  /** brain_conversations.id, needed to trigger a partner mailbox sync. */
  conversationId: string;
  /** True when the fetch hit its row cap and older messages were left behind. */
  truncated: boolean;
  /** The Gmail sync control, owned by the route (it drives the import poll). */
  syncSlot?: ReactNode;
  /** Status line from the route's Gmail sync, shown under the header. */
  statusLine?: string;
  /** Reports how many partner messages are currently marked in context. */
  onPartnerIncludedChange?: (count: number) => void;
  /** Called after a partner sync is accepted, so the page can refresh events. */
  onSynced?: () => void;
}

function whoLabel(e: ThreadEvent, clientName: string | null): string {
  const inbound = isInbound(e);
  if (isPartnerEvent(e)) return inbound ? "Partner" : "To partner";
  return inbound ? clientName || "Client" : "You";
}

function isInbound(e: ThreadEvent): boolean {
  if (e.direction) return e.direction === "inbound";
  return e.event_type?.endsWith("_received") ?? false;
}

export function CaseThread({
  events,
  loading,
  clientName,
  conversationId,
  truncated,
  syncSlot,
  statusLine,
  onPartnerIncludedChange,
  onSynced,
}: Props) {
  const [tab, setTab] = useState<TabId>("client");
  const [openQuotes, setOpenQuotes] = useState<Set<string>>(new Set());
  const [ctxOverrides, setCtxOverrides] = useState<Record<string, boolean>>({});
  const [partnerSyncing, setPartnerSyncing] = useState(false);
  const [partnerSyncMsg, setPartnerSyncMsg] = useState("");
  const paneRef = useRef<HTMLDivElement | null>(null);

  const clientEvents = useMemo(() => events.filter((e) => !isPartnerEvent(e)), [events]);
  const partnerEvents = useMemo(() => events.filter(isPartnerEvent), [events]);
  const shown = tab === "all" ? events : tab === "client" ? clientEvents : partnerEvents;

  // The newest N messages across the whole case default to "in context".
  const defaultOn = useMemo(
    () => new Set(events.slice(-CONTEXT_DEFAULT_COUNT).map((e) => e.id)),
    [events],
  );
  const inContext = (id: string) => ctxOverrides[id] ?? defaultOn.has(id);

  const partnerIncluded = useMemo(
    () => partnerEvents.filter((e) => ctxOverrides[e.id] ?? defaultOn.has(e.id)).length,
    [partnerEvents, ctxOverrides, defaultOn],
  );
  useEffect(() => {
    onPartnerIncludedChange?.(partnerIncluded);
  }, [partnerIncluded, onPartnerIncludedChange]);

  const splits = useMemo(() => {
    const m = new Map<string, ReturnType<typeof splitQuoted>>();
    for (const e of events) m.set(e.id, splitQuoted(e.body_text ?? ""));
    return m;
  }, [events]);

  // Keep the view pinned to the newest message when the thread grows or the
  // tab changes; the reader scrolls up for history.
  useEffect(() => {
    const el = paneRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab, events.length, loading]);

  const toggleQuote = (id: string) => {
    setOpenQuotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleContext = (id: string) => {
    setCtxOverrides((prev) => ({ ...prev, [id]: !inContext(id) }));
  };

  const partnerSync = async () => {
    setPartnerSyncMsg("");
    setPartnerSyncing(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/webhooks/partner-sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ conversation_id: conversationId }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.ok) {
        const detail =
          typeof payload?.detail === "string"
            ? payload.detail
            : (payload?.error ?? `HTTP ${res.status}`);
        setPartnerSyncMsg(`Sync could not start: ${detail}`);
        return;
      }

      setPartnerSyncMsg(
        `Searching ${payload.started} partner mailbox${payload.started === 1 ? "" : "es"} for mail carrying ${payload.refCore}. Messages appear here as they import.`,
      );
      onSynced?.();
    } catch (err) {
      setPartnerSyncMsg(
        `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPartnerSyncing(false);
    }
  };

  const tabs: Array<{ id: TabId; label: string; count: number }> = [
    { id: "client", label: "Client", count: clientEvents.length },
    { id: "partner", label: "Partner", count: partnerEvents.length },
    { id: "all", label: "All", count: events.length },
  ];

  const emptyLine =
    tab === "partner"
      ? "No partner mail on this case yet. Sync the partner mailboxes to import it."
      : "No messages logged for this case yet. Use Sync from Gmail to pull the history.";

  let prevDayKey = "";
  let prevSubject: string | null = null;

  return (
    <section className="card ws-centre">
      <div className="card-head">
        <span className="seg" role="tablist" aria-label="Conversation">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label} <span className="seg-count">{t.count}</span>
            </button>
          ))}
        </span>
        <div className="head-actions">
          <span className="stamp">newest last</span>
          {tab === "partner" && (
            <button
              className="btn btn-sm inline-flex items-center gap-1.5"
              onClick={partnerSync}
              disabled={partnerSyncing}
              title="Search the partner mailboxes for mail carrying this case code"
            >
              {partnerSyncing ? (
                <>
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <RefreshCw size={12} /> Sync partner mail
                </>
              )}
            </button>
          )}
          {syncSlot}
        </div>
      </div>

      <div className="card-body">
        {statusLine && <p className="stamp">{statusLine}</p>}
        {partnerSyncMsg && <p className="stamp">{partnerSyncMsg}</p>}

        {loading && <p className="empty">Loading conversation...</p>}
        {!loading && shown.length === 0 && <p className="empty">{emptyLine}</p>}

        {!loading && shown.length > 0 && (
          <div className="tpane" ref={paneRef}>
            {truncated && (
              <p className="stamp trunc-note">
                Long history: showing the most recent messages only.
              </p>
            )}
            {shown.map((e) => {
              const dayKey = athensDayKey(e.occurred_at);
              const showDay = dayKey !== prevDayKey;
              prevDayKey = dayKey;

              const subject = e.subject?.trim() || null;
              const showSubject = subject !== null && subject !== prevSubject;
              prevSubject = subject;

              const partner = isPartnerEvent(e);
              const inbound = isInbound(e);
              const split = splits.get(e.id) ?? {
                visible: e.body_text ?? "",
                quoted: null,
                quotedLineCount: 0,
              };
              const quoteOpen = openQuotes.has(e.id);
              const included = inContext(e.id);

              return (
                <div key={e.id}>
                  {showDay && (
                    <div className="day-div">{athensDayLabel(e.occurred_at) || "Undated"}</div>
                  )}
                  <article className={`tmsg ${partner ? "t-partner" : inbound ? "t-in" : "t-out"}`}>
                    <div className="tmsg-head">
                      <span className="dir" aria-hidden="true">
                        {inbound ? "←" : "→"}
                      </span>
                      <span className="who" title={e.from_email ?? undefined}>
                        {whoLabel(e, clientName)}
                      </span>
                      {partner && <span className="tag tag-internal">INTERNAL</span>}
                      <span className="spacer" />
                      <span className="when" title={athensFullStamp(e.occurred_at)}>
                        {athensStamp(e.occurred_at)}
                      </span>
                    </div>

                    {showSubject && <p className="msg-subject">{subject}</p>}

                    <p className="t-body">{split.visible}</p>

                    {split.quoted !== null && quoteOpen && (
                      <div className="quoted">{split.quoted}</div>
                    )}

                    <div className="tmsg-foot">
                      {split.quoted !== null && (
                        <button className="qtoggle" onClick={() => toggleQuote(e.id)}>
                          {quoteOpen
                            ? "Hide quoted text"
                            : `Show quoted text, ${split.quotedLineCount} line${
                                split.quotedLineCount === 1 ? "" : "s"
                              }`}
                        </button>
                      )}
                      <button
                        className="ctx-toggle"
                        aria-pressed={included}
                        onClick={() => toggleContext(e.id)}
                        title={
                          included
                            ? "Handed to the Brain when a draft is generated"
                            : "Left out when a draft is generated"
                        }
                      >
                        <span className="ctx-box" aria-hidden="true" />
                        in Brain context
                      </button>
                    </div>
                  </article>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
