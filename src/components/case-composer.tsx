import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { supabase } from "@/integrations/supabase/client";
import { RichTextEditor } from "@/components/RichTextEditor";
import { SIGNATURE_HTML } from "@/lib/signature";
import { athensStamp, isPartnerEvent, type ThreadEvent } from "@/lib/case-thread";
import { type DraftVersionRow } from "@/lib/case-draft-versions";
import { isBeforeDeposit, reviewBody, visibleText, type ComposerTarget } from "@/lib/case-composer";

// One composer for both directions of a case.
//
// It replaces two boxes that were built separately and drifted: the client one
// (AiReviewDesk) knew nothing about the deposit gate, and the partner one
// (case-partner-reply-box) carried its own gate notice and its own pricing
// warning. The rules now live in src/lib/case-composer.ts and both targets are
// judged by the same code, which is the point of merging them: a rule fixed
// once is fixed for both.
//
// The target switch changes four things at once, per the design:
//   1. the recipient, which is always resolved on the server, never posted;
//   2. the language the body is expected in, English out to the client and
//      Greek to the partner;
//   3. the signature, which is fixed and only ever goes to the client, since
//      partner mail deliberately carries none;
//   4. which rules bind the text: R2 (pricing) applies only to partner mail,
//      R7 (deposit gate) applies to both, in different words.
//
// The signature is not editable. It is always the MyGreekTax Team block from
// src/lib/signature.ts, with no personal name in it.

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "a", "span"],
  ALLOWED_ATTR: ["href", "target", "rel", "style"],
};

interface PartnerOption {
  email: string;
  full_name: string | null;
}

interface Props {
  /** brain_conversations.id. */
  conversationId: string;
  caseSerialId?: string | null;
  clientName?: string | null;
  clientEmail?: string | null;
  /** The linked lead's stage, which decides whether the deposit gate is shut. */
  clientStage?: string | null;
  /** clients.deposit. A recorded deposit opens the gate whatever the stage. */
  clientDeposit?: number | null;
  /** The whole case timeline, for the context panel. */
  events: ThreadEvent[];
  /**
   * case_drafts.proposed_draft: the draft that is actually sendable.
   *
   * This, not the version row, is the source of truth for the prefill.
   * case_draft_versions is written by a trigger that early-returns on an
   * approved update and swallows its own exceptions, so a case can hold a
   * current draft with no version row at all, or with a version row whose
   * text is older. The draft desk already names both states.
   */
  currentDraftText?: string | null;
  /**
   * The newest recorded version, used to attribute a send to the metric.
   * Only that: a version whose text has been superseded is not what goes out.
   */
  currentVersion?: DraftVersionRow | null;
  /** Called after a successful send so the page can refresh the thread. */
  onSent?: () => void;
}

/**
 * Draft text as the rich editor needs it.
 *
 * `case_draft_versions.draft_text` is plain text, so it is escaped first and
 * only then given structure: a blank line becomes a paragraph and a single
 * newline a `<br>`, which is the shape the Brain's drafts are written in.
 */
