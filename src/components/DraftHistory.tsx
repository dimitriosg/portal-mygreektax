import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

// Draft history. Every Brain generation for a case, newest first.
//
// case_drafts holds only the current draft (it is upserted on case_id, so a
// regenerate overwrites the previous one). case_draft_versions is the append
// only record: what the Brain wrote, what context it was given, and what was
// actually sent.
//
// The button renders the count and stays visible whether or not the reply
// section is expanded, so the history is reachable without opening anything.

export interface DraftVersion {
  id: string;
  version_no: number;
  draft_text: string;
  compliance_insights: string | null;
  context_used: Record<string, unknown> | null;
  generated_at: string;
  sent_at: string | null;
  sent_mode: "as_is" | "edited" | null;
}

interface Props {
  conversationId: string;
  /** Pull an old version back into the reply editor. Does not send anything. */
  onLoadIntoReply?: (version: DraftVersion) => void;
  /** Bump to force a reload after a new draft is generated. */
  refreshKey?: string | number;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function describeContext(ctx: Record<string, unknown> | null): string {
  if (!ctx) return "";
  const parts: string[] = [];
  const n = (k: string) => (typeof ctx[k] === "number" ? (ctx[k] as number) : null);
  const client = n("client_messages");
  const partner = n("partner_messages");
  const notes = n("notes");
  if (client !== null) parts.push(`${client} client messages`);
  if (partner !== null) parts.push(`${partner} partner messages`);
  if (notes !== null) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function DraftHistory({ conversationId, onLoadIntoReply, refreshKey }: Props) {
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("case_draft_versions")
      .select(
        "id, version_no, draft_text, compliance_insights, context_used, generated_at, sent_at, sent_mode",
      )
      .eq("conversation_id", conversationId)
      .order("version_no", { ascending: false });

    if (err) {
      setError(`Could not load draft history: ${err.message}`);
      setVersions([]);
    } else {
      setError("");
      setVersions((data as DraftVersion[] | null) ?? []);
    }
  }, [conversationId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        className="btn btn-sm hist-head"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Every draft generated for this case"
      >
        Drafts ({versions.length})
      </button>

      {open && (
        <div
          className="mgt-case-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Draft history (${versions.length})`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="mgt-case-sheet">
            <div className="sheet-head">
              <h2>Draft history ({versions.length})</h2>
              <div className="head-actions">
                <button
                  className="icon-btn"
                  onClick={() => setOpen(false)}
                  title="Close"
                  aria-label="Close draft history"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="sheet-body">
              {error && (
                <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
                  {error}
                </p>
              )}

              {!error && versions.length === 0 && (
                <p className="empty">No drafts generated for this case yet.</p>
              )}

              {versions.map((v, idx) => (
                <div key={v.id} className="ver">
                  <div className="ver-head">
                    <span className="ver-no">v{v.version_no}</span>
                    <span className="when">{formatWhen(v.generated_at)}</span>
                    {v.sent_at ? (
                      <span className="badge-sent">
                        Sent ({v.sent_mode === "edited" ? "edited" : "as is"})
                      </span>
                    ) : idx === 0 ? null : (
                      <span className="badge-super">Superseded</span>
                    )}
                    {onLoadIntoReply && (
                      <span className="ver-acts">
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            onLoadIntoReply(v);
                            setOpen(false);
                          }}
                        >
                          Load into reply
                        </button>
                      </span>
                    )}
                  </div>

                  <div className="ver-body">{v.draft_text}</div>

                  {v.compliance_insights && (
                    <div className="insights" style={{ marginTop: 11 }}>
                      <div className="insights-head">
                        <span className="lbl">Brain technical compliance insights</span>
                        <span className="tag tag-internal">Internal</span>
                      </div>
                      <p>{v.compliance_insights}</p>
                    </div>
                  )}

                  {describeContext(v.context_used) && (
                    <div className="ver-ctx">
                      Context at generation: {describeContext(v.context_used)}
                      {v.sent_mode === "edited"
                        ? " · the text above is what the Brain wrote, not what was sent"
                        : ""}
                    </div>
                  )}
                </div>
              ))}

              <p className="stamp" style={{ marginTop: 14 }}>
                Every generation is kept. Drafts live apart from the conversation history, so
                loading an old one here changes nothing the client has seen.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
