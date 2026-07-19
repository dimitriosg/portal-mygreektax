import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { supabase } from '@/integrations/supabase/client';
import { AiReviewDesk } from '@/components/AiReviewDesk';
import { Card, CardContent } from '@/components/ui/card';

// Review page for cases that have an AI draft but no job record.
// Lead path cases carry the client id as their case_id, so the full
// /jobs/$jobId page cannot load them: getJob looks for a job row and
// finds nothing. This page reads only what a draft actually has.

interface ClientInfo {
  full_name: string | null;
  email: string | null;
}

interface TimelineRow {
  id: string;
  event_type: string | null;
  sender: string | null;
  payload: { text?: string } | null;
  created_at: string | null;
}

const SENDER_LABELS: Record<string, string> = {
  customer: 'Client',
  partner: 'Partner',
  ai_agent: 'Brain',
  internal: 'You',
};

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export const Route = createFileRoute('/review/$caseId')({
  component: ReviewCase,
});

function ReviewCase() {
  const { caseId } = Route.useParams();
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [clientRes, timelineRes] = await Promise.all([
        supabase
          .from('clients')
          .select('full_name, email')
          .eq('id', caseId)
          .maybeSingle(),
        supabase
          .from('case_timeline')
          .select('id, event_type, sender, payload, created_at')
          .eq('case_id', caseId)
          .order('created_at', { ascending: true })
          .limit(50),
      ]);

      if (cancelled) return;
      setClient((clientRes.data as ClientInfo | null) ?? null);
      setTimeline((timelineRes.data as TimelineRow[] | null) ?? []);
      setLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const title =
    client?.full_name || client?.email || `Case ${caseId.slice(0, 8)}`;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <Link
          to="/drafts"
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          Back to drafts
        </Link>
        <h1 className="text-2xl font-serif font-semibold text-slate-900 mt-2">
          {title}
        </h1>
        {client?.email && (
          <p className="text-sm text-slate-500">{client.email}</p>
        )}
      </div>

      {/* The incoming message is the context the draft is answering. */}
      <Card className="border-slate-200">
        <CardContent className="py-4 space-y-4">
          <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
            Conversation
          </h2>
          {loading && (
            <p className="text-sm text-slate-400">Loading conversation...</p>
          )}
          {!loading && timeline.length === 0 && (
            <p className="text-sm text-slate-400">
              No messages logged for this case yet.
            </p>
          )}
          {timeline.map((row) => (
            <div key={row.id} className="border-l-2 border-slate-200 pl-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-700">
                  {SENDER_LABELS[row.sender ?? ''] ?? row.sender ?? 'Unknown'}
                </span>
                <span className="text-xs text-slate-400">
                  {formatWhen(row.created_at)}
                </span>
              </div>
              <p className="text-sm text-slate-600 whitespace-pre-wrap mt-1">
                {row.payload?.text ?? ''}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <AiReviewDesk jobId={caseId} />
    </div>
  );
}
