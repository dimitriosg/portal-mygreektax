import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { athensFullStamp, athensStamp } from "@/lib/case-thread";
import {
  describeContext,
  htmlToPlainText,
  looksLikeHtml,
  rerunUnchangedAt,
  sendState,
  type DraftVersionRow,
  type SendState,
} from "@/lib/case-draft-versions";

// The Draft tab of the case desk, reading case_draft_versions.
//
// case_drafts holds one row per case and is overwritten on every regenerate,
// so it can only ever show the latest text. case_draft_versions is the append
// only record of every Brain generation, and since PR #102/#103 it is also
// where a send is stamped with what was actually sent (sent_text) and whether
// the operator changed it first (sent_mode). That as-is against edited ratio
// is the only honest measure of whether the drafting is any good, so this
// panel reads the version table and case_drafts is no longer consulted here.
//
// Nothing in the portal inserts into this table. Rows arrive through the
// record_case_draft_version() trigger on case_drafts when the Brain writes a
// generation, and /webhooks/send-approved stamps the send. So Generate below
// asks the Brain to run exactly as before; only the reading side changed.

interface Props {
  /** brain_conversations.id. */
  conversationId: string;
  /** Bumped by the route when a draft lands, to force a reload. */
  refreshKey?: string | number;
  /**
   * case_drafts.proposed_draft, the text the send desk below the thread will
   * actually send. This panel reads a different table, and the two are kept in
   * step only by the record_case_draft_version() trigger, whose insert is
   * wrapped in a warning-and-continue handler. So the text is passed in for
   * two reasons: two cases hold a draft with no version rows at all (theirs
   * predates the trigger), and a swallowed insert would otherwise leave this
   * panel presenting a superseded generation as the current draft while the
   * desk below holds something else.
   */
  currentDraftText?: string | null;
  /**
   * case_drafts.last_updated. The version trigger only inserts when the text
   * actually moved, so a regenerate that reproduces the same prose leaves this
   * panel looking inert. This is what lets it say a run happened.
   */
  currentDraftUpdatedAt?: string | null;
  /**
   * case_drafts.is_approved: the draft in the row has already been sent.
   *
   * Only affects the wording of the two recovery notices below. Both describe
   * what the composer will do with an unrecorded or superseded draft, and once
   * it is approved the composer will not offer it at all.
   */
  draftApproved?: boolean;
  /** Reports the current version to the route, for the Knowledge tab. */
  onCurrentVersionChange?: (version: DraftVersionRow | null) => void;
  /** The Generate / Regenerate control, owned by the route. */
  generateSlot?: React.ReactNode;
}

const SEND_BADGE: Record<SendState, { label: string; className: string }> = {
  sent_as_is: { label: "SENT, AS IS", className: "badge-sent" },
  sent_edited: { label: "SENT, EDITED", className: "badge-sent" },
  not_sent: { label: "not sent", className: "badge-super" },
};

