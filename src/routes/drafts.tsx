import { useEffect, useState, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { stageBadgeClass } from "@/lib/stage-colors";

// Case workspace. Lists cases from brain_conversations with an on-demand
// Generate flow (on the case page). Supports archive (restorable, auto-purged
// after 60 days), restore, and permanent delete (type DELETE to confirm).
//
// "New case" creates a case from an email via /webhooks/case-create, which
// routes through resolve_case_for_inbound: a new email creates the lead + case,
// an existing lead reuses that lead and just opens the case (no duplicate
// client). New leads added in /leads also appear here automatically, via the
// clients insert trigger.

interface CaseRow {
  id: string;
  case_serial_id: string | null;
  customer_email: string | null;
  stage: string | null;
  status: string | null;
  created_at: string | null;
  client_id: string | null;
  archived_at: string | null;
}

interface ClientInfo {
  full_name: string | null;
  email: string | null;
  client_code: string | null;
  stage: string | null;
}

interface DraftInfo {
  proposed_draft: string | null;
  is_approved: boolean | null;
  last_updated: string | null;
}

function preview(text: string | null, max = 150): string {
  if (!text) return "";
  const flat = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

// Stages that count as closed for the open/closed split on this page. Parked is
// treated as closed-ish (the lead is dormant), alongside Complete and Lost.
const OPEN_STAGES_EXCLUDED = ["Complete", "Lost", "Parked"];

export const Route = createFileRoute("/drafts")({
  component: CaseWorkspace,
});

function CaseWorkspace() {
  const navigate = useNavigate();
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [clients, setClients] = useState<Record<string, ClientInfo>>({});
  const [drafts, setDrafts] = useState<Record<string, DraftInfo>>({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"active" | "archived">("active");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<CaseRow | null>(null);
  const [confirmText, setConfirmText] = useState("");

  // New-case dialog state.
  const [newCaseOpen, setNewCaseOpen] = useState(false);
  const [newCaseName, setNewCaseName] = useState("");
  const [newCaseEmail, setNewCaseEmail] = useState("");
  const [creatingCase, setCreatingCase] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: caseData } = await supabase
      .from("brain_conversations")
      .select(
        "id, case_serial_id, customer_email, stage, status, created_at, client_id, archived_at",
      )
      .order("created_at", { ascending: false })
      .limit(300);

    const rows = (caseData as CaseRow[] | null) ?? [];
    setCases(rows);

    const clientIds = Array.from(
      new Set(rows.map((r) => r.client_id).filter((v): v is string => !!v)),
    );
    if (clientIds.length > 0) {
      const { data: clientRows } = await supabase
        .from("clients")
        .select("id, full_name, email, client_code, stage")
        .in("id", clientIds);
      const cmap: Record<string, ClientInfo> = {};
      (clientRows ?? []).forEach((c: any) => {
        cmap[c.id] = {
          full_name: c.full_name,
          email: c.email,
          client_code: c.client_code,
          stage: c.stage,
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

  const callAction = async (row: CaseRow, action: "archive" | "restore" | "delete") => {
    setErrors((e) => ({ ...e, [row.id]: "" }));
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/webhooks/case-action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          action,
          conversation_id: row.id,
          ...(action === "delete" ? { confirm: "DELETE" } : {}),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail =
          typeof payload?.detail === "string" ? payload.detail : payload?.error ?? `HTTP ${res.status}`;
        setErrors((e) => ({ ...e, [row.id]: `Action failed: ${detail}` }));
      } else {
        await load();
      }
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [row.id]: `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setBusy((b) => ({ ...b, [row.id]: false }));
      if (action === "delete") {
        setConfirmDelete(null);
        setConfirmText("");
      }
    }
  };

  const handleCreateCase = async () => {
    const email = newCaseEmail.trim();
    if (!email) {
      setCreateErr("Enter an email.");
      return;
    }
    setCreateErr(null);
    setCreatingCase(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/webhooks/case-create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ email, name: newCaseName.trim() || undefined }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.ok) {
        const detail =
          typeof payload?.detail === "string"
            ? payload.detail
            : payload?.error ?? `HTTP ${res.status}`;
        setCreateErr(`Could not create the case: ${detail}`);
        return;
      }
      setNewCaseOpen(false);
      setNewCaseName("");
      setNewCaseEmail("");
      if (payload.conversationId) {
        navigate({ to: "/review/$caseId", params: { caseId: payload.conversationId } });
      } else {
        await load();
      }
    } catch (err) {
      setCreateErr(
        `Could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCreatingCase(false);
    }
  };

  const nameFor = (row: CaseRow): string => {
    const c = row.client_id ? clients[row.client_id] : undefined;
    return c?.full_name || c?.email || row.customer_email || "Unknown sender";
  };
  const emailFor = (row: CaseRow): string => {
    const c = row.client_id ? clients[row.client_id] : undefined;
    return c?.email || row.customer_email || "";
  };
  // The pipeline stage lives on the linked lead (clients.stage), which /leads
  // and the case page both edit. Fall back to the case's own stage only if a
  // case has no linked client (legacy rows).
  const stageFor = (row: CaseRow): string => {
    const c = row.client_id ? clients[row.client_id] : undefined;
    return c?.stage || row.stage || "Potential";
  };

  const activeCases = cases.filter((c) => !c.archived_at);
  const archivedCases = cases.filter((c) => !!c.archived_at);
  const shown = view === "active" ? activeCases : archivedCases;

  const openCases = shown.filter((c) => !OPEN_STAGES_EXCLUDED.includes(stageFor(c)));
  const closedCases = shown.filter((c) => OPEN_STAGES_EXCLUDED.includes(stageFor(c)));

  const daysLeft = (archivedAt: string | null): number | null => {
    if (!archivedAt) return null;
    const purge = new Date(archivedAt).getTime() + 60 * 24 * 60 * 60 * 1000;
    return Math.max(0, Math.ceil((purge - Date.now()) / (24 * 60 * 60 * 1000)));
  };

  const renderCard = (row: CaseRow) => {
    const draft = drafts[row.id];
    const isBusy = busy[row.id];
    const err = errors[row.id];
    const hasDraft = !!draft?.proposed_draft;
    const archived = !!row.archived_at;

    return (
      <Card key={row.id} className="border-slate-200 shadow-sm">
        <CardContent className="py-4 flex flex-col gap-3">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    hasDraft ? (draft?.is_approved ? "bg-emerald-500" : "bg-amber-500") : "bg-slate-300"
                  }`}
                />
                <span className="font-medium text-slate-900 truncate">{nameFor(row)}</span>
                {row.case_serial_id && (
                  <span className="text-xs font-mono text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">
                    {row.case_serial_id}
                  </span>
                )}
                <span
                  className={`text-xs font-medium rounded px-1.5 py-0.5 border ${stageBadgeClass(stageFor(row))}`}
                >
                  {stageFor(row)}
                </span>
                {archived && (
                  <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                    Archived · {daysLeft(row.archived_at)}d left
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-1 truncate">{emailFor(row)}</div>
              {hasDraft && <p className="text-sm text-slate-600 mt-1">{preview(draft?.proposed_draft)}</p>}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {!archived && (
                <Link to="/review/$caseId" params={{ caseId: row.id }}>
                  <Button className="bg-[#0B192C] hover:bg-slate-800 text-white">
                    {hasDraft ? "Review draft" : "Open case"}
                  </Button>
                </Link>
              )}
              {archived ? (
                <Button
                  variant="outline"
                  onClick={() => callAction(row, "restore")}
                  disabled={isBusy}
                  className="h-9 px-3 text-xs"
                >
                  {isBusy ? "..." : "Restore"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => callAction(row, "archive")}
                  disabled={isBusy}
                  className="h-9 px-3 text-xs"
                  title="Archive: hidden from Active, restorable, auto-deleted after 60 days"
                >
                  {isBusy ? "..." : "Archive"}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  setConfirmText("");
                  setConfirmDelete(row);
                }}
                disabled={isBusy}
                className="h-9 px-3 text-xs text-red-600 border-red-200 hover:bg-red-50"
                title="Delete permanently"
              >
                Delete
              </Button>
            </div>
          </div>
          {err && (
            <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">{err}</p>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <header className="border-l-4 border-[#0B192C] pl-4">
        <h1 className="text-2xl font-serif font-semibold text-slate-900">Case workspace</h1>
        <p className="text-sm text-slate-500 mt-1">
          {loading
            ? "Loading cases..."
            : view === "active"
              ? `${activeCases.length} active. Click Open to read and draft.`
              : `${archivedCases.length} archived. Restored anytime, or auto-deleted 60 days after archiving.`}
        </p>
      </header>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant={view === "active" ? "default" : "outline"}
            onClick={() => setView("active")}
            className={`h-8 px-3 text-xs ${view === "active" ? "bg-[#0B192C] text-white" : ""}`}
          >
            Active ({activeCases.length})
          </Button>
          <Button
            variant={view === "archived" ? "default" : "outline"}
            onClick={() => setView("archived")}
            className={`h-8 px-3 text-xs ${view === "archived" ? "bg-[#0B192C] text-white" : ""}`}
          >
            Archived ({archivedCases.length})
          </Button>
        </div>
        <Button
          onClick={() => {
            setCreateErr(null);
            setNewCaseName("");
            setNewCaseEmail("");
            setNewCaseOpen(true);
          }}
          className="h-8 px-3 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          + New case
        </Button>
      </div>

      {!loading && shown.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            {view === "active"
              ? "No active cases. New leads appear here automatically."
              : "No archived cases."}
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

      {/* New-case dialog */}
      {newCaseOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold text-slate-900">New case</h3>
            <p className="text-sm text-slate-600">
              Creates a case from an email. If the email is already a lead, it reuses that lead and
              just opens the case. If it is new, it creates the lead too. No duplicates.
            </p>
            <div>
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Name</label>
              <input
                value={newCaseName}
                onChange={(e) => setNewCaseName(e.target.value)}
                placeholder="Optional"
                className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Email</label>
              <input
                autoFocus
                type="email"
                value={newCaseEmail}
                onChange={(e) => setNewCaseEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newCaseEmail.trim() && !creatingCase) handleCreateCase();
                }}
                placeholder="name@example.com"
                className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
              />
            </div>
            {createErr && <p className="text-sm text-red-600">{createErr}</p>}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setNewCaseOpen(false);
                  setCreateErr(null);
                }}
                className="h-9 px-4 text-sm"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateCase}
                disabled={creatingCase || !newCaseEmail.trim()}
                className="h-9 px-4 text-sm bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
              >
                {creatingCase ? "Creating..." : "Create case"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Permanent-delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold text-slate-900">Delete this case permanently?</h3>
            <p className="text-sm text-slate-600">
              This removes the case{" "}
              <span className="font-mono text-slate-800">{confirmDelete.case_serial_id}</span>, its
              conversation, and its draft from the database. This cannot be undone. The customer
              record is not affected.
            </p>
            <p className="text-sm text-slate-600">
              Type <span className="font-mono font-semibold">DELETE</span> to confirm:
            </p>
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              placeholder="DELETE"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setConfirmDelete(null);
                  setConfirmText("");
                }}
                className="h-9 px-4 text-sm"
              >
                Cancel
              </Button>
              <Button
                onClick={() => callAction(confirmDelete, "delete")}
                disabled={confirmText !== "DELETE" || busy[confirmDelete.id]}
                className="h-9 px-4 text-sm bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              >
                {busy[confirmDelete.id] ? "Deleting..." : "Delete permanently"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
