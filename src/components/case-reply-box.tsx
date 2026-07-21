import { useState } from "react";
import DOMPurify from "dompurify";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        body: JSON.stringify({ conversationId, toEmail: clientEmail, caseSerialId, subject, bodyHtml: cleanHtml }),
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
    <Card className="border border-slate-200 bg-white shadow-md">
      <CardHeader>
        <CardTitle className="text-slate-800 text-lg font-sans font-semibold flex items-center gap-2">
          <span>✍️</span> Reply to {clientName ? `${clientName} · ` : ""}
          {clientEmail}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Message</label>
          <div className="mt-1">
            <RichTextEditor initialHtml="" onChange={setBodyHtml} />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Signature</label>
          <p className="text-xs text-slate-400 mb-1">
            Loaded from the default. Edit here to change it for this email only.
          </p>
          <RichTextEditor initialHtml={signatureHtml} onChange={setSignatureHtml} />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {sentOk && <p className="text-sm text-emerald-600">Sent and logged to this case.</p>}
        <Button
          onClick={handleSend}
          disabled={sending}
          className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-5"
        >
          {sending ? "Sending..." : "Send reply"}
        </Button>
      </CardContent>
    </Card>
  );
}