export function CaseDraftDesk({
  conversationId,
  refreshKey,
  currentDraftText = null,
  currentDraftUpdatedAt = null,
  draftApproved = false,
  onCurrentVersionChange,
  generateSlot,
}: Props) {
  const hasCurrentDraftRow = typeof currentDraftText === "string" && currentDraftText.length > 0;
  const [versions, setVersions] = useState<DraftVersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [compareId, setCompareId] = useState<string | null>(null);
  // Which refreshKey the loaded versions belong to. The route commits the new
  // case_drafts text and stamp in one batch, and this component reloads only
  // afterwards, so for one committed render the props describe a generation
  // the version list has not seen. Every claim that compares the two waits
  // until they agree, or the panel would cry "not recorded" on every generate.
  const [loadedKey, setLoadedKey] = useState<string | number | undefined>(undefined);
  // Only the most recently started load may commit. Moving between cases keeps
  // this component mounted, so without this an earlier query can resolve last
  // and show the previous case's drafts under the new case.
  const loadSeqRef = useRef(0);

  // Clear on a case change, so nothing from the previous case stays on screen
  // while the new load is in flight. Keyed on conversationId alone: refreshKey
  // also reloads, and emptying the list on every regenerate poll would flash.
  useEffect(() => {
    loadSeqRef.current++;
    setVersions([]);
    setCompareId(null);
    setError("");
    setLoading(true);
  }, [conversationId]);

  const load = useCallback(
    async (key: string | number | undefined) => {
      const seq = ++loadSeqRef.current;
      const { data, error: err } = await supabase
        .from("case_draft_versions")
        .select(
          "id, version_no, draft_text, compliance_insights, context_used, model, generated_at, sent_at, sent_text, sent_mode",
        )
        .eq("conversation_id", conversationId)
        .order("version_no", { ascending: false });

      if (seq !== loadSeqRef.current) return;

      if (err) {
        setError(`Could not load draft versions: ${err.message}`);
        setVersions([]);
      } else {
        setError("");
        setVersions((data as DraftVersionRow[] | null) ?? []);
      }
      setLoadedKey(key);
      setLoading(false);
    },
    [conversationId],
  );

  useEffect(() => {
    load(refreshKey);
  }, [load, refreshKey]);

  // Newest version_no first, so the head of the list is the current draft.
  const current = versions.length > 0 ? versions[0] : null;
  const earlier = versions.slice(1);

  useEffect(() => {
    onCurrentVersionChange?.(current);
  }, [current, onCurrentVersionChange]);

  const compared = useMemo(
    () => versions.find((v) => v.id === compareId) ?? null,
    [versions, compareId],
  );

  useEffect(() => {
    if (!compared) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCompareId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [compared]);

  const contextLine = current ? describeContext(current.context_used) : "";

  // True only once the loaded versions correspond to the props being compared
  // against. Both claims below are about the two disagreeing, so making one
  // while they are simply out of step would be false every time.
  const inStep = loadedKey === refreshKey;

  // The send desk holds text this panel never recorded: say so rather than
  // presenting a superseded generation as the current draft.
  const diverged =
    inStep && !!current && hasCurrentDraftRow && current.draft_text !== currentDraftText;
  // Same text, later run: the Brain was asked again and returned what it had,
  // so the trigger recorded no version. Without this the panel shows the old
  // stamp and looks as though nothing happened.
  const rerunAt = current && inStep ? rerunUnchangedAt(current, currentDraftUpdatedAt) : null;
  const rerunUnchanged = !diverged && rerunAt !== null;

  return (
    <>
      {generateSlot}

      {loading && <p className="empty">Loading drafts...</p>}
      {error && (
        <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
          {error}
        </p>
      )}

      {!loading && !error && (!inStep || !hasCurrentDraftRow) && versions.length === 0 && (
        <p className="empty">
          No draft generated for this case yet. Nothing is sent until you review and approve.
        </p>
      )}

      {!loading && !error && inStep && versions.length === 0 && hasCurrentDraftRow && (
        <p className="empty">
          This case has a draft, but it predates the version history and was never recorded here.{" "}
          {draftApproved
            ? "It has already been sent, so the composer will not offer it again. Regenerating records a version."
            : "It is still loaded in the composer and can be sent; it just will not be counted. Regenerating records a version."}
        </p>
      )}

      {current && diverged && (
        <div className="callout">
          <span>
            The draft on this case is not this version. A generation was not recorded here, so v
            {current.version_no} is the newest one on record, not the newest one written.{" "}
            {draftApproved
              ? "That newer draft has already been sent, and the send was not counted against this version."
              : "The composer sends the newer one, and does not count it against this version."}{" "}
            Regenerating records a version and brings the two back into step.
          </span>
        </div>
      )}

      {current && (
        <>
          <div className="rail-div" />

          <div className="ver-head">
            <span className="ver-no">v{current.version_no}</span>
            <span className="when">{athensFullStamp(current.generated_at)}</span>
            <span className="spacer" />
            <span className={SEND_BADGE[sendState(current)].className}>
              {SEND_BADGE[sendState(current)].label}
            </span>
          </div>

          <p className="stamp">
            {contextLine ? `Built from ${contextLine}.` : "Context at generation was not recorded."}
            {current.model ? ` Model ${current.model}.` : ""}
          </p>

          {rerunUnchanged && (
            <p className="stamp">
              Regenerated {athensFullStamp(rerunAt)}, which returned the same text, so no new
              version was recorded.
            </p>
          )}

          <div className="draft-preview">{current.draft_text}</div>

          {current.sent_at && (
            <p className="stamp">
              Sent {athensFullStamp(current.sent_at)}
              {sendState(current) === "sent_edited"
                ? ", edited first. The text above is what the Brain wrote."
                : ", unchanged."}
            </p>
          )}

          {sendState(current) === "sent_edited" && (
            <button className="btn btn-sm" onClick={() => setCompareId(current.id)}>
              Compare written and sent
            </button>
          )}

          {current.compliance_insights && (
            <div className="insights">
              <div className="insights-head">
                <span className="lbl">Compliance insights</span>
                <span className="tag tag-internal">Internal</span>
              </div>
              <p>{current.compliance_insights}</p>
            </div>
          )}

          <p className="stamp">Review, edit and send from the desk below the thread.</p>
        </>
      )}

      {earlier.length > 0 && (
        <>
          <div className="rail-div" />
          <div className="sum-label">Earlier versions</div>
          <div className="ver-list">
            {earlier.map((v) => {
              const state = sendState(v);
              return (
                <div className="ver-row" key={v.id}>
                  <span className="ver-no">v{v.version_no}</span>
                  {/* Compact here: the rail is 336px and the current version
                      above already carries the full stamp. */}
                  <span className="when" title={athensFullStamp(v.generated_at)}>
                    {athensStamp(v.generated_at)}
                  </span>
                  <span className="spacer" />
                  <span
                    className={SEND_BADGE[state].className}
                    title={
                      v.sent_at ? `Sent ${athensFullStamp(v.sent_at)}` : "Never sent to the client"
                    }
                  >
                    {SEND_BADGE[state].label}
                  </span>
                  <button
                    className="btn btn-sm"
                    onClick={() => setCompareId(v.id)}
                    title={
                      state === "sent_edited"
                        ? "What the Brain wrote against what was sent"
                        : "Read this version in full"
                    }
                  >
                    {state === "sent_edited" ? "Compare" : "Read"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {compared && (
        <div
          className="mgt-case-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Draft version ${compared.version_no}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setCompareId(null);
          }}
        >
          <div className="mgt-case-sheet">
            <div className="sheet-head">
              <h2>
                Version {compared.version_no}
                {compared.sent_at ? ` · ${SEND_BADGE[sendState(compared)].label}` : ""}
              </h2>
              <div className="head-actions">
                <button
                  className="icon-btn"
                  onClick={() => setCompareId(null)}
                  title="Close"
                  aria-label="Close version view"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="sheet-body">
              <p className="stamp">
                Generated {athensFullStamp(compared.generated_at)}
                {compared.model ? ` · ${compared.model}` : ""}
                {describeContext(compared.context_used)
                  ? ` · ${describeContext(compared.context_used)}`
                  : ""}
              </p>

              <p className="stamp">
                {compared.sent_at
                  ? `Sent ${athensFullStamp(compared.sent_at)}, ${
                      sendState(compared) === "sent_edited" ? "edited first" : "unchanged"
                    }.`
                  : "Never sent to the client."}
              </p>

              {sendState(compared) === "sent_edited" && compared.sent_text ? (
                <div className="ver-compare">
                  <div>
                    <div className="sum-label">What the Brain wrote</div>
                    <div className="ver-body">{compared.draft_text}</div>
                  </div>
                  <div>
                    <div className="sum-label">What was sent</div>
                    {/* Stored as the signed HTML the desk posted, so it is
                        shown as the client read it, not as markup. */}
                    <div className="ver-body">
                      {looksLikeHtml(compared.sent_text)
                        ? htmlToPlainText(compared.sent_text)
                        : compared.sent_text}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="ver-body">{compared.draft_text}</div>
              )}

              {compared.compliance_insights && (
                <div className="insights" style={{ marginTop: 12 }}>
                  <div className="insights-head">
                    <span className="lbl">Compliance insights</span>
                    <span className="tag tag-internal">Internal</span>
                  </div>
                  <p>{compared.compliance_insights}</p>
                </div>
              )}

              <p className="stamp" style={{ marginTop: 14 }}>
                Every generation is kept. Reading an old version here changes nothing the client has
                seen.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
