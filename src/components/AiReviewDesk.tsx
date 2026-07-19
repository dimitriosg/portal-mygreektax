import React, { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RichTextEditor } from "@/components/RichTextEditor";

// Uses the app's shared, session-aware Supabase client.

interface AiReviewDeskProps {
  jobId: string;
}

type SendStatus =
  | { kind: "idle" }
  | { kind: "sent"; detail: string }
  | { kind: "error"; detail: string };

// The Brain writes PLAIN TEXT drafts. The rich editor needs HTML. This
// converts a plain-text draft to simple paragraph HTML so it loads looking
// right: blank lines become paragraph breaks, single newlines become <br>.
// If the stored content already looks like HTML (a previously sent/edited
// draft), it is loaded as-is.
function toEditorHtml(raw: string): string {
  if (!raw) return "";
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  if (looksLikeHtml) return raw;

  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return raw
    .split(/\n{2,}/)
    .map((para) => `<p>${escape(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Tags/attributes allowed in outbound email HTML. Deliberately narrow: the
// formatting the toolbar can produce, nothing more. style is allowed only so
// inline text colour (which email clients require) survives; DOMPurify still
// cleans the style values.
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "a", "span"],
  ALLOWED_ATTR: ["href", "target", "rel", "style"],
};

export const AiReviewDesk: React.FC<AiReviewDeskProps> = ({ jobId }) => {
  const [draftHtml, setDraftHtml] = useState<string>("");
  const [editorHtml, setEditorHtml] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [isApproved, setIsApproved] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [status, setStatus] = useState<SendStatus>({ kind: "idle" });

  // Load the draft once on mount. No realtime replacement here: regeneration
  // is handled by the parent remounting this component, so we never overwrite
  // the operator's in-progress edits.
  useEffect(() => {
    let cancelled = false;

    const fetchDraft = async () => {
      const { data, error } = await supabase
        .from("case_drafts")
        .select("proposed_draft, internal_notes, is_approved")
        .eq("case_id", jobId)
        .maybeSingle();

      if (cancelled) return;

      if (data && !error) {
        const raw = (data as any).proposed_draft || "";
        setDraftHtml(toEditorHtml(raw));
        setNotes((data as any).internal_notes || "");
        setIsApproved(Boolean((data as any).is_approved));
      } else {
        setDraftHtml("");
        setNotes("");
        setIsApproved(false);
      }
      setLoading(false);
    };

    fetchDraft();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const handleApproveAndSend = async () => {
    setSubmitting(true);
    setStatus({ kind: "idle" });
    try {
      // Sanitize the editor HTML on the way out. The operator is trusted, but
      // this keeps the outbound body to a known, email-safe tag set.
      const cleanHtml = DOMPurify.sanitize(editorHtml || draftHtml, SANITIZE_CONFIG);

      if (!cleanHtml.replace(/<[^>]*>/g, "").trim()) {
        setStatus({ kind: "error", detail: "The draft is empty." });
        setSubmitting(false);
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      const response = await fetch("/webhooks/send-approved", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ case_id: jobId, final_text: cleanHtml }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        const detail = result?.detail || result?.error || `Send failed (${response.status})`;
        setStatus({ kind: "error", detail });
        return;
      }

      setIsApproved(true);
      setStatus({ kind: "sent", detail: `Sent to ${result.sent_to || "the client"}.` });
    } catch (err: any) {
      setStatus({ kind: "error", detail: err?.message || "Network error while sending." });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 text-center text-sm text-gray-500">Checking for a waiting draft...</div>
    );
  }

  if (!draftHtml) {
    if (status.kind === "sent") {
      return (
        <div className="p-4 border rounded-xl bg-emerald-50 text-emerald-800 text-sm">
          {status.detail} The reply thread will pick up from here.
        </div>
      );
    }
    return null;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 border rounded-xl bg-slate-50/50 shadow-inner animate-in fade-in slide-in-from-top-4 duration-300">
      {/* LEFT: technical notes from the Brain (plain, read-only). */}
      <Card className="bg-[#0B192C] text-white border-none shadow-md">
        <CardHeader>
          <CardTitle className="text-amber-400 font-serif text-lg flex items-center gap-2">
            <span>🧠</span> Brain Technical Compliance Insights
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-relaxed whitespace-pre-wrap font-mono opacity-90">
          {notes}
        </CardContent>
      </Card>

      {/* RIGHT: editable rich-text draft. */}
      <Card className="border border-slate-200 bg-white shadow-md flex flex-col">
        <CardHeader>
          <CardTitle className="text-slate-800 text-lg font-sans font-semibold flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span>✍️</span> Editable Outbound Email Draft
            </span>
            {isApproved && (
              <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                Approved
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col gap-4">
          <RichTextEditor initialHtml={draftHtml} onChange={setEditorHtml} />
          <Button
            onClick={handleApproveAndSend}
            disabled={submitting}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-all shadow-md py-5"
          >
            {submitting ? "Sending..." : isApproved ? "Send again" : "Approve and send"}
          </Button>
          {status.kind === "sent" && <p className="text-sm text-emerald-700">{status.detail}</p>}
          {status.kind === "error" && (
            <p className="text-sm text-red-600">Not sent: {status.detail}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
