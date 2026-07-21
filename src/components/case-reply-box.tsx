import { useState } from "react";
// Adjust this import to your actual Supabase browser client export.
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

type CaseReplyBoxProps = {
  /** Customer email (the recipient). */
  clientEmail: string;
  /** Customer display name, optional. */
  clientName?: string;
  /** Case serial, e.g. "MGT-CS001-CLT0028". Used for threading + logging. */
  caseSerialId?: string;
  /** Subject of the message being replied to, optional (prefills "Re: ..."). */
  replyToSubject?: string;
  /** Called after a successful send, so the parent can refresh the timeline. */
  onSent?: () => void;
};

export function CaseReplyBox({
  clientEmail,
  clientName,
  caseSerialId,
  replyToSubject,
  onSent,
}: CaseReplyBoxProps) {
  const initialSubject = replyToSubject
    ? replyToSubject.replace(/^(re:\s*)+/i, "").length
      ? `Re: ${replyToSubject.replace(/^(re:\s*)+/i, "")}`
      : replyToSubject
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

      const res = await fetch("/api/case-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          toEmail: clientEmail,
          clientName,
          caseSerialId,
          subject,
          body: message,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error || "Send failed.");
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
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">To</Label>
        <div className="text-sm text-foreground">
          {clientName ? `${clientName} · ` : ""}
          {clientEmail}
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="reply-subject" className="text-xs text-muted-foreground">
          Subject
        </Label>
        <Input
          id="reply-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="reply-body" className="text-xs text-muted-foreground">
          Message
        </Label>
        <Textarea
          id="reply-body"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Write your reply..."
          rows={8}
        />
      </div>

      <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        Signature added automatically:
        <br />
        Με εκτίμηση,
        <br />
        Δημήτρης
        <br />
        MyGreekTax
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {sentOk && <p className="text-sm text-green-600">Sent and logged to this case.</p>}

      <div className="flex items-center justify-end gap-2">
        <Button onClick={handleSend} disabled={sending}>
          {sending ? "Sending..." : "Send reply"}
        </Button>
      </div>
    </div>
  );
}
