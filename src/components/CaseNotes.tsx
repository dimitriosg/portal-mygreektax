import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Pin, Trash2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

// Case notes. Free standing operator notes attached to a conversation.
//
// These are Jim's own working notes, not events. They are mutable (edit and
// delete), which is why they live in case_notes rather than brain_events.
//
// include_in_ai controls whether a note is passed to the Brain when a draft is
// generated. Pinned notes sort first and act as the standing case brief.
//
// case_notes is admin only at the RLS level, so a partner session sees nothing
// here. Errors are surfaced rather than swallowed: a permission failure must
// read as an error, not as an empty list.
//
// Delete is two step. Pressing Delete swaps that row's controls for a
// "Delete note?" prompt. Pressing Yes clears the prompt immediately and shows a
// non-interactive "Deleting..." state until the request settles, so a second
// click cannot fire a second delete.

interface Note {
  id: string;
  body: string;
  pinned: boolean;
  include_in_ai: boolean;
  created_at: string;
  updated_at: string;
}

interface Props {
  conversationId: string;
  /** Called whenever the set of AI-included notes changes, so the parent can
   *  keep the "will be included" line next to Generate draft accurate. */
  onIncludedCountChange?: (count: number) => void;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function CaseNotes({ conversationId, onIncludedCountChange }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [pinNew, setPinNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("case_notes")
      .select("id, body, pinned, include_in_ai, created_at, updated_at")
      .eq("conversation_id", conversationId)
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });

    if (err) {
      setError(`Could not load notes: ${err.message}`);
      setNotes([]);
    } else {
      setError("");
      setNotes((data as Note[] | null) ?? []);
    }
    setLoading(false);
  }, [conversationId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    onIncludedCountChange?.(notes.filter((n) => n.include_in_ai).length);
  }, [notes, onIncludedCountChange]);

  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    setError("");

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const { error: err } = await supabase.from("case_notes").insert({
      conversation_id: conversationId,
      body,
      pinned: pinNew,
      include_in_ai: true,
      author_user_id: session?.user?.id ?? null,
    });

    if (err) {
      setError(`Could not save the note: ${err.message}`);
    } else {
      setDraft("");
      setPinNew(false);
      await load();
    }
    setSaving(false);
  };

  const patch = async (id: string, changes: Partial<Note>) => {
    setError("");
    const { error: err } = await supabase
      .from("case_notes")
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (err) setError(`Could not update the note: ${err.message}`);
    else await load();
  };

  const remove = async (id: string) => {
    // Guard against a second click landing while the first is in flight.
    if (deletingId) return;
    setError("");
    setConfirmId(null);
    setDeletingId(id);
    try {
      const { error: err } = await supabase.from("case_notes").delete().eq("id", id);
      if (err) setError(`Could not delete the note: ${err.message}`);
      else await load();
    } finally {
      setDeletingId(null);
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const body = editText.trim();
    if (!body) return;
    await patch(editingId, { body });
    setEditingId(null);
    setEditText("");
  };

  return (
    <div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder="Client mentioned a UK property, check the treaty tie-breaker"
        className="mc-input"
      />
      <div className="flex items-center gap-3" style={{ margin: "8px 0 14px" }}>
        <button className="btn btn-sm" onClick={add} disabled={saving || !draft.trim()}>
          {saving ? "Saving..." : "Save note"}
        </button>
        <label className="flex items-center gap-1.5 ctrl-label">
          <input
            type="checkbox"
            checked={pinNew}
            onChange={(e) => setPinNew(e.target.checked)}
            style={{ width: "auto" }}
          />
          pin
        </label>
      </div>

      {error && (
        <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
          {error}
        </p>
      )}

      {loading && <p className="empty">Loading notes...</p>}

      {!loading && notes.length === 0 && !error && (
        <p className="empty">
          No notes yet. Anything written here reaches the Brain but never the client.
        </p>
      )}

      <div className="max-h-[280px] overflow-y-auto pr-1">
        {notes.map((n) => {
          const isDeleting = deletingId === n.id;
          const isConfirming = confirmId === n.id && !isDeleting;

          return (
            <div key={n.id} className={`note ${n.include_in_ai ? "" : "excluded"}`}>
              <div className="note-head">
                {n.pinned ? (
                  <span className="pinned-flag">
                    <Pin size={12} />
                    Pinned
                  </span>
                ) : (
                  <span className="when">{formatWhen(n.created_at)}</span>
                )}

                <span className="note-acts">
                  {isDeleting && <span className="when">Deleting...</span>}

                  {isConfirming && (
                    <>
                      <span className="when">Delete note?</span>
                      <button
                        onClick={() => remove(n.id)}
                        className="btn btn-sm"
                        style={{ color: "#c0392b", fontWeight: 500 }}
                      >
                        Yes
                      </button>
                      <button onClick={() => setConfirmId(null)} className="btn btn-sm">
                        No
                      </button>
                    </>
                  )}

                  {!isDeleting && !isConfirming && (
                    <>
                      <button
                        onClick={() => patch(n.id, { include_in_ai: !n.include_in_ai })}
                        aria-pressed={n.include_in_ai}
                        aria-label={
                          n.include_in_ai
                            ? "Exclude this note from drafting"
                            : "Include this note in drafting"
                        }
                        title={
                          n.include_in_ai
                            ? "Included when a draft is generated"
                            : "Excluded when a draft is generated"
                        }
                        className={`icon-btn ${n.include_in_ai ? "pill-ok" : "pill-off"}`}
                      >
                        {n.include_in_ai ? <Check size={14} /> : <X size={14} />}
                      </button>
                      <button
                        onClick={() => patch(n.id, { pinned: !n.pinned })}
                        aria-pressed={n.pinned}
                        aria-label={n.pinned ? "Unpin note" : "Pin note"}
                        title={n.pinned ? "Unpin" : "Pin"}
                        className="icon-btn"
                      >
                        <Pin size={14} />
                      </button>
                      <button
                        onClick={() => {
                          setEditingId(n.id);
                          setEditText(n.body);
                        }}
                        aria-label="Edit note"
                        title="Edit"
                        className="icon-btn"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => setConfirmId(n.id)}
                        aria-label="Delete note"
                        title="Delete"
                        className="icon-btn"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </span>
              </div>

              {editingId === n.id ? (
                <div className="mt-1 space-y-2">
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={3}
                    className="mc-input"
                  />
                  <div className="flex gap-2">
                    <button className="btn btn-sm" onClick={saveEdit}>
                      Save
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setEditingId(null);
                        setEditText("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p style={isDeleting ? { opacity: 0.5 } : undefined}>{n.body}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
