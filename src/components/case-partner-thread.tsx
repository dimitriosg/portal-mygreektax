import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

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
          typeof payload?.detail === "string" ? payload.detail : payload?.error ?? `HTTP ${res.status}`;
        setSyncMsg(`Sync could not start: ${detail}`);
        return;
      }

      setSyncMsg(
        `Searching ${payload.started} partner mailbox${payload.started === 1 ? "" : "es"} for mail carrying ${payload.refCore}. Messages appear here as they import.`,
      );
      setCollapsed(false);
      onSynced?.();
    } catch (err) {
      setSyncMsg(
        `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap pb-3 border-b border-dashed border-slate-200">
        <span className="text-xs text-slate-500">Send to the Brain</span>
        <Button
          variant={scope === "all" ? "default" : "outline"}
          onClick={() => setScope("all")}
          className={`h-7 px-2.5 text-xs ${scope === "all" ? "bg-[#0B192C] text-white" : ""}`}
        >
          All
        </Button>
        <Button
          variant={scope === "last_n" ? "default" : "outline"}
          onClick={() => setScope("last_n")}
          className={`h-7 px-2.5 text-xs ${scope === "last_n" ? "bg-[#0B192C] text-white" : ""}`}
        >
          Last N
        </Button>
        {scope === "last_n" && (
          <input
            type="number"
            min={1}
            max={99}
            value={lastN}
            onChange={(e) => setLastN(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 rounded-md border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            onClick={sync}
            disabled={syncing}
            className="h-7 px-2.5 text-xs"
            title="Search the partner mailboxes for mail carrying this case code"
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
          {events.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setCollapsed((c) => !c)}
              className="h-7 px-2.5 text-xs"
            >
              {collapsed ? `Show (${events.length})` : "Collapse"}
            </Button>
          )}
        </span>
      </div>

      {syncMsg && <p className="text-xs text-slate-500">{syncMsg}</p>}

      {loading && <p className="text-sm text-slate-400">Loading...</p>}

      {!loading && events.length === 0 && (
        <p className="text-sm text-slate-400">
          No partner correspondence on this case. Partner mail is not being imported yet.
        </p>
      )}

      {!loading && events.length > 0 && collapsed && (
        <p className="text-xs text-slate-400 italic">
          Partner thread collapsed. {events.length} message{events.length === 1 ? "" : "s"} hidden.
        </p>
      )}

      {!loading && !collapsed && (
        <div className="h-[320px] overflow-y-auto pr-1 space-y-4">
          {events.map((e) => {
            const included = inScope.has(e.id);
            return (
              <div key={e.id} className="border-l-2 border-amber-300 pl-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-700">{labelFor(e)}</span>
                  <span className="text-xs text-slate-400">{formatWhen(e.occurred_at)}</span>
                  <button
                    onClick={() => toggle(e.id)}
                    title={
                      included
                        ? "Included when a draft is generated"
                        : "Excluded when a draft is generated"
                    }
                    className={`ml-auto text-xs px-1.5 py-0.5 rounded hover:bg-slate-100 ${
                      included ? "text-emerald-700" : "text-slate-400"
                    }`}
                  >
                    {included ? "In" : "Out"}
                  </button>
                </div>
                {e.subject && <p className="text-xs text-slate-500 mt-1">Subject: {e.subject}</p>}
                <p
                  className={`text-sm whitespace-pre-wrap mt-1 ${
                    included ? "text-slate-600" : "text-slate-400"
                  }`}
                >
                  {e.body_text ?? ""}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
