import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { supabase } from "@/integrations/supabase/client";
import { RichTextEditor } from "@/components/RichTextEditor";
import { SIGNATURE_HTML } from "@/lib/signature";
import { athensStamp, isPartnerEvent, type ThreadEvent } from "@/lib/case-thread";
import { type DraftVersionRow } from "@/lib/case-draft-versions";
import {
  draftToOffer,
  isBeforeDeposit,
  reviewBody,
  visibleText,
  type ComposerTarget,
} from "@/lib/case-composer";

// One composer for both directions of a case.
//
// It replaced two boxes that were built separately and drifted: the client one
// knew nothing about the deposit gate, and the partner one carried its own
// gate notice and its own pricing warning. Both have since been deleted, so
// this is history rather than a pointer; AiReviewDesk on /jobs/:jobId is the
// one survivor, and it posts to the same endpoint this composer does, so the
// rules bind it too. The rules live in src/lib/case-composer.ts and both
// targets are judged by the same code, which is the point of merging them: a
// rule fixed once is fixed for both.
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

interface PartnerDraft {
  subject: string | null;
  body: string | null;
  internal_notes: string | null;
  pricing_flag: boolean;
  drafted_for_email: string | null;
  last_updated: string;
}

// The Brain writes case_partner_drafts in the background, so the generate call
// returns before the draft exists and there is nothing to await. Same shape as
// the client generate path in review.$caseId.tsx.
const GEN_POLL_MS = 3000;
const GEN_TIMEOUT_MS = 180000;

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
   * case_drafts.is_approved: this draft has already been sent.
   *
   * The durable half of "do not offer it again". case_draft_versions.sent_at
   * says the same thing but is written after it and can fail on its own, and
   * an unrecorded draft has no version row to carry it at all.
   */
  currentDraftApproved?: boolean;
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
  currentDraftApproved,
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

  // Brain assist for partner mail. Generation only: it never sends, never
  // picks a recipient, and never bypasses the confirmation. Whatever lands in
  // the box is edited and approved by a human exactly as typed text is.
  const [partnerDraft, setPartnerDraft] = useState<PartnerDraft | null>(null);
  // Whether that draft is what is currently in the box. The R6 check below is
  // about the text carrying one partner's context, so it has to follow the
  // text, not merely the existence of a row: a draft loaded at mount and never
  // applied says nothing about a message the operator typed themselves.
  const [partnerDraftApplied, setPartnerDraftApplied] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Read by the generate poll, which runs long enough to outlive the composer.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [genError, setGenError] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);

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
  // Which draft to offer, and whether sending it counts against the recorded
  // version. The decision itself is pure and lives in the rules module, where
  // it is unit tested: it is what stands between a stale or already-sent draft
  // and a second copy of the same email.
  const offer = useMemo(
    () =>
      draftToOffer({
        currentDraftText,
        currentDraftApproved,
        version: currentVersion ?? null,
        sentVersionId,
        sentDraftText,
      }),
    [currentDraftText, currentDraftApproved, currentVersion, sentVersionId, sentDraftText],
  );
  const versionIsCurrent = offer.versionIsCurrent;
  const prefillHtml = useMemo(() => (offer.text ? plainToHtml(offer.text) : ""), [offer.text]);

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

  // Returns the error rather than swallowing it. This backs both the mount
  // load and every iteration of the poll below, so a query that keeps failing
  // (an RLS change, a missing table) would otherwise be indistinguishable from
  // "no draft yet" and would surface three minutes later as a generic timeout.
  const loadPartnerDraft = useCallback(async (): Promise<{
    row: PartnerDraft | null;
    error: string | null;
  }> => {
    const { data, error: err } = await supabase
      .from("case_partner_drafts")
      .select("subject, body, internal_notes, pricing_flag, drafted_for_email, last_updated")
      .eq("case_id", conversationId)
      .maybeSingle();
    if (err) {
      console.error("[case-composer] partner draft load failed:", err.message);
      return { row: null, error: err.message };
    }
    return { row: (data as PartnerDraft | null) ?? null, error: null };
  }, [conversationId]);

  // Loaded but never applied automatically: applying overwrites the box, and
  // on mount there is no way to know the operator did not mean to keep a
  // half-written message.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { row } = await loadPartnerDraft();
      if (!cancelled) setPartnerDraft(row);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPartnerDraft]);

  const applyPartnerDraft = (row: PartnerDraft) => {
    if (row.subject) {
      subjectTouched.current.partner = true;
      setPartnerSubject(row.subject);
    }
    setPartnerText(row.body ?? "");
    setPartnerDraftApplied(true);
    setConfirming(false);
  };

  const generatePartnerDraft = async () => {
    setGenError("");
    if (!partnerEmail) {
      setGenError("Pick a partner first. The draft is written for a specific recipient.");
      return;
    }
    setGenerating(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/webhooks/generate-partner-draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        // The recipient goes with the request: the Brain filters the case
        // timeline to this partner's correspondence (R6) and addresses the
        // draft to them. The server revalidates it against active partners.
        body: JSON.stringify({ conversation_id: conversationId, partner_email: partnerEmail }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.ok) {
        const detail =
          typeof payload?.detail === "string"
            ? payload.detail
            : (payload?.error ?? `HTTP ${res.status}`);
        setGenError(`Generation failed: ${detail}`);
        return;
      }

      const baseline: string | null = payload.previousUpdatedAt ?? null;
      const startedAt = Date.now();

      while (Date.now() - startedAt < GEN_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, GEN_POLL_MS));
        // The poll outlives almost anything: three minutes of waiting on the
        // Brain. Keying this component on the case already means a case change
        // unmounts it, but the loop closes over the old conversationId and
        // would keep running and writing for the rest of that window.
        if (!mounted.current) return;
        const { row: fresh, error: readError } = await loadPartnerDraft();
        // Stop on a read failure rather than polling out. The Brain may well
        // have written the draft; what is broken is our ability to read it.
        if (readError) {
          setGenError(`Could not read the draft back: ${readError}`);
          return;
        }
        if (fresh && fresh.last_updated !== baseline) {
          setPartnerDraft(fresh);
          applyPartnerDraft(fresh);
          return;
        }
      }

      setGenError(
        "The draft is taking longer than expected. It may still finish, so try reloading the page in a minute.",
      );
    } catch (err) {
      setGenError(
        `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setGenerating(false);
    }
  };

  // R6: a draft is written with one partner's thread in scope and every other
  // partner's filtered out. Changing the recipient afterwards is one click,
  // and sending it as-is would put one partner's context in front of another.
  //
  // Two distinct states, and neither is safe. A draft written for someone else
  // is a known mismatch and blocks: R6 says never, and the composer has a way
  // to say never that the box this replaces did not (there, both of these were
  // red text above a live Send button). A draft with no recorded recipient is
  // UNKNOWN rather than fine, but old rows predate the column, so that one
  // asks instead of refusing.
  const draftedForOther =
    partnerDraftApplied &&
    !!partnerDraft?.drafted_for_email &&
    !!partnerEmail &&
    partnerDraft.drafted_for_email.toLowerCase() !== partnerEmail.toLowerCase();

  const draftUnattributed =
    partnerDraftApplied && !!partnerDraft && !partnerDraft.drafted_for_email;

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
  const verdict = useMemo(() => {
    const v = reviewBody(reviewed, target, beforeDeposit);
    // R6 rides in the same channel as R2 and R7 rather than being a notice of
    // its own, so one place decides whether Send lights up.
    if (draftedForOther) {
      v.blocking.push(
        `R6: this draft was written for ${partnerDraft?.drafted_for_email}, and the recipient is now someone else. It may carry that partner's context. Redraft for the current recipient.`,
      );
    }
    if (draftUnattributed) {
      v.confirmations.push(
        "R6: this draft has no recorded recipient, so there is no way to tell whose context it carries. Confirm it is safe for this partner, or redraft.",
      );
    }
    return v;
  }, [
    reviewed,
    target,
    beforeDeposit,
    draftedForOther,
    draftUnattributed,
    partnerDraft?.drafted_for_email,
  ]);

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
          // That the draft went out at all, which is a different question from
          // which version it was. This is what marks case_drafts approved, and
          // that flag is the only record of the send that survives the version
          // stamp failing, so it is also what stops a reload offering the same
          // draft back.
          ...(sendingDraft ? { sending_draft: true } : {}),
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
          // The draft went out with the message. What is typed next is the
          // operator's own, so the R6 check stops applying to it.
          setPartnerDraftApplied(false);
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
            onChange={(e) => {
              setPartnerText(e.target.value);
              // Emptying the box discards the draft's context along with it,
              // so the R6 check stops applying to what is typed next.
              if (!e.target.value.trim()) setPartnerDraftApplied(false);
            }}
            placeholder="Γράψε το μήνυμα προς τον συνεργάτη. Το MGT-REF-ID μπαίνει αυτόματα."
          />

          {/* Brain assist. Generation only: it writes into the box and never
              sends, and the draft is scoped to the partner selected above, so
              the recipient has to be chosen before there is anything to ask
              for. */}
          <div className="reply-foot" style={{ marginTop: 8 }}>
            <button
              className={partnerDraft ? "btn btn-sm" : "btn btn-solid btn-sm"}
              disabled={generating || !partnerEmail}
              onClick={generatePartnerDraft}
            >
              {generating
                ? "Drafting..."
                : partnerDraft
                  ? "Redraft with Brain"
                  : "Draft with Brain"}
            </button>
            {partnerDraft && !generating && (
              <button className="btn btn-sm" onClick={() => applyPartnerDraft(partnerDraft)}>
                Load Brain draft
              </button>
            )}
            <span className="stamp">
              {generating
                ? "The Brain is writing in Greek, scoped to this partner's thread."
                : partnerDraft
                  ? `Draft on file, ${athensStamp(partnerDraft.last_updated)}`
                  : "Greek, scoped to this partner's correspondence"}
            </span>
          </div>

          {genError && (
            <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
              {genError}
            </p>
          )}

          {/* The Brain's own scan of its own output, which is a second opinion
              on R2 rather than a repeat: this one does not depend on the
              composer's pattern matching having caught the figure. */}
          {partnerDraftApplied && partnerDraft?.pricing_flag && (
            <div className="callout r2">
              <span>
                The Brain flagged a currency figure in this draft. Check every one before sending,
                or replace it with <em>κατόπιν συμφωνίας</em>.
              </span>
            </div>
          )}

          {partnerDraft?.internal_notes && (
            <div style={{ marginTop: 12 }}>
              <button
                className="btn btn-sm"
                onClick={() => setNotesOpen((v) => !v)}
                aria-expanded={notesOpen}
              >
                {notesOpen ? "Hide Brain notes" : "Brain notes"}
              </button>
              {notesOpen && (
                <p className="stamp" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                  {partnerDraft.internal_notes}
                </p>
              )}
            </div>
          )}
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
