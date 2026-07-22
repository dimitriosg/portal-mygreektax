import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Case summary panel. Shows the cached internal summary for a case (from
// case_summaries) and lets Jim regenerate it on demand. Summarizing runs the
// Brain once (mode "summarize"): it reads the full thread plus the approved
// knowledge base, so it costs a single AI call, same control as Generate draft.

type CaseSummaryProps = {
  caseId: string; // brain_conversations.id
  caseSerialId?: string | null;
};

type SummaryRow = {
  summary: string | null;
  event_count: number | null;
  generated_at: string | null;
};

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function CaseSummary({ caseId }: CaseSummaryProps) {
  const [row, setRow] = useState<SummaryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>("");

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("case_summaries")
      .select("summary, event_count, generated_at")
      .eq("case_id", caseId)
      .maybeSingle();
    setRow((data as SummaryRow | null) ?? null);
    setLoading(false);
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  const summarize = async () => {
    setError("");
    setRunning(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/webhooks/summarize-case", {
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
          typeof payload?.detail === "string" ? payload.detail : payload?.error ?? `HTTP ${res.status}`;
        setError(`Could not summarize: ${detail}`);
        return;
      }
      if (typeof payload.summary === "string") {
        setRow({
          summary: payload.summary,
          event_count: null,
          generated_at: new Date().toISOString(),
        });
      }
      await load();
    } catch (err) {
      setError(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const hasSummary = !!row?.summary;

  return (
    <Card className="border-slate-200">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">Summary</h2>
          <div className="flex items-center gap-2">
            {hasSummary && row?.generated_at && (
              <span className="text-xs text-slate-400">Updated {formatWhen(row.generated_at)}</span>
            )}
            <Button
              variant="outline"
              onClick={summarize}
              disabled={running}
              className="h-7 px-2.5 text-xs"
              title="Run the Brain once to summarize this case, using the conversation and the knowledge base"
            >
              {running ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
                  Summarizing...
                </span>
              ) : hasSummary ? (
                "Re-summarize"
              ) : (
                "Summarize"
              )}
            </Button>
          </div>
        </div>

        {loading && <p className="text-sm text-slate-400">Loading summary...</p>}

        {!loading && !hasSummary && !running && (
          <p className="text-sm text-slate-400">
            No summary yet. Summarize runs the Brain once over the whole thread and the knowledge
            base.
          </p>
        )}

        {hasSummary && (
          <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{row?.summary}</p>
        )}

        {error && (
          <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
