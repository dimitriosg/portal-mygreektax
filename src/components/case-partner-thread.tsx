import { useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

// Partner thread pane.
//
// Sits beside the client conversation and holds correspondence with the
// accountant partner. Deliberately quarantined: partner messages never render
// in the client pane, so there is no way to mistake one for the other at a
// glance.
//
// Nothing ingests partner mail yet, so this pane is empty on every case today.
// It is built now so the layout is settled before the ingestion work lands.
//
// The scope control decides how much of the thread is handed to the Brain when
// a draft is generated. It is held in component state for now: the Brain has
// not been taught to read partner context yet, so persisting the choice would
// be storing a preference nothing consumes. It becomes a stored column in the
// same change that teaches the Lambda to use it.

export interface PartnerEvent {
  id: string;
  actor: string | null;
  direction: string | null;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  occurred_at: string | null;
}

type Scope = "all" | "last_n";

interface Props {
  events: PartnerEvent[];
  loading?: boolean;
  /** brain_conversations.id, needed to trigger a partner mailbox sync. */
  conversationId: string;
  /** Reports how many partner messages are currently in scope for drafting. */
  onIncludedCountChange?: (count: number) => void;
  /** Called after a sync is accepted, so the page can refresh events. */
  onSynced?: () => void;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function labelFor(e: PartnerEvent): string {
  if (e.direction === "outbound" || e.actor === "dimitris") return "You";
  return "Partner";
}

export function CasePartnerThread({
  events,
  loading,
  conversationId,
  onIncludedCountChange,
  onSynced,
}: Props) {
  const [scope, setScope] = useState<Scope>("all");
  const [lastN, setLastN] = useState(5);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  const inScope = useMemo(() => {
    const window =
      scope === "all" ? events : events.slice(Math.max(0, events.length - Math.max(1, lastN)));
    const windowIds = new Set(window.map((e) => e.id));
    return new Set(
      events.filter((e) => windowIds.has(e.id) && !excluded.has(e.id)).map((e) => e.id),
    );
  }, [events, scope, lastN, excluded]);

  useEffect(() => {
    onIncludedCountChange?.(inScope.size);
  }, [inScope, onIncludedCountChange]);

  const sync = async () => {
    setSyncMsg("");
    setSyncing(true);
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
        setSyncMsg(`Sync could not start: ${detail}`);
        return;
      }

      setSyncMsg(
        `Searching ${payload.started} partner mailbox${payload.started === 1 ? "" : "es"} for mail carrying ${payload.refCore}. Messages appear here as they import.`,
      );
      setCollapsed(false);
      onSynced?.();
    } catch (err) {
      setSyncMsg(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  const toggle = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      <div className="ctrl-row">
        <span className="ctrl-label">Send to the Brain</span>
        <span className="seg">
          <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>
            All
          </button>
          <button aria-pressed={scope === "last_n"} onClick={() => setScope("last_n")}>
            Last N
          </button>
        </span>
        {scope === "last_n" && (
          <span className="numwrap">
            <input
              type="number"
              min={1}
              max={99}
              value={lastN}
              onChange={(e) => setLastN(Math.max(1, Number(e.target.value) || 1))}
              className="mc-input"
            />
            <span className="ctrl-label">most recent</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            className="btn btn-sm inline-flex items-center gap-1.5"
            onClick={sync}
            disabled={syncing}
            title="Search the partner mailboxes for mail carrying this case code"
          >
            {syncing ? (
              <>
                <span className="inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <RefreshCw size={12} /> Sync from Gmail
              </>
            )}
          </button>
          {events.length > 0 && (
            <button className="btn btn-sm" onClick={() => setCollapsed((c) => !c)}>
              {collapsed ? `Show (${events.length})` : "Collapse"}
            </button>
          )}
        </span>
      </div>

      {syncMsg && <p className="stamp">{syncMsg}</p>}

      {loading && <p className="empty">Loading...</p>}

      {!loading && events.length === 0 && (
        <p className="empty">
          No partner correspondence on this case. Partner mail is not being imported yet.
        </p>
      )}

      {!loading && events.length > 0 && collapsed && (
        <p className="empty">
          Partner thread collapsed. {events.length} message{events.length === 1 ? "" : "s"} hidden.
        </p>
      )}

      {!loading && !collapsed && (
        <div className="pane">
          {events.map((e) => {
            const included = inScope.has(e.id);
            return (
              <div key={e.id} className={`msg msg-partner ${included ? "" : "excluded"}`}>
                <div className="msg-head">
                  <span className="who">{labelFor(e)}</span>
                  <span className="when">{formatWhen(e.occurred_at)}</span>
                  <span className="spacer" />
                  <button
                    onClick={() => toggle(e.id)}
                    title={
                      included
                        ? "Included when a draft is generated"
                        : "Excluded when a draft is generated"
                    }
                    className={`icon-btn ${included ? "pill-ok" : "pill-off"}`}
                  >
                    {included ? <Check size={14} /> : <X size={14} />}
                  </button>
                </div>
                {e.subject && <p className="msg-subject">Subject: {e.subject}</p>}
                <p>{e.body_text ?? ""}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