function plainToHtml(raw: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return raw
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * The one place a case sends mail from, to either side of it.
 *
 * See the module header above for what the target switch changes and why the
 * two boxes this replaces were merged. Two things are worth knowing before
 * reading the state: each target keeps its own subject and its own body, so
 * flipping between them never destroys half-written work or carries a client
 * subject onto a partner send; and every rule shown here is applied again by
 * /webhooks/send-approved, so this component decides what is easy to do, not
 * what is possible.
 */
export function CaseComposer({
  conversationId,
  caseSerialId,
  clientName,
  clientEmail,
  clientStage,
  clientDeposit,
  events,
  currentDraftText,
  currentVersion,
  onSent,
}: Props) {
  const [target, setTarget] = useState<ComposerTarget>("client");

  // One subject per target rather than one shared field. A target flip is
  // exactly when the subject should be reconsidered, and a single field
  // carried "Your 2025 return" onto a partner send, or the internal case
  // serial onto a client one.
  const [clientSubject, setClientSubject] = useState("");
  const [partnerSubject, setPartnerSubject] = useState("");
  const subjectTouched = useRef<Record<ComposerTarget, boolean>>({
    client: false,
    partner: false,
  });

  // Client mail is HTML from the rich editor; partner mail is plain text,
  // which is what the partner send path has always taken.
  const [clientHtml, setClientHtml] = useState("");
  // The version already sent from this composer, so its text stops being
  // offered back as a prefill and the editor comes up empty afterwards.
  const [sentVersionId, setSentVersionId] = useState<string | null>(null);
  // The same idea for a draft with no version row behind it. There, nothing is
  // written anywhere on send (no version to stamp, no is_approved), so a
  // reload of case_drafts offers the identical text straight back. The version
  // id cannot express this one; the text is all there is to compare.
  const [sentDraftText, setSentDraftText] = useState<string | null>(null);
  // Bumped on every send that clears the editor. The version id alone cannot
  // express "cleared": an ad-hoc reply on a case with no draft leaves it null
  // before and after, the key never changes, and the text that was just mailed
  // stays on screen for one keystroke to re-arm.
  const [clearNonce, setClearNonce] = useState(0);
  const [partnerText, setPartnerText] = useState("");

  const [partners, setPartners] = useState<PartnerOption[]>([]);
  const [partnerEmail, setPartnerEmail] = useState("");
  const [partnerError, setPartnerError] = useState("");

  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [contextOpen, setContextOpen] = useState(false);
  const [pricingAcknowledged, setPricingAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  // A send that went out but was not written to the case thread. The body is
  // still on screen so it can be copied into a note, which means the one
  // visible button would otherwise mail the client a second time. Holding it
  // behind an explicit click is what the old desk did with its own
  // sent-unlogged state, for the same reason.
  const [sentUnlogged, setSentUnlogged] = useState(false);
  const [error, setError] = useState("");
  const [sentMsg, setSentMsg] = useState("");

  const beforeDeposit = isBeforeDeposit(clientStage, (clientDeposit ?? 0) > 0);

  // The prefill is derived, not stored, and the editor is keyed on it.
  //
  // RichTextEditor takes its content once, at mount (content: initialHtml,
  // with no effect that follows later changes). The draft version arrives from
  // the desk after this component has already mounted, so holding the prefill
  // in state and letting it fill in later meant the editor never saw it and
  // the body came up empty. Keying the editor on the version remounts it with
  // the text, which is the same mechanism the old desk used (it was keyed on
  // the draft stamp) and carries the same accepted trade: a regenerate
  // replaces what is in the box.
  // Whether the newest recorded version is the draft that would go out.
  //
  // When it is not, the version is history and case_drafts holds something
  // newer: a generation the trigger did not record, or a draft older than the
  // version table. Sending then must not be attributed to that version, or the
  // metric gets a row whose sent_text was never its draft_text, which is the
  // same shape as the resend double-stamp this PR fixes.
  const versionIsCurrent =
    !!currentVersion &&
    typeof currentDraftText === "string" &&
    currentDraftText.length > 0 &&
    currentVersion.draft_text === currentDraftText;

  const prefillHtml = useMemo(() => {
    // case_drafts first: it is what the send path has always sent, and it is
    // the only one of the two that is guaranteed to exist for a drafted case.
    const text = currentDraftText || currentVersion?.draft_text || "";
    if (!text) return "";
    // Once a version has been sent, it stops being an offer to send again.
    // sent_at on the row is the authoritative answer and survives a reload,
    // a second tab and a second operator; the local id only covers the moment
    // between this send and the row coming back. Only when that version is
    // still the current draft, though: a newer unrecorded draft is unsent
    // whatever the version behind it says.
    if (versionIsCurrent && currentVersion?.sent_at) return "";
    if (versionIsCurrent && sentVersionId && sentVersionId === currentVersion?.id) return "";
    if (!versionIsCurrent && sentDraftText !== null && sentDraftText === text) return "";
    return plainToHtml(text);
  }, [currentDraftText, currentVersion, sentVersionId, sentDraftText, versionIsCurrent]);

  // A client reply carries "Re: <the subject they last wrote under>", which is
  // what puts it in their existing thread rather than starting a new one. The
  // old reply box derived it the same way; losing it split every client
  // conversation into a thread per message.
  const clientSubjectDefault = useMemo(() => {
    const last = [...events].reverse().find((e) => !isPartnerEvent(e) && e.subject);
    const base = (last?.subject ?? "").replace(/^(re:\s*)+/i, "").trim();
    if (base) return `Re: ${base}`;
    return caseSerialId ? `Re: ${caseSerialId}` : "";
  }, [events, caseSerialId]);

  useEffect(() => {
    if (subjectTouched.current.partner) return;
    setPartnerSubject(caseSerialId ? `${caseSerialId}: ` : "");
  }, [caseSerialId]);

  useEffect(() => {
    if (subjectTouched.current.client) return;
    setClientSubject(clientSubjectDefault);
  }, [clientSubjectDefault]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from("partner_profiles")
        .select("email, full_name")
        .is("disabled_at", null)
        .order("full_name");
      if (cancelled) return;
      if (err) {
        // Its own slot, not the send slot. A late rejection here used to
        // overwrite the send's own outcome, including the one message that
        // must never be lost: "sent but not written to the case thread".
        setPartnerError(`Could not load partners: ${err.message}`);
        return;
      }
      const rows = ((data as PartnerOption[] | null) ?? []).filter((p) => !!p.email);
      setPartners(rows);
      if (rows.length > 0) setPartnerEmail((cur) => cur || rows[0].email);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Every message in the case is context by default; the operator takes some
  // out rather than putting them in.
  const inContext = useCallback((id: string) => !excluded.has(id), [excluded]);
  const selectedIds = useMemo(
    () => events.filter((e) => !excluded.has(e.id)).map((e) => e.id),
    [events, excluded],
  );

  const toggleContext = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const subject = target === "client" ? clientSubject : partnerSubject;

  // The text the rules are applied to: what a reader would see, in both modes.
  const bodyForReview = target === "partner" ? partnerText : visibleText(clientHtml || prefillHtml);
  // The subject travels in the same message and is read first, so it is judged
  // with the body: a retail figure in a partner subject line breaks R2 exactly
  // as much as one in the body.
  const reviewed = `${subject}\n${bodyForReview}`;
  const verdict = useMemo(
    () => reviewBody(reviewed, target, beforeDeposit),
    [reviewed, target, beforeDeposit],
  );

  // A new body has not been looked at yet, so any earlier acknowledgement of
  // its figures is void.
  useEffect(() => {
    setPricingAcknowledged(false);
    setConfirming(false);
  }, [reviewed, target]);

  // Whether this send is the current draft going out, rather than something
  // the operator wrote from nothing. Only then does it approve a draft.
  const sendingDraft = target === "client" && !!prefillHtml;
  // ...and whether that draft is one the metric can be told about. A draft the
  // version table never recorded still sends; it just sends unattributed,
  // rather than stamping a version row with text that was never its own.
  const sendingRecordedVersion = sendingDraft && versionIsCurrent;
  const hasBody = bodyForReview.trim().length > 0;
  const needsAcknowledgement = verdict.confirmations.length > 0 && !pricingAcknowledged;
  const recipientReady = target === "client" ? !!clientEmail : !!partnerEmail;
  const canSend =
    hasBody &&
    recipientReady &&
    !!subject.trim() &&
    verdict.blocking.length === 0 &&
    !needsAcknowledgement &&
    !sentUnlogged &&
    !sending;

  const send = async () => {
    setError("");
    setSending(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      let finalText: string;
      let sentMode: "as_is" | "edited" | undefined;

      if (target === "client") {
        const bodyForSend = clientHtml || prefillHtml;
        const combined = `${bodyForSend}<br>${SIGNATURE_HTML}`;
        finalText = DOMPurify.sanitize(combined, SANITIZE_CONFIG)
          .replace(/<li>\s*<p>/gi, "<li>")
          .replace(/<\/p>\s*<\/li>/gi, "</li>");
        sentMode = sendingRecordedVersion
          ? visibleText(bodyForSend) === visibleText(prefillHtml)
            ? "as_is"
            : "edited"
          : undefined;
      } else {
        // Partner mail goes as plain text and is never signed.
        finalText = partnerText;
      }

      const res = await fetch("/webhooks/send-approved", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          case_id: conversationId,
          target,
          final_text: finalText,
          subject,
          // The server applies the same rules and will refuse a body with
          // unconfirmed figures, so the confirmation made here travels with it.
          ...(pricingAcknowledged ? { pricing_ack: true } : {}),
          ...(sentMode ? { sent_mode: sentMode } : {}),
          // Which version this send corresponds to, so a resend cannot stamp
          // an older unsent one.
          //
          // Both conditions matter. An ad-hoc reply the operator wrote is not
          // an approval of the Brain's draft, and a version the draft has since
          // moved past is not the thing being sent; stamping either would put a
          // send into the quality metric that never happened. Sending a draft
          // the version table never recorded is fine and still goes out, it
          // just carries no version id and no sent_mode, so the server leaves
          // the history alone rather than writing this text onto an older row.
          ...(sendingRecordedVersion && currentVersion
            ? { draft_version_id: currentVersion.id }
            : {}),
          ...(target === "partner" ? { partner_email: partnerEmail } : {}),
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.ok) {
        const detail =
          typeof payload?.detail === "string"
            ? payload.detail
            : (payload?.error ?? `HTTP ${res.status}`);
        setError(`Send failed: ${detail}`);
        return;
      }

      const to =
        target === "client"
          ? clientName || clientEmail
          : partners.find((p) => p.email === partnerEmail)?.full_name || partnerEmail;
      if (payload.logged === false) {
        // The mail went but the case did not record it. Saying "Sent" and
        // nothing else is how an empty case thread went unnoticed before.
        //
        // The body deliberately stays on screen here. The operator is being
        // asked to put this message into the case by hand, and clearing it
        // would take away the only copy they have: the thread does not hold it
        // either, by definition of logged:false.
        setError(
          `Sent to ${to}, but it was not written to the case thread. Copy the message into a note before leaving this page. ${payload.logError ?? ""}`.trim(),
        );
        setSentUnlogged(true);
      } else {
        setSentMsg(`Sent to ${to}.`);
        if (target === "client") {
          setClientHtml("");
          // Only the version that actually went out. Recording one the send was
          // not attributed to would suppress a prefill that is still unsent.
          setSentVersionId(sendingRecordedVersion ? (currentVersion?.id ?? null) : null);
          if (sendingDraft && !sendingRecordedVersion) {
            setSentDraftText(currentDraftText || currentVersion?.draft_text || null);
          }
          // Remounts the editor even when there is no version id to change,
          // which is every ad-hoc reply.
          setClearNonce((n) => n + 1);
        } else {
          setPartnerText("");
        }
        setTimeout(() => setSentMsg(""), 4000);
      }
      setConfirming(false);
      onSent?.();
    } catch (err) {
      setError(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

  const excludedCount = excluded.size;

  return (
    <section className="card composer">
      <div className="card-head">
        <span className="seg" role="tablist" aria-label="Send to">
          <button
            role="tab"
            aria-selected={target === "client"}
            aria-pressed={target === "client"}
            onClick={() => setTarget("client")}
          >
            To client
          </button>
          <button
            role="tab"
            aria-selected={target === "partner"}
            aria-pressed={target === "partner"}
            onClick={() => setTarget("partner")}
          >
            To partner
          </button>
        </span>
        {target === "partner" && <span className="tag tag-internal">INTERNAL</span>}
        <div className="head-actions">
          <span className="stamp">
            {target === "client"
              ? "English, signed MyGreekTax Team"
              : "Greek, unsigned, logs to the partner thread"}
          </span>
        </div>
      </div>

      <div className="card-body">
        {/* R7 binds both targets, in different words. */}
        {beforeDeposit && (
          <div className="callout">
            <span>
              This case is at <strong>{clientStage}</strong>, before the deposit is confirmed.{" "}
              {target === "partner"
                ? "No assignment or scoping request goes to a partner yet."
                : "No document checklist, methodology or locked figure goes out yet. Scope questions and payment logistics are fine."}
            </span>
          </div>
        )}

        {/* R2 binds partner mail only: the client is entitled to their own price. */}
        {target === "partner" && (
          <div className="callout r2">
            <span>
              R2: no retail price, margin or client total goes to a partner. Write{" "}
              <em>κατόπιν συμφωνίας</em> in place of a figure you cannot vouch for.
            </span>
          </div>
        )}

        {verdict.blocking.length > 0 && (
          <div className="composer-block">
            {verdict.blocking.map((b) => (
              <p key={b}>{b}</p>
            ))}
          </div>
        )}

        <div className="field">
          <label htmlFor="composer-to">To</label>
          {target === "client" ? (
            <input
              id="composer-to"
              className="mc-input"
              value={clientEmail || "no client email on this case"}
              readOnly
              title="Resolved on the server from the case, never from this field"
            />
          ) : (
            <select
              id="composer-to"
              className="mc-input"
              value={partnerEmail}
              onChange={(e) => setPartnerEmail(e.target.value)}
            >
              {partners.length === 0 && <option value="">No active partners</option>}
              {partners.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.full_name || p.email}
                </option>
              ))}
            </select>
          )}
          {target === "partner" && partnerError && (
            <p className="text-sm text-red-600">{partnerError}</p>
          )}
        </div>

        <div className="field">
          <label htmlFor="composer-subject">Subject</label>
          <input
            id="composer-subject"
            className="mc-input"
            value={subject}
            onChange={(e) => {
              subjectTouched.current[target] = true;
              if (target === "client") setClientSubject(e.target.value);
              else setPartnerSubject(e.target.value);
            }}
            placeholder={
              target === "partner" ? `${caseSerialId ?? ""}: ` : clientSubjectDefault || "Update"
            }
          />
        </div>

        {/* Both editors stay mounted and the inactive one is hidden, rather
            than switching on the target. The rich editor takes its content at
            mount and emits it once, so unmounting it on a flip to the partner
            tab and remounting it on the way back would overwrite a
            half-written client message with the prefill. Hiding costs
            nothing and keeps both drafts while the operator moves between
            them. */}
        <div className="field" hidden={target !== "client"}>
          <label id="composer-body-client-label">Message</label>
          <RichTextEditor
            ariaLabelledBy="composer-body-client-label"
            key={`${currentVersion?.id ?? "none"}:${sentVersionId ?? ""}:${clearNonce}`}
            initialHtml={prefillHtml}
            onChange={setClientHtml}
          />
        </div>

        <div className="field" hidden={target !== "partner"}>
          <label htmlFor="composer-body">Message</label>
          <textarea
            id="composer-body"
            className="mc-input"
            style={{ minHeight: 160 }}
            value={partnerText}
            onChange={(e) => setPartnerText(e.target.value)}
            placeholder="Γράψε το μήνυμα προς τον συνεργάτη. Το MGT-REF-ID μπαίνει αυτόματα."
          />
        </div>

        {target === "client" && (
          <div className="sig-locked">
            <div className="sum-label">Signature, fixed</div>
            <p className="stamp">
              Με εκτίμηση, MyGreekTax Team. Added on send and not editable here.
            </p>
          </div>
        )}

        {verdict.confirmations.length > 0 && (
          <label className="ack">
            <input
              type="checkbox"
              checked={pricingAcknowledged}
              onChange={(e) => setPricingAcknowledged(e.target.checked)}
            />
            <span>{verdict.confirmations.join(" ")} I have checked each one.</span>
          </label>
        )}

        {/* Context. Everything is in by default; the operator takes messages
            out. The selection is posted with a generate request, but drafting
            reads the whole thread regardless until the Brain learns to honour
            it, and saying otherwise here would be untrue. */}
        <div className="ctx-panel">
          <button className="btn btn-sm" onClick={() => setContextOpen((v) => !v)}>
            {contextOpen ? "Hide context" : "Context"} ({selectedIds.length}/{events.length})
          </button>
          {excludedCount > 0 && (
            <span className="stamp">
              {excludedCount} message{excludedCount === 1 ? "" : "s"} held out
            </span>
          )}
          {contextOpen && (
            <>
              <p className="stamp">
                Every message is context by default. Drafting still reads the whole case thread, so
                holding a message out here does not yet change what the Brain sees.
              </p>
              <div className="ctx-list">
                {events.map((e) => (
                  <label className="ctx-row" key={e.id}>
                    <input
                      type="checkbox"
                      checked={inContext(e.id)}
                      onChange={() => toggleContext(e.id)}
                    />
                    <span className="when">{athensStamp(e.occurred_at)}</span>
                    <span className="who">
                      {isPartnerEvent(e) ? "Partner" : (e.subject ?? "Message")}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
            {error}
          </p>
        )}
        {sentMsg && <p className="stamp">{sentMsg}</p>}

        <div className="reply-foot">
          {sentUnlogged ? (
            <button
              className="btn btn-sm"
              onClick={() => {
                setSentUnlogged(false);
                setError("");
              }}
            >
              Send another email anyway
            </button>
          ) : !confirming ? (
            <button
              className="btn btn-solid"
              disabled={!canSend}
              onClick={() => setConfirming(true)}
            >
              Send
            </button>
          ) : (
            <>
              <button className="btn btn-solid" disabled={!canSend} onClick={send}>
                {sending ? "Sending..." : "Confirm send"}
              </button>
              <button className="btn btn-sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          )}
          <span className="stamp">
            {target === "client"
              ? "Sends from hello@mygreektax.eu and logs to the client thread"
              : "Sends from hello@mygreektax.eu and logs to the partner thread"}
          </span>
        </div>
      </div>
    </section>
  );
}
