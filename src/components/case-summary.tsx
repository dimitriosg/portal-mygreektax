import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

// Case summary panel. Summarizing is asynchronous: the server accepts the job
// (202) and the Brain writes the result to case_summaries in the background.
// We poll that table until generated_at moves past the baseline we were given.
//
// case_summaries holds one markdown blob per case, so the split between the
// customer profile and the case itself is done here by reading headings. If the
// summary contains a "customer profile" heading, everything under it up to the
// next heading renders as the profile block and the rest renders as the case
// summary. If it does not, the whole thing renders as one block, which is what
// happens today until the Brain is taught to emit the sections.

type CaseSummaryProps = {
  caseId: string; // brain_conversations.id
  caseSerialId?: string | null;
};

type SummaryRow = {
  summary: string | null;
  event_count: number | null;
  generated_at: string | null;
};

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180000; // 3 minutes

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Split the markdown into a profile section and everything else. Matches a
// heading whose text starts with "customer profile" or "client profile",
// case-insensitively. Returns profile === null when no such heading exists.
function splitSummary(text: string): { profile: string | null; rest: string } {
  const lines = text.split("\n");
  const isHeading = (l: string) => /^#{1,6}\s+/.test(l.trim());
  const startIdx = lines.findIndex(
    (l) => isHeading(l) && /^#{1,6}\s+(customer|client)\s+profile\b/i.test(l.trim()),
  );
  if (startIdx === -1) return { profile: null, rest: text };

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const profile = lines
    .slice(startIdx + 1, endIdx)
    .join("\n")
    .trim();
  const rest = [...lines.slice(0, startIdx), ...lines.slice(endIdx)].join("\n").trim();
  return { profile: profile || null, rest };
}

function renderMarkdown(text: string) {
  return text.split("\n").map((raw, i) => {
    const line = raw.trim();
    if (!line) return null;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const content = heading ? heading[1] : bullet ? bullet[1] : line;

    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.length > 4 && p.startsWith("**") && p.endsWith("**") ? (
        <strong key={j} style={{ fontWeight: 600, color: "var(--mc-ink)" }}>
          {p.slice(2, -2)}
        </strong>
      ) : (
        p
      ),
    );

    if (heading) {
      return (
        <p
          key={i}
          style={{
            fontSize: "12.5px",
            fontWeight: 600,
            color: "var(--mc-ink)",
            margin: "10px 0 4px",
          }}
        >
          {parts}
        </p>
      );
    }
    if (bullet) {
      return (
        <p key={i} style={{ paddingLeft: 16 }}>
          • {parts}
        </p>
      );
    }
    return <p key={i}>{parts}</p>;
  });
}

export function CaseSummary({ caseId }: CaseSummaryProps) {
  const [row, setRow] = useState<SummaryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>("");
  // Open once a summary has loaded. This panel is reached by choosing the
  // Summary tab, so starting collapsed answered that choice with the words
  // "Summary collapsed." and nothing else on every case that already has one.
  // The control stays, for folding a long summary back out of the way.
  const [expanded, setExpanded] = useState(true);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const fetchRow = useCallback(async (): Promise<SummaryRow | null> => {
    const { data } = await supabase
      .from("case_summaries")
      .select("summary, event_count, generated_at")
      .eq("case_id", caseId)
      .maybeSingle();
    return (data as SummaryRow | null) ?? null;
  }, [caseId]);

  const load = useCallback(async () => {
    const data = await fetchRow();
    if (cancelled.current) return;
    setRow(data);
    setLoading(false);
  }, [fetchRow]);

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
          typeof payload?.detail === "string"
            ? payload.detail
            : (payload?.error ?? `HTTP ${res.status}`);
        setError(`Could not start the summary: ${detail}`);
        return;
      }

      const baseline: string | null = payload.previousGeneratedAt ?? null;
      const startedAt = Date.now();

      while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);
        if (cancelled.current) return;

        const fresh = await fetchRow();
        if (cancelled.current) return;

        const isNew = !!fresh?.generated_at && (!baseline || fresh.generated_at !== baseline);

        if (isNew) {
          setRow(fresh);
          setExpanded(true);
          return;
        }
      }

      setError(
        "The summary is taking longer than expected. It may still finish, so try reloading the page in a minute.",
      );
    } catch (err) {
      setError(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (!cancelled.current) setRunning(false);
    }
  };

  const hasSummary = !!row?.summary;
  const split = hasSummary ? splitSummary(row!.summary!) : { profile: null, rest: "" };

  const bodyOpen = hasSummary ? expanded : true;

  return (
    <section className="card" data-open={bodyOpen}>
      <div className="card-head">
        {hasSummary && (
          <button
            className="disc"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse summary" : "Expand summary"}
          >
            <ChevronRight size={15} />
          </button>
        )}
        <h2>Summary</h2>
        <span className="stamp" style={{ marginLeft: 4 }}>
          client and partner combined
        </span>
        <div className="head-actions">
          {hasSummary && row?.generated_at && (
            <span className="stamp" style={{ marginRight: 4 }}>
              Updated {formatWhen(row.generated_at)}
              {typeof row.event_count === "number"
                ? `, over ${row.event_count} message${row.event_count === 1 ? "" : "s"}`
                : ""}
            </span>
          )}
          <button
            className="btn btn-sm"
            onClick={summarize}
            disabled={running}
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
          </button>
        </div>
      </div>

      <div className="card-body">
        {loading && <p className="empty">Loading summary...</p>}

        {!loading && !hasSummary && !running && (
          <p className="empty">
            No summary yet. Summarize runs the Brain once over the whole thread and the knowledge
            base.
          </p>
        )}

        {running && <p className="empty">Working on it. This usually takes about a minute.</p>}

        {hasSummary && expanded && (
          <div className="max-h-[280px] overflow-y-auto pr-1">
            {split.profile && (
              <div className="sum-block">
                <div className="sum-label">Customer profile</div>
                {renderMarkdown(split.profile)}
              </div>
            )}
            {split.rest && (
              <div className="sum-block">
                {split.profile && <div className="sum-label">Case summary</div>}
                {renderMarkdown(split.rest)}
              </div>
            )}
          </div>
        )}

        {hasSummary && !expanded && <p className="empty">Summary collapsed.</p>}

        {error && (
          <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
