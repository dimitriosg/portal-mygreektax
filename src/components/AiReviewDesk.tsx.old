import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Initialize your portal's client using existing app config keys
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);

interface AiReviewDeskProps {
  jobId: string;
}

export const AiReviewDesk: React.FC<AiReviewDeskProps> = ({ jobId }) => {
  const [draft, setDraft] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Helper function to pull the absolute static snapshot state
  const fetchAiDraft = async () => {
    const { data, error } = await supabase
      .from('case_drafts')
      .select('*')
      .eq('case_id', jobId);

    if (data && data.length > 0 && !error) {
      setDraft(data[0].proposed_draft);
      setNotes(data[0].internal_notes);
    } else {
      // Clear states if a row was deleted or approved externally
      setDraft('');
      setNotes('');
    }
    setLoading(false);
  };

  useEffect(() => {
    // 1. Initial snapshot fetch execution
    fetchAiDraft();

    // 2. 🚀 THE REALTIME SUBSCRIPTION LOOP
    // Listen for any INSERT or UPDATE operations on the case_drafts table filtering for this jobId
    const draftSubscription = supabase
      .channel(`realtime:job_drafts:${jobId}`)
      .on(
        'postgres_changes',
        {
          event: '*', // Listen to INSERTs, UPDATEs, and DELETEs
          schema: 'public',
          table: 'case_drafts',
          filter: `case_id=eq.${jobId}`
        },
        (payload) => {
          console.log('Realtime database sync event received:', payload);
          
          if (payload.eventType === 'DELETE') {
            setDraft('');
            setNotes('');
          } else {
            // It's an INSERT or UPDATE from your AWS Lambda Cloud brain
            const newRecord = payload.new as any;
            setDraft(newRecord.proposed_draft || '');
            setNotes(newRecord.internal_notes || '');
          }
        }
      )
      .subscribe();

    // 3. CLEANUP VECTOR: Disconnect the websocket listener when navigating away
    return () => {
      supabase.removeChannel(draftSubscription);
    };
  }, [jobId]);

  const handleApproveAndSend = async () => {
    setSubmitting(true);
    try {
      // Step A: Mark as approved in your local table index
      const { error: dbError } = await supabase
        .from('case_drafts')
        .update({ is_approved: true, proposed_draft: draft })
        .eq('case_id', jobId);

      if (dbError) throw dbError;

      // Step B: Trigger your Outbound Webhook to your mailer scenario
      const response = await fetch('https://mygreektax.eu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: jobId, final_text: draft }),
      });

      if (!response.ok) throw new Error('Outbound transit routing failed.');
      
      // Clear out the desk states locally after successful transmission
      setDraft('');
      setNotes('');
      alert('AI draft successfully approved and sent out to user thread!');
    } catch (err: any) {
      console.error('Approval submission failed:', err.message);
      alert('Failed to transmit approved email.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-4 text-center text-sm text-gray-500">Syncing Brain channels...</div>;
  if (!draft) return null; // Component completely returns empty and vanishes when idle

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
          <CardTitle className="text-slate-800 text-lg font-sans font-semibold flex items-center gap-2">
            <span>✍️</span> Editable Outbound Email Draft
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
            disabled={submitting}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-all shadow-md py-5"
          >
            {submitting ? 'Transmitting Email via Outbound Webhook...' : '🚀 Approve & Send Outbound'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
