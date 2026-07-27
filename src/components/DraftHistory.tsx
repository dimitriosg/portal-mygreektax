import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

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
      <Button
        variant="outline"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Every draft generated for this case"
        className="h-7 px-2.5 text-xs"
      >
        Drafts ({versions.length})
      </Button>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 flex items-start justify-center p-4 sm:p-10 z-50 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full">
            <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-200">
              <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
                Draft history ({versions.length})
              </h2>
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                className="ml-auto h-7 px-2.5 text-xs"
              >
                Close
              </Button>
            </div>

            <div className="p-5 space-y-4">
              {error && (
                <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
                  {error}
                </p>
              )}

              {!error && versions.length === 0 && (
                <p className="text-sm text-slate-500">
                  No drafts generated for this case yet.
                </p>
              )}

              {versions.map((v, idx) => (
                <div key={v.id} className="border border-slate-200 rounded-lg p-4">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="font-mono text-xs text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">
                      v{v.version_no}
                    </span>
                    <span className="text-xs text-slate-400">{formatWhen(v.generated_at)}</span>
                    {v.sent_at ? (
                      <span className="text-xs text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5">
                        Sent ({v.sent_mode === "edited" ? "edited" : "as is"})
                      </span>
                    ) : idx === 0 ? null : (
                      <span className="text-xs text-slate-400 bg-slate-100 rounded px-1.5 py-0.5">
                        Superseded
                      </span>
                    )}
                    {onLoadIntoReply && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          onLoadIntoReply(v);
                          setOpen(false);
                        }}
                        className="ml-auto h-7 px-2.5 text-xs"
                      >
                        Load into reply
                      </Button>
                    )}
                  </div>

                  <p className="text-sm text-slate-700 whitespace-pre-wrap border-l-2 border-slate-200 pl-3">
                    {v.draft_text}
                  </p>

                  {v.compliance_insights && (
                    <div className="mt-3 border border-slate-200 bg-slate-50 rounded p-3">
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
                        Brain technical compliance insights
                      </p>
                      <p className="text-xs text-slate-600 whitespace-pre-wrap">
                        {v.compliance_insights}
                      </p>
                    </div>
                  )}

                  {describeContext(v.context_used) && (
                    <p className="text-xs text-slate-400 mt-2">
                      Context at generation: {describeContext(v.context_used)}
                      {v.sent_mode === "edited"
                        ? ". The text above is what the Brain wrote, not what was sent."
                        : ""}
                    </p>
                  )}
                </div>
              ))}

              <p className="text-xs text-slate-400">
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
