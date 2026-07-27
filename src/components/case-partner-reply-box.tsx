import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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
          typeof payload?.detail === "string" ? payload.detail : payload?.error ?? `HTTP ${res.status}`;
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
    <Card className="border-slate-200">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
            Follow up with partner
          </h2>
          <span className="text-[10px] uppercase tracking-wide bg-amber-50 text-amber-800 rounded px-1.5 py-0.5">
            Internal
          </span>
          <span className="ml-auto text-xs text-slate-400">
            Sends from hello@mygreektax.eu, logs to the partner thread
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
              To
            </label>
            <select
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {partners.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.full_name ? `${p.full_name} (${p.email})` : p.email}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
              Subject
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>
        </div>

        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          rows={6}
          placeholder="Γράψε το μήνυμα προς τον συνεργάτη. Η υπογραφή και το MGT-REF-ID μπαίνουν αυτόματα."
          className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        />

        {!confirming && (
          <div className="flex items-center gap-3">
            <Button
              onClick={() => setConfirming(true)}
              disabled={!canSend || sending}
              className="bg-[#0B192C] hover:bg-slate-800 text-white h-8 px-4 text-sm"
            >
              Send
            </Button>
            {sentMsg && <span className="text-xs text-emerald-700">{sentMsg}</span>}
          </div>
        )}

        {confirming && (
          <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-2">
            <p className="text-sm text-slate-800">
              Send to <span className="font-medium">{selected?.full_name ?? toEmail}</span>{" "}
              <span className="text-slate-500">({toEmail})</span>?
            </p>
            <p className="text-xs text-slate-600">
              <span className="font-medium">Subject:</span> {subject}
            </p>
            <p className="text-xs text-slate-600 line-clamp-2 whitespace-pre-wrap">
              {bodyText.slice(0, 160)}
              {bodyText.length > 160 ? "…" : ""}
            </p>
            <div className="flex items-center gap-2 pt-1">
              <Button
                onClick={send}
                disabled={sending}
                className="bg-[#0B192C] hover:bg-slate-800 text-white h-8 px-4 text-sm"
              >
                {sending ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    Sending...
                  </span>
                ) : (
                  "Confirm send"
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => setConfirming(false)}
                disabled={sending}
                className="h-8 px-4 text-sm"
              >
                Cancel
              </Button>
            </div>
          </div>
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
