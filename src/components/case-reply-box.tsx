import { useState } from "react";
import DOMPurify from "dompurify";
import { supabase } from "@/integrations/supabase/client";
import { RichTextEditor } from "@/components/RichTextEditor";
import { getSignatureHtml } from "@/lib/signature";

type CaseReplyBoxProps = {
  conversationId: string;
  clientEmail: string;
  clientName?: string;
  caseSerialId?: string;
  replyToSubject?: string;
  onSent?: () => void;
};

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "a", "span"],
  ALLOWED_ATTR: ["href", "target", "rel", "style"],
};

export function CaseReplyBox({
  conversationId,
  clientEmail,
  clientName,
  caseSerialId,
  replyToSubject,
  onSent,
}: CaseReplyBoxProps) {
  const base = (replyToSubject || "").replace(/^(re:\s*)+/i, "").trim();
  const initialSubject = base ? `Re: ${base}` : caseSerialId ? `Re: ${caseSerialId}` : "";

  const [subject, setSubject] = useState(initialSubject);
  const [bodyHtml, setBodyHtml] = useState("");
  const [signatureHtml, setSignatureHtml] = useState(getSignatureHtml());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentOk, setSentOk] = useState(false);

  async function handleSend() {
    setError(null);
    // Stitch body + signature, sanitize once, flatten list items (mirrors AiReviewDesk).
    const combined = `${bodyHtml}<br>${signatureHtml}`;
    let cleanHtml = DOMPurify.sanitize(combined, SANITIZE_CONFIG);
    cleanHtml = cleanHtml.replace(/<li>\s*<p>/gi, "<li>").replace(/<\/p>\s*<\/li>/gi, "</li>");
    if (!cleanHtml.replace(/<[^>]*>/g, "").trim()) {
      setError("Write a message first.");
      return;
    }
    setSending(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setError("Your session expired. Sign in again.");
        setSending(false);
        return;
      }
      const res = await fetch("/webhooks/case-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          conversationId,
          toEmail: clientEmail,
          caseSerialId,
          subject,
          bodyHtml: cleanHtml,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error || `Send failed (HTTP ${res.status}).`);
        setSending(false);
        return;
      }
      setBodyHtml("");
      setSentOk(true);
      setTimeout(() => setSentOk(false), 4000);
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Reply to client</h2>
        {(clientName || clientEmail) && (
          <span className="head-actions stamp">
            {clientName ? `${clientName} · ` : ""}
            {clientEmail}
          </span>
        )}
      </div>
      <div className="card-body">
        <div className="field" style={{ marginBottom: 12 }}>
          <label htmlFor="reply-subject">Subject</label>
          <input
            id="reply-subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="mc-input"
          />
        </div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label>Message</label>
          <RichTextEditor initialHtml="" onChange={setBodyHtml} />
        </div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label>Signature</label>
          <p className="stamp" style={{ marginBottom: 2 }}>
            Loaded from the default. Edit here to change it for this email only.
          </p>
          <RichTextEditor initialHtml={signatureHtml} onChange={setSignatureHtml} />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {sentOk && (
          <p className="text-sm" style={{ color: "var(--mc-ok)" }}>
            Sent and logged to this case.
          </p>
        )}
        <div className="reply-foot">
          <button className="btn btn-solid" onClick={handleSend} disabled={sending}>
            {sending ? "Sending..." : "Send reply"}
          </button>
        </div>
      </div>
    </section>
  );
}
