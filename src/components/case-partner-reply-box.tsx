import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Follow up with partner.
//
// Plain compose box for mailing the accountant partner from inside the case.
// Deliberately not Brain-assisted yet: partner drafting arrives with the
// pricing-compartment work, and until that fencing exists, what goes to the
// partner is typed by a human.
//
// Send is two-step. Send opens a confirmation showing exactly who receives it
// and what, and only Confirm fires. The server independently refuses any
// recipient that is not an active partner, so the dropdown is convenience, not
// the guard.
//
// The sent message logs as partner_email_sent and appears in the partner pane.

interface Props {
  conversationId: string;
  caseSerialId?: string | null;
  /** Called after a successful send so the page can refresh the thread. */
  onSent?: () => void;
}

interface PartnerOption {
  email: string;
  full_name: string | null;
}

export function CasePartnerReplyBox({ conversationId, caseSerialId, onSent }: Props) {
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

  useEffect(() => {
    if (!subjectTouchedRef.current && caseSerialId) {
      setSubject(`${caseSerialId}: `);
    }
  }, [caseSerialId]);

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
        <span className="head-actions stamp">
          Sends from hello@mygreektax.eu, logs to the partner thread
        </span>
      </div>

      <div className="card-body">
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
          placeholder="Γράψε το μήνυμα προς τον συνεργάτη. Η υπογραφή και το MGT-REF-ID μπαίνουν αυτόματα."
          className="mc-input"
          style={{ marginTop: 12 }}
        />

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
