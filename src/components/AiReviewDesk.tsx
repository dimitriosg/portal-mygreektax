import React, { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Uses the app's shared, session-aware Supabase client. Creating a second
// client here would run unauthenticated and trip the "Multiple GoTrueClient
// instances" warning.

interface AiReviewDeskProps {
  jobId: string;
}

type SendStatus =
  | { kind: 'idle' }
  | { kind: 'sent'; detail: string }
  | { kind: 'error'; detail: string };

export const AiReviewDesk: React.FC<AiReviewDeskProps> = ({ jobId }) => {
  const [draft, setDraft] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [isApproved, setIsApproved] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [status, setStatus] = useState<SendStatus>({ kind: 'idle' });

  // Helper function to pull the absolute static snapshot state
  const fetchAiDraft = async () => {
    const { data, error } = await supabase
      .from('case_drafts')
      .select('*')
      .eq('case_id', jobId);

    if (data && data.length > 0 && !error) {
      setDraft(data[0].proposed_draft || '');
      setNotes(data[0].internal_notes || '');
      setIsApproved(Boolean(data[0].is_approved));
    } else {
      // Clear states if a row was deleted externally
      setDraft('');
      setNotes('');
      setIsApproved(false);
    }
    setLoading(false);
  };

  useEffect(() => {
    // 1. Initial snapshot fetch execution
    fetchAiDraft();

    // 2. Realtime subscription: listen for INSERT and UPDATE operations on
    // the case_drafts table filtered to this jobId, so new Brain output
    // appears without a refresh.
    const draftSubscription = supabase
      .channel(`realtime:job_drafts:${jobId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'case_drafts',
          filter: `case_id=eq.${jobId}`
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setDraft('');
            setNotes('');
            setIsApproved(false);
          } else {
            const newRecord = payload.new as any;
            setDraft(newRecord.proposed_draft || '');
            setNotes(newRecord.internal_notes || '');
            setIsApproved(Boolean(newRecord.is_approved));
          }
        }
      )
      .subscribe();

    // 3. Disconnect the websocket listener when navigating away
    return () => {
      supabase.removeChannel(draftSubscription);
    };
  }, [jobId]);

  const handleApproveAndSend = async () => {
    setSubmitting(true);
    setStatus({ kind: 'idle' });
    try {
      // Same origin server route. It resolves the recipient, marks the
      // draft approved, logs the timeline event, and forwards to Make.
      const response = await fetch('/webhooks/send-approved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: jobId, final_text: draft }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        const detail =
          result?.detail || result?.error || `Send failed (${response.status})`;
        setStatus({ kind: 'error', detail });
        return;
      }

      setIsApproved(true);
      setStatus({
        kind: 'sent',
        detail: `Sent to ${result.sent_to || 'the client'}.`,
      });
    } catch (err: any) {
      setStatus({
        kind: 'error',
        detail: err?.message || 'Network error while sending.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 text-center text-sm text-gray-500">
        Checking for a waiting draft...
      </div>
    );
  }

  // Keep the confirmation visible after a send instead of vanishing.
  if (!draft) {
    if (status.kind === 'sent') {
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
      {/* LEFT PANEL: Technical Tax Notes */}
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

      {/* RIGHT PANEL: Live Interactive Workspace Panel */}
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
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 min-h-[280px] font-sans text-sm p-3 border border-slate-200 rounded-md focus-visible:ring-amber-500 bg-slate-50/30"
          />
          <Button
            onClick={handleApproveAndSend}
            disabled={submitting || !draft.trim()}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-all shadow-md py-5"
          >
            {submitting
              ? 'Sending...'
              : isApproved
                ? 'Send again'
                : 'Approve and send'}
          </Button>
          {status.kind === 'sent' && (
            <p className="text-sm text-emerald-700">{status.detail}</p>
          )}
          {status.kind === 'error' && (
            <p className="text-sm text-red-600">
              Not sent: {status.detail}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
