import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Textarea } from '@/components/ui/textarea'; // Standard shadcn component
import { Button } from '@/components/ui/button';     // Standard shadcn component
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Initialize your portal's client using existing app config keys
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);

interface AiReviewDeskProps {
  jobId: string; // Maps straight to your case_id parameter tracking
}

export const AiReviewDesk: React.FC<AiReviewDeskProps> = ({ jobId }) => {
  const [draft, setDraft] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // 1. Automatically fetch the live, structured AI draft from your Supabase table
  useEffect(() => {
    const fetchAiDraft = async () => {
      const { data, error } = await supabase
        .from('case_drafts')
        .select('*')
        .eq('case_id', jobId)
        .single();

      if (data && !error) {
        setDraft(data.proposed_draft);
        setNotes(data.internal_notes);
      }
      setLoading(false);
    };

    fetchAiDraft();
  }, [jobId]);

  // 2. Action handler when you click "Approve & Send Email"
  const handleApproveAndSend = async () => {
    setSubmitting(true);
    try {
      // Step A: Update the database to lock the row as approved
      const { error: dbError } = await supabase
        .from('case_drafts')
        .update({ is_approved: true, proposed_draft: draft })
        .eq('case_id', jobId);

      if (dbError) throw dbError;

      // Step B: Trigger your outbound mailer mechanism 
      // (This will fire Make to send out the final draft with the hidden tracker tokens)
      const response = await fetch('https://mygreektax.eu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: jobId, final_text: draft }),
      });

      if (!response.ok) throw new Error('Outbound transit routing failed.');
      
      alert('AI draft successfully approved and sent out to user thread!');
    } catch (err: any) {
      console.error('Approval submission failed:', err.message);
      alert('Failed to transmit approved email.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-4 text-center">Loading AI Context Insights...</div>;
  if (!draft) return <div className="p-4 text-gray-500">No active AI drafts pending review for this case file.</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 border rounded-xl bg-[var(--cream)]">
      {/* LEFT PANEL: Technical Tax Notes (Immutable Workspace for Safety) */}
      <Card className="bg-[var(--navy)] text-white border-none shadow-md">
        <CardHeader>
          <CardTitle className="text-[var(--brand)] font-serif text-lg">
            🧠 Brain Technical Compliance Insights
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-relaxed whitespace-pre-wrap font-sans opacity-90">
          {notes || "No operational advisory tokens logged by AI for this sequence."}
        </CardContent>
      </Card>

      {/* RIGHT PANEL: Live Interactive Workspace Panel */}
      <Card className="border border-gray-200 bg-white shadow-md flex flex-col">
        <CardHeader>
          <CardTitle className="text-gray-800 text-lg font-sans">
            ✍️ Editable Outbound Email Draft
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col gap-4">
          <Textarea 
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 min-h-[300px] font-sans text-sm p-3 border border-gray-200 rounded-md focus-visible:ring-[var(--brand)]"
          />
          <Button 
            onClick={handleApproveAndSend}
            disabled={submitting}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-colors"
          >
            {submitting ? 'Transmitting Email...' : '🚀 Approve & Send Outbound'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
