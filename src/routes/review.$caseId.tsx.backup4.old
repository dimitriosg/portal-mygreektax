import { useEffect, useState, useCallback } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AiReviewDesk } from "@/components/AiReviewDesk";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CaseReplyBox } from "@/components/case-reply-box";

// Case review page (new spine). The route param $caseId is a
// brain_conversations.id. This page shows the full conversation from
// brain_events, lets Jim read it, then Generate a draft on demand, then
// review/edit/send it via AiReviewDesk. Read first, decide, then generate.

interface ConversationInfo {
  id: string;
  case_serial_id: string | null;
  customer_email: string | null;
  stage: string | null;
  client_id: string | null;
}

interface ClientInfo {
  full_name: string | null;
  email: string | null;
  client_code: string | null;
}

interface EventRow {
  id: string;
  event_type: string | null;
  actor: string | null;
  direction: string | null;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  occurred_at: string | null;
}

// Conversation display: nothing, the latest message only, or the full thread.
type ConvView = "collapsed" | "latest" | "all";

const ACTOR_LABELS: Record<string, string> = {
  customer: "Client",
  partner: "Partner",
  ai_agent: "Brain",
  internal: "You",
  system: "System",
  dimitris: "You",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export const Route = createFileRoute("/review/$caseId")({
  component: ReviewCase,
});

function ReviewCase() {
  const { caseId } = Route.useParams(); // brain_conversations.id
  const [conversation, setConversation] = useState<ConversationInfo | null>(null);
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string>("");
  const [hasDraft, setHasDraft] = useState(false);
  const [draftStamp, setDraftStamp] = useState<string>("none");
  const [convView, setConvView] = useState<ConvView>("latest");

  const load = useCallback(async () => {
    const { data: convData } = await supabase
      .from("brain_conversations")
      .select("id, case_serial_id, customer_email, stage, client_id")
      .eq("id", caseId)
      .maybeSingle();

    const conv = (convData as ConversationInfo | null) ?? null;
    setConversation(conv);

    if (conv?.client_id) {
      const { data: clientData } = await supabase
        .from("clients")
        .select("full_name, email, client_code")
        .eq("id", conv.client_id)
        .maybeSingle();
      setClient((clientData as ClientInfo | null) ?? null);
    }

    const { data: eventData } = await supabase
      .from("brain_events")
      .select("id, event_type, actor, direction, from_email, subject, body_text, occurred_at")
      .eq("conversation_id", caseId)
      .order("occurred_at", { ascending: true })
      .limit(100);
    setEvents((eventData as EventRow[] | null) ?? []);

    // Does a draft already exist for this case?
    const { data: draftData } = await supabase
      .from("case_drafts")
      .select("case_id, proposed_draft, last_updated")
      .eq("case_id", caseId)
      .maybeSingle();
    setHasDraft(!!(draftData as any)?.proposed_draft);
    setDraftStamp(((draftData as any)?.last_updated as string) || "none");

    setLoading(false);
  }, [caseId]);

  useEffect(() => {
    load();

    // Refresh when a draft lands (so the desk appears right after Generate).
    const channel = supabase
      .channel(`realtime:case-review:${caseId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "case_drafts", filter: `case_id=eq.${caseId}` },
        () => load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "brain_events", filter: `conversation_id=eq.${caseId}` },
        () => load(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [caseId, load]);

  const generate = async () => {
    setGenError("");
    setGenerating(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/webhooks/generate-draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ conversation_id: caseId }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail =
          typeof payload?.detail === "string" ? payload.detail : payload?.error ?? `HTTP ${res.status}`;
        setGenError(`Generation failed: ${detail}`);
      } else {
        await load();
      }
    } catch (err) {
      setGenError(
        `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setGenerating(false);
    }
  };

  const title =
    client?.full_name ||
    client?.email ||
    conversation?.customer_email ||
    `Case ${caseId.slice(0, 8)}`;

  const email = client?.email || conversation?.customer_email || "";

  // Which events to render for the current view.
  const visibleEvents =
    convView === "all" ? events : convView === "latest" ? events.slice(-1) : [];

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <Link to="/drafts" className="text-sm text-slate-500 hover:text-slate-800">
          Back to cases
        </Link>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <h1 className="text-2xl font-serif font-semibold text-slate-900">{title}</h1>
          {conversation?.case_serial_id && (
            <span className="text-xs font-mono text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">
              {conversation.case_serial_id}
            </span>
          )}
          {conversation?.stage && (
            <span className="text-xs text-slate-400">{conversation.stage}</span>
          )}
        </div>
        {email && <p className="text-sm text-slate-500">{email}</p>}
      </div>

      {/* The conversation: read this before deciding to generate. */}
      <Card className="border-slate-200">
        <CardContent className="py-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
              Conversation
            </h2>
            {!loading && events.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant={convView === "collapsed" ? "default" : "outline"}
                  onClick={() => setConvView("collapsed")}
                  className={`h-7 px-2.5 text-xs ${convView === "collapsed" ? "bg-[#0B192C] text-white" : ""}`}
                >
                  Collapse
                </Button>
                <Button
                  variant={convView === "latest" ? "default" : "outline"}
                  onClick={() => setConvView("latest")}
                  className={`h-7 px-2.5 text-xs ${convView === "latest" ? "bg-[#0B192C] text-white" : ""}`}
                >
                  Latest
                </Button>
                <Button
                  variant={convView === "all" ? "default" : "outline"}
                  onClick={() => setConvView("all")}
                  className={`h-7 px-2.5 text-xs ${convView === "all" ? "bg-[#0B192C] text-white" : ""}`}
                >
                  All ({events.length})
                </Button>
              </div>
            )}
          </div>

          {loading && <p className="text-sm text-slate-400">Loading conversation...</p>}
          {!loading && events.length === 0 && (
            <p className="text-sm text-slate-400">No messages logged for this case yet.</p>
          )}

          {visibleEvents.map((row) => (
            <div key={row.id} className="border-l-2 border-slate-200 pl-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-700">
                  {ACTOR_LABELS[row.actor ?? ""] ?? row.actor ?? "Unknown"}
                </span>
                {row.direction && (
                  <span className="text-xs text-slate-400">({row.direction})</span>
                )}
                <span className="text-xs text-slate-400">{formatWhen(row.occurred_at)}</span>
              </div>
              {row.subject && (
                <p className="text-xs text-slate-500 mt-1">Subject: {row.subject}</p>
              )}
              <p className="text-sm text-slate-600 whitespace-pre-wrap mt-1">
                {row.body_text ?? ""}
              </p>
            </div>
          ))}

          {!loading && convView === "latest" && events.length > 1 && (
            <p className="text-xs text-slate-400 italic">
              Showing the latest message only. {events.length - 1} earlier hidden.
            </p>
          )}
          {!loading && convView === "collapsed" && events.length > 0 && (
            <p className="text-xs text-slate-400 italic">
              Conversation collapsed. {events.length} message{events.length === 1 ? "" : "s"} hidden.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Case Reply Box */}
      <CaseReplyBox
        conversationId={caseId}
        clientEmail={email}
        clientName={client?.full_name ?? undefined}
        caseSerialId={conversation?.case_serial_id ?? undefined}
        replyToSubject={events.length ? events[events.length - 1].subject ?? undefined : undefined}
        onSent={load}
      />

      {/* Generate control: only shown when no draft exists yet. Once a draft
          is present, AiReviewDesk below takes over with edit + send. */}
      {!loading && !hasDraft && (
        <div className="flex flex-col items-start gap-2">
          <Button
            onClick={generate}
            disabled={generating}
            className="bg-[#0B192C] hover:bg-slate-800 text-white"
          >
            {generating ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                Generating draft...
              </span>
            ) : (
              "Generate draft"
            )}
          </Button>
          <p className="text-xs text-slate-400">
            Runs the Brain once for this case. Costs a single AI call. Nothing is sent until you
            review and approve.
          </p>
          {generating && (
            <div className="flex items-center gap-2 text-sm text-slate-600 border border-slate-200 bg-slate-50 rounded px-3 py-2">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />
              The Brain is reading the conversation and drafting a reply. This usually takes a few
              seconds.
            </div>
          )}
          {genError && (
            <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">
              {genError}
            </p>
          )}
        </div>
      )}

      {/* When a draft exists, the desk shows it for edit + approve + send, and
          offers a regenerate path. */}
      {hasDraft && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={generate}
              disabled={generating}
              className="h-8 px-3 text-xs"
              title="Regenerate: runs the Brain again and replaces the current draft"
            >
              {generating ? "Regenerating..." : "Regenerate draft"}
            </Button>
            {genError && <span className="text-sm text-red-600">{genError}</span>}
          </div>
          <AiReviewDesk key={draftStamp} jobId={caseId} />
        </div>
      )}
    </div>
  );
}
