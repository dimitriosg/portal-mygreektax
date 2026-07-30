import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getClientStageSortOrder } from "@/lib/leads-shared";

// Follow up with partner.
//
// Compose box for mailing the accountant partner from inside the case. Two ways
// to fill it: type it, or press "Draft with Brain", which runs the Lambda in
// mode "partner" and loads back a Greek draft from case_partner_drafts.
//
// The Brain assist is generation only. It never sends, never picks a recipient,
// and never bypasses the confirmation: whatever lands in these fields is edited
// and approved by a human exactly as a typed message is.
//
// Send is two-step. Send opens a confirmation showing exactly who receives it
// and what, and only Confirm fires. The server independently refuses any
// recipient that is not an active partner, so the dropdown is convenience, not
// the guard.
//
// Two advisory notices, both non-blocking by design, because the operator has
// context the portal does not:
//
//   - Pricing (rule R2). The Lambda scans its own output for currency figures
//     and sets pricing_flag. R2 has no exceptions, so it gets a check that does
//     not depend on the model having obeyed the prompt. The text is never
//     silently edited: you have to see what the model wrote.
//   - Deposit gate (rule R7). No assignment or scoping request goes to a
//     partner while the case is still Quoted. A quick verification question
//     before quoting is legitimate, which is why this warns rather than blocks.
//
// The sent message logs as partner_email_sent and appears in the partner pane.
// Partner mail carries no signature, by design: see partner-reply.ts.

interface Props {
  conversationId: string;
  caseSerialId?: string | null;
  /** The linked lead's stage, for the R7 deposit-gate notice. */
  clientStage?: string | null;
  /** Called after a successful send so the page can refresh the thread. */
  onSent?: () => void;
}

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

// Generation polling. Matches the customer path in review.$caseId.tsx: the
// Brain writes to the database in the background, so there is nothing to await.
const GEN_POLL_MS = 3000;
const GEN_TIMEOUT_MS = 180000;

// Stages at or after Active have cleared the deposit gate.
const ACTIVE_STAGE_ORDER = getClientStageSortOrder("Active");

