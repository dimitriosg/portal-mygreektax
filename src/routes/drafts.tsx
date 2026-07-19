import { useEffect, useState, useCallback } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// The case workspace. This replaces the old passive drafts inbox that read
// case_drafts (the retired spine). It lists CASES from brain_conversations,
// most of which have no draft yet, and lets Jim generate one on demand. The
// Brain runs only when the Generate button is clicked, never automatically.

interface CaseRow {
  id: string; // conversation id
  case_serial_id: string | null;
  customer_email: string | null;
  stage: string | null;
  status: string | null;
  created_at: string | null;
  client_id: string | null;
}

interface ClientInfo {
  full_name: string | null;
  email: string | null;
  client_code: string | null;
}

interface DraftInfo {
  proposed_draft: string | null;
  is_approved: boolean | null;
  last_updated: string | null;
}

function preview(text: string | null, max = 150): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

const OPEN_STAGES_EXCLUDED = ["Complete", "Lost"];

export const Route = createFileRoute("/drafts")({
  component: CaseWorkspace,
});

function CaseWorkspace() {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [clients, setClients] = useState<Record<string, ClientInfo>>({});
  const [drafts, setDrafts] = useState<Record<string, DraftInfo>>({});
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const { data: caseData } = await supabase
      .from("brain_conversations")
      .select("id, case_serial_id, customer_email, stage, status, created_at, client_id")
      .order("created_at", { ascending: false })
      .limit(200);

    const rows = (caseData as CaseRow[] | null) ?? [];
    setCases(rows);

    const clientIds = Array.from(
      new Set(rows.map((r) => r.client_id).filter((v): v is string => !!v)),
    );
    if (clientIds.length > 0) {
      const { data: clientRows } = await supabase
        .from("clients")
        .select("id, full_name, email, client_code")
        .in("id", clientIds);
      const cmap: Record<string, ClientInfo> = {};
      (clientRows ?? []).forEach((c: any) => {
        cmap[c.id] = {
          full_name: c.full_name,
          email: c.email,
          client_code: c.client_code,
        };
      });
      setClients(cmap);
    }

    const convIds = rows.map((r) => r.id);
    if (convIds.length > 0) {
      const { data: draftRows } = await supabase
        .from("case_drafts")
        .select("case_id, proposed_draft, is_approved, last_updated")
        .in("case_id", convIds);
      const dmap: Record<string, DraftInfo> = {};
      (draftRows ?? []).forEach((d: any) => {
        dmap[d.case_id] = {
          proposed_draft: d.proposed_draft,
          is_approved: d.is_approved,
          last_updated: d.last_updated,
        };
      });
      setDrafts(dmap);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    load();

    const channel = supabase
      .channel("realtime:case-workspace")
      .on("postgres_changes", { event: "*", schema: "public", table: "case_drafts" }, () => load())
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "brain_conversations" },
        () => load(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  const nameFor = (row: CaseRow): string => {
    const c = row.client_id ? clients[row.client_id] : undefined;
    return c?.full_name || c?.email || row.customer_email || "Unknown sender";
  };

  const emailFor = (row: CaseRow): string => {
    const c = row.client_id ? clients[row.client_id] : undefined;
    return c?.email || row.customer_email || "";
  };

  const openCases = cases.filter((c) => !OPEN_STAGES_EXCLUDED.includes(c.stage ?? "Potential"));
  const closedCases = cases.filter((c) => OPEN_STAGES_EXCLUDED.includes(c.stage ?? ""));

  const renderCard = (row: CaseRow) => {
    const draft = drafts[row.id];
    const hasDraft = !!draft?.proposed_draft;

    return (
      <Card key={row.id} className="border-slate-200 shadow-sm">
        <CardContent className="py-4 flex flex-col gap-3">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    hasDraft
                      ? draft?.is_approved
                        ? "bg-emerald-500"
                        : "bg-amber-500"
                      : "bg-slate-300"
                  }`}
                />
                <span className="font-medium text-slate-900 truncate">{nameFor(row)}</span>
                {row.case_serial_id && (
                  <span className="text-xs font-mono text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">
                    {row.case_serial_id}
                  </span>
                )}
                {row.stage && <span className="text-xs text-slate-400">{row.stage}</span>}
              </div>
              <div className="text-xs text-slate-500 mt-1 truncate">{emailFor(row)}</div>
              {hasDraft && (
                <p className="text-sm text-slate-600 mt-1">{preview(draft?.proposed_draft)}</p>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Link to="/review/$caseId" params={{ caseId: row.id }}>
                <Button className="bg-[#0B192C] hover:bg-slate-800 text-white">
                  {hasDraft ? "Review draft" : "Open case"}
                </Button>
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <header className="border-l-4 border-[#0B192C] pl-4">
        <h1 className="text-2xl font-serif font-semibold text-slate-900">Case workspace</h1>
        <p className="text-sm text-slate-500 mt-1">
          {loading
            ? "Loading cases..."
            : `${openCases.length} open, ${closedCases.length} closed. Click Generate to draft a reply on demand.`}
        </p>
      </header>

      {!loading && openCases.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            No open cases. New leads appear here automatically; drafting happens when you click
            Generate.
          </CardContent>
        </Card>
      )}

      <section className="space-y-4">{openCases.map(renderCard)}</section>

      {closedCases.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">Closed</h2>
          {closedCases.map(renderCard)}
        </section>
      )}
    </div>
  );
}
