import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type CaseReplyBoxProps = {
  /** brain_conversations.id (the caseId in the route). Required. */
  conversationId: string;
  /** Customer email (the recipient). */
  clientEmail: string;
  /** Customer display name, optional. */
  clientName?: string;
  /** Case serial, e.g. "MGT-CS001-CLT0028". Used for the reply's ref line. */
  caseSerialId?: string;
  /** Subject of the message being replied to, optional (prefills "Re: ..."). */
  replyToSubject?: string;
  /** Called after a successful send, so the parent can refresh. */
  onSent?: () => void;
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
  const initialSubject = base
    ? `Re: ${base}`
    : caseSerialId
      ? `Re: ${caseSerialId}`
      : "";

  const [subject, setSubject] = useState(initialSubject);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentOk, setSentOk] = useState(false);

  async function handleSend() {
    setError(null);
    if (!message.trim()) {
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
          clientName,
          caseSerialId,
          subject,
          body: message,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error || `Send failed (HTTP ${res.status}).`);
        setSending(false);
        return;
      }

      setMessage("");
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
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="text-sm text-slate-700">
        Reply to <span className="font-medium">{clientName ? `${clientName} · ` : ""}{clientEmail}</span>
      </div>

      <Input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
      />

      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Write your reply..."
        rows={8}
      />

      <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Signature added automatically: Με εκτίμηση, Δημήτρης, MyGreekTax
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {sentOk && <p className="text-sm text-emerald-600">Sent and logged to this case.</p>}

      <div className="flex items-center justify-end">
        <Button
          onClick={handleSend}
          disabled={sending}
          className="bg-[#0B192C] hover:bg-slate-800 text-white"
        >
          {sending ? "Sending..." : "Send reply"}
        </Button>
      </div>
    </div>
  );
}