export function CasePartnerReplyBox({ conversationId, caseSerialId, clientStage, onSent }: Props) {
  const [partners, setPartners] = useState<PartnerOption[]>([]);
  const [toEmail, setToEmail] = useState("");
  const [subject, setSubject] = useState(caseSerialId ? `${caseSerialId}: ` : "");
  // conversation (and caseSerialId) loads asynchronously in the parent and
  // arrives after this component has already mounted with caseSerialId still
  // null, so the useState initializer above misses it on the normal load path.
  // This effect fills the subject in once it arrives, but only if the person
  // has not already typed into the field.
  const subjectTouchedRef = useRef(false);
  const [bodyText, setBodyText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sentMsg, setSentMsg] = useState("");

  // Brain assist state.
  const [draft, setDraft] = useState<PartnerDraft | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);

  const beforeDeposit = !!clientStage && getClientStageSortOrder(clientStage) < ACTIVE_STAGE_ORDER;

  // The draft was written for one specific partner, with that partner's thread
  // in scope and every other partner's filtered out. Changing the recipient
  // afterwards is one click, and sending it as-is would put one partner's
  // context in front of another, which R6 forbids outright.
  //
  // Two distinct states, and neither may be treated as safe. A draft written
  // for someone else is a known mismatch. A draft with no recorded recipient is
  // UNKNOWN, not fine: the whole point of the check is that we cannot tell
  // whose context it carries, so absence of evidence gets its own warning
  // rather than falling through as a pass.
  const draftedForOther =
    !!draft?.drafted_for_email &&
    !!toEmail &&
    draft.drafted_for_email.toLowerCase() !== toEmail.toLowerCase();

  const draftUnattributed = !!draft && !draft.drafted_for_email;

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
        setError(`Could not load partners: ${err.message}`);
        return;
      }
      const rows = ((data as PartnerOption[] | null) ?? []).filter((p) => !!p.email);
      setPartners(rows);
      if (rows.length > 0) setToEmail(rows[0].email);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load any existing Brain draft, but never apply it automatically. Applying
  // it overwrites whatever is in the fields, and on mount there is no way to
  // know the operator did not mean to keep a half-typed message.
  //
  // Returns the error rather than swallowing it. This backs both the mount load
  // and every iteration of the poll loop below, so a query that keeps failing
  // (an RLS problem, a missing table before the migration is run) would
  // otherwise be indistinguishable from "no draft yet" and would surface three
  // minutes later as a generic timeout, hiding the actual cause.
  const loadDraft = useCallback(async (): Promise<{
    row: PartnerDraft | null;
    error: string | null;
  }> => {
    const { data, error: err } = await supabase
      .from("case_partner_drafts")
      .select("subject, body, internal_notes, pricing_flag, drafted_for_email, last_updated")
      .eq("case_id", conversationId)
      .maybeSingle();

    if (err) {
      console.error("[case-partner-reply-box] loadDraft failed:", err.message);
      return { row: null, error: err.message };
    }
    return { row: (data as PartnerDraft | null) ?? null, error: null };
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { row } = await loadDraft();
      if (!cancelled) setDraft(row);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDraft]);

  useEffect(() => {
    if (!subjectTouchedRef.current && caseSerialId) {
      setSubject(`${caseSerialId}: `);
    }
  }, [caseSerialId]);

  const applyDraft = (row: PartnerDraft) => {
    if (row.subject) {
      // Mark the subject touched so the caseSerialId effect above does not
      // overwrite the Brain's subject on the next parent refresh.
      subjectTouchedRef.current = true;
      setSubject(row.subject);
    }
    setBodyText(row.body ?? "");
    setConfirming(false);
  };

  const generate = async () => {
    setGenError("");
    if (!toEmail) {
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
        body: JSON.stringify({ conversation_id: conversationId, partner_email: toEmail }),
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

      // The Brain writes case_partner_drafts in the background, so poll until
      // last_updated moves past the baseline the server handed back.
      const baseline: string | null = payload.previousUpdatedAt ?? null;
      const startedAt = Date.now();

      while (Date.now() - startedAt < GEN_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, GEN_POLL_MS));

        const { row: fresh, error: readError } = await loadDraft();

        // Stop on a read failure rather than polling out. The Brain may well
        // have written the draft; what is broken is our ability to read it, and
        // saying so beats a three minute wait ending in "taking longer than
        // expected".
        if (readError) {
          setGenError(`Could not read the draft back: ${readError}`);
          return;
        }

        if (fresh && fresh.last_updated !== baseline) {
          setDraft(fresh);
          applyDraft(fresh);
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

  const selected = partners.find((p) => p.email === toEmail);

  const send = async () => {
    setSending(true);
    setError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/webhooks/partner-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          to_email: toEmail,
          subject,
          body: bodyText,
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

      setSentMsg(`Sent to ${selected?.full_name ?? toEmail}.`);
      setBodyText("");
      setConfirming(false);
      onSent?.();
      setTimeout(() => setSentMsg(""), 4000);
    } catch (err) {
      setError(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

  const canSend = !!toEmail && !!subject.trim() && !!bodyText.trim();

  return (
    <section className="card">
      <div className="card-head">
        <h2>Follow up with partner</h2>
        <span className="tag tag-internal">Internal</span>
        <div className="head-actions">
          {draft && !generating && (
            <button className="btn btn-sm" onClick={() => applyDraft(draft)}>
              Load Brain draft
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={generate}
            disabled={generating}
            title="Runs the Brain once for this case and drafts to the partner in Greek. Costs a single AI call. Nothing is sent."
          >
            {generating ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
                Drafting...
              </span>
            ) : draft ? (
              "Redraft with Brain"
            ) : (
              "Draft with Brain"
            )}
          </button>
          <span className="stamp">Sends from hello@mygreektax.eu, logs to the partner thread</span>
        </div>
      </div>

      <div className="card-body">
        {beforeDeposit && (
          <p
            className="text-sm border rounded px-3 py-2"
            style={{
              marginBottom: 12,
              color: "#92400e",
              borderColor: "#fcd34d",
              background: "#fffbeb",
            }}
          >
            This case is still at <span style={{ fontWeight: 600 }}>{clientStage}</span>. No
            assignment or scoping request goes to a partner before the deposit is confirmed. A quick
            verification question is fine.
          </p>
        )}

        {draftedForOther && (
          <p
            className="text-sm border border-red-200 bg-red-50 text-red-700 rounded px-3 py-2"
            style={{ marginBottom: 12 }}
          >
            This draft was written for{" "}
            <span style={{ fontWeight: 600 }}>{draft?.drafted_for_email}</span>, and the recipient
            is now someone else. It may carry that partner&apos;s context, which must not reach
            another partner. Redraft for the current recipient before sending.
          </p>
        )}

        {draftUnattributed && (
          <p
            className="text-sm border border-red-200 bg-red-50 text-red-700 rounded px-3 py-2"
            style={{ marginBottom: 12 }}
          >
            This draft has no recorded recipient, so there is no way to tell whose context it
            carries. Redraft before sending.
          </p>
        )}

        {draft?.pricing_flag && (
          <p
            className="text-sm border border-red-200 bg-red-50 text-red-700 rounded px-3 py-2"
            style={{ marginBottom: 12 }}
          >
            The Brain draft contains a currency figure. Partner-facing text carries no retail price,
            client fee total, margin or markup. Check every figure before sending, or replace it
            with <span style={{ fontWeight: 600 }}>κατόπιν συμφωνίας</span>.
          </p>
        )}

        {genError && (
          <p
            className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2"
            style={{ marginBottom: 12 }}
          >
            {genError}
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] gap-3">
          <div className="field">
            <label htmlFor="partner-to">To</label>
            <select
              id="partner-to"
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              className="mc-input"
            >
              {partners.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.full_name ? `${p.full_name} (${p.email})` : p.email}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="partner-subject">Subject</label>
            <input
              id="partner-subject"
              value={subject}
              onChange={(e) => {
                subjectTouchedRef.current = true;
                setSubject(e.target.value);
              }}
              className="mc-input"
            />
          </div>
        </div>

        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          rows={6}
          placeholder="Γράψε το μήνυμα προς τον συνεργάτη, ή πάτα Draft with Brain. Το MGT-REF-ID μπαίνει αυτόματα."
          className="mc-input"
          style={{ marginTop: 12 }}
        />

        {draft?.internal_notes && (
          <div style={{ marginTop: 12 }}>
            <button
              className="btn btn-sm"
              onClick={() => setNotesOpen((v) => !v)}
              aria-expanded={notesOpen}
            >
              {notesOpen ? "Hide Brain notes" : "Brain notes"}
            </button>
            {notesOpen && (
              <p
                className="text-sm"
                style={{
                  marginTop: 8,
                  whiteSpace: "pre-wrap",
                  color: "var(--mc-ink-2)",
                  border: "1px solid var(--mc-line)",
                  background: "var(--mc-page)",
                  borderRadius: 8,
                  padding: "8px 12px",
                }}
              >
                {draft.internal_notes}
              </p>
            )}
          </div>
        )}

        {!confirming && (
          <div className="flex items-center gap-3" style={{ marginTop: 12 }}>
            <button
              className="btn btn-solid"
              onClick={() => setConfirming(true)}
              disabled={!canSend || sending}
            >
              Send
            </button>
            {sentMsg && (
              <span className="text-xs" style={{ color: "var(--mc-ok)" }}>
                {sentMsg}
              </span>
            )}
          </div>
        )}

        {confirming && (
          <div
            className="callout"
            style={{ marginTop: 12, flexDirection: "column", alignItems: "stretch", gap: 8 }}
          >
            <p style={{ margin: 0, color: "var(--mc-ink)", fontSize: 13 }}>
              Send to <span style={{ fontWeight: 600 }}>{selected?.full_name ?? toEmail}</span>{" "}
              <span style={{ color: "var(--mc-ink-3)" }}>({toEmail})</span>?
            </p>
            <p style={{ margin: 0, fontSize: 12 }}>
              <span style={{ fontWeight: 600 }}>Subject:</span> {subject}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                whiteSpace: "pre-wrap",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {bodyText.slice(0, 160)}
              {bodyText.length > 160 ? "…" : ""}
            </p>
            <div className="flex items-center gap-2" style={{ paddingTop: 4 }}>
              <button className="btn btn-solid" onClick={send} disabled={sending}>
                {sending ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    Sending...
                  </span>
                ) : (
                  "Confirm send"
                )}
              </button>
              <button className="btn" onClick={() => setConfirming(false)} disabled={sending}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && (
          <p
            className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2"
            style={{ marginTop: 12 }}
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
