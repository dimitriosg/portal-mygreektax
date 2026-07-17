import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface DraftRow {
  case_id: string;
  proposed_draft: string | null;
  internal_notes: string | null;
  is_approved: boolean | null;
  last_updated: string | null;
}

interface ClientInfo {
  full_name: string | null;
  email: string | null;
}

function preview(text: string | null, max = 150): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export const Route = createFileRoute('/drafts')({
  component: DraftsInbox,
});

function DraftsInbox() {
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [clients, setClients] = useState<Record<string, ClientInfo>>({});
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data } = await supabase
      .from('case_drafts')
      .select('case_id, proposed_draft, internal_notes, is_approved, last_updated')
      .order('last_updated', { ascending: false })
      .limit(100);

    const drafts = (data as DraftRow[] | null) ?? [];
    setRows(drafts);

    // Resolve names: for lead path cases the case_id is the client id itself.
    const ids = drafts.map((r) => r.case_id);
    if (ids.length > 0) {
      const { data: clientRows } = await supabase
        .from('clients')
        .select('id, full_name, email')
        .in('id', ids);
      const map: Record<string, ClientInfo> = {};
      (clientRows ?? []).forEach((c: any) => {
        map[c.id] = { full_name: c.full_name, email: c.email };
      });
      setClients(map);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();

    // Any change to case_drafts refreshes the inbox, so a new Brain draft
    // shows up here the moment it lands.
    const channel = supabase
      .channel('realtime:drafts-inbox')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'case_drafts' },
        () => {
          load();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const pending = rows.filter((r) => !r.is_approved);
  const approved = rows.filter((r) => r.is_approved);

  const labelFor = (r: DraftRow) => {
    const c = clients[r.case_id];
    if (c?.full_name) return c.full_name;
    if (c?.email) return c.email;
    return `Case ${r.case_id.slice(0, 8)}`;
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <header className="border-l-4 border-[#0B192C] pl-4">
        <h1 className="text-2xl font-serif font-semibold text-slate-900">
          AI drafts waiting for review
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {loading
            ? 'Loading drafts...'
            : `${pending.length} waiting, ${approved.length} approved.`}
        </p>
      </header>

      {!loading && pending.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            No drafts waiting. New drafts appear here the moment the Brain
            writes one.
          </CardContent>
        </Card>
      )}

      <section className="space-y-4">
        {pending.map((r) => (
          <Card key={r.case_id} className="border-slate-200 shadow-sm">
            <CardContent className="py-4 flex flex-col md:flex-row md:items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                  <span className="font-medium text-slate-900 truncate">
                    {labelFor(r)}
                  </span>
                  <span className="text-xs text-slate-400 shrink-0">
                    {formatWhen(r.last_updated)}
                  </span>
                </div>
                <p className="text-sm text-slate-600 mt-1">
                  {preview(r.proposed_draft)}
                </p>
              </div>
              <Link to="/review/$caseId" params={{ caseId: r.case_id }}>
                <Button className="bg-[#0B192C] hover:bg-slate-800 text-white shrink-0">
                  Review draft
                </Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </section>

      {approved.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
            Approved
          </h2>
          {approved.map((r) => (
            <Card key={r.case_id} className="border-slate-100 bg-slate-50/60">
              <CardContent className="py-3 flex items-center gap-3">
                <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 shrink-0">
                  Approved
                </span>
                <span className="text-sm text-slate-700 truncate flex-1">
                  {labelFor(r)}
                </span>
                <span className="text-xs text-slate-400 shrink-0">
                  {formatWhen(r.last_updated)}
                </span>
                <Link to="/review/$caseId" params={{ caseId: r.case_id }}>
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs shrink-0"
                  >
                    Open
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}
