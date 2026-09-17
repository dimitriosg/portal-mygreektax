import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listCaseProposals,
  openCase,
  type CaseProposal,
  type ClientMissingCase,
} from "@/lib/cases.functions";
import { getErrorMessage } from "@/lib/auth-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { stageBadgeClass } from "@/lib/stage-colors";

export const Route = createFileRoute("/admin/case-proposals")({
  component: CaseProposalsPage,
});

// Case proposals.
//
// Case serials were minted and used with real clients before this database was
// the system of record for them, so codes exist in correspondence, on payment
// tokens and in clients.case_code with no case row behind them.
//
// Every row here is a suggestion. Nothing is created until a person presses
// Create, one case at a time, and creation goes through open_case() exactly as
// "+ New case" on the pipeline does. No migration backfills any of this,
// because a backfill cannot tell two pieces of work from one piece of work that
// was renamed -- and MGT-CS002-CLT0009 is proof the distinction is real.

const SOURCE_LABELS: Record<string, string> = {
  message_subject: "Client email subject",
  payment_token: "Payment link",
  client_case_code: "Legacy case_code field",
};

// Worth saying out loud on the screen: the three sources are not equally good.
const SOURCE_NOTE: Record<string, string> = {
  message_subject: "Strongest — our own serial, sent out by us and quoted back.",
  payment_token: "Set by a person when the payment link was raised.",
  client_case_code: "Free text, no foreign key. A hint, never a truth.",
};

function stageChip(stage: string | null) {
  if (!stage) return null;
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${stageBadgeClass(stage)}`}>
      {stage}
    </span>
  );
}

function CreateCaseRow({
  clientId,
  defaultTitle,
  label,
  onDone,
}: {
  clientId: string;
  defaultTitle?: string;
  label: string;
  onDone: () => void;
}) {
  const createCase = useServerFn(openCase);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(defaultTitle ?? "");

  const mut = useMutation({
    mutationFn: (vars: { clientId: string; title?: string }) => createCase({ data: vars }),
    onSuccess: (result) => {
      toast.success(`Case ${result.caseSerialId ?? "created"} opened`);
      setAdding(false);
      onDone();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (!adding) {
    return (
      <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={title}
        placeholder="What was this case about? (optional)"
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !mut.isPending) {
            e.preventDefault();
            mut.mutate({ clientId, title: title.trim() || undefined });
          }
          if (e.key === "Escape") setAdding(false);
        }}
        className="h-8 w-64 text-xs"
      />
      <Button
        size="sm"
        className="h-8 shrink-0 px-2 text-xs"
        disabled={mut.isPending}
        onClick={() => mut.mutate({ clientId, title: title.trim() || undefined })}
      >
        {mut.isPending ? "Creating…" : "Create"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 shrink-0 px-2 text-xs"
        onClick={() => setAdding(false)}
      >
        Cancel
      </Button>
    </div>
  );
}

function ProposalCard({ p, onDone }: { p: CaseProposal; onDone: () => void }) {
  return (
    <div className="rounded border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-sm font-medium">{p.proposedCaseSerialId}</span>
          <span className="text-xs text-muted-foreground">
            {p.clientCode}
            {p.clientName ? ` · ${p.clientName}` : ""}
          </span>
          {stageChip(p.clientStage)}
        </div>
        <CreateCaseRow
          clientId={p.clientId}
          label={`Create as CS${String(p.nextCaseNumber ?? 1).padStart(3, "0")}`}
          onDone={onDone}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {p.mentions} mention{p.mentions === 1 ? "" : "s"}
        </span>
        <span>
          {p.liveCases} live case{p.liveCases === 1 ? "" : "s"} today
        </span>
        <span>
          {p.clientJobs} job{p.clientJobs === 1 ? "" : "s"}, {p.clientUnfiledJobs} not yet filed
        </span>
      </div>

      <ul className="mt-2 space-y-0.5 text-xs">
        {p.sources.map((s) => (
          <li key={s}>
            <span className="font-medium">{SOURCE_LABELS[s] ?? s}</span>
            <span className="text-muted-foreground"> — {SOURCE_NOTE[s] ?? ""}</span>
          </li>
        ))}
      </ul>

      {/* open_case() mints max(case_number)+1 and cannot be told to reuse a
          serial. Where that differs from the code the client already has in
          writing, say so here rather than let it be discovered afterwards. */}
      {!p.serialWillMatch && (
        <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs">
          Creating this now mints{" "}
          <span className="font-mono">CS{String(p.nextCaseNumber ?? 1).padStart(3, "0")}</span>, not{" "}
          <span className="font-mono">CS{String(p.proposedCaseNumber ?? 0).padStart(3, "0")}</span>.
          Case numbers are allocated in order and cannot be chosen. Create this client's lower
          numbers first if you want the codes to line up with what the client has already seen.
        </p>
      )}
    </div>
  );
}

function MissingRow({ m, onDone }: { m: ClientMissingCase; onDone: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{m.clientCode}</span>
        {m.clientName ? <span className="text-muted-foreground">{m.clientName}</span> : null}
        {stageChip(m.stage)}
        <span className="text-muted-foreground">
          {m.jobs} job{m.jobs === 1 ? "" : "s"} · {m.messages} message
          {m.messages === 1 ? "" : "s"}
        </span>
        {m.hasCodeEvidence ? (
          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            has a code above
          </span>
        ) : null}
      </div>
      <CreateCaseRow clientId={m.clientId} label="Open CS001" onDone={onDone} />
    </div>
  );
}

function CaseProposalsPage() {
  const qc = useQueryClient();
  const fetchProposals = useServerFn(listCaseProposals);

  const q = useQuery({
    queryKey: ["cases", "proposals"],
    queryFn: () => fetchProposals(),
  });

  // Creating a case changes both lists and every cases block on the pipeline.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["cases", "proposals"] });
    void qc.invalidateQueries({ queryKey: ["leads"] });
  };

  const proposals = q.data?.proposals ?? [];
  const missing = q.data?.missing ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Case proposals</h1>
          <p className="text-sm text-muted-foreground">
            Cases that were used with clients but never recorded. Nothing is created until you press
            Create.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/admin">Admin</Link>
        </Button>
      </div>

      {q.isLoading ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : q.error ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            {getErrorMessage(q.error)}
          </CardContent>
        </Card>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Case codes with no case ({proposals.length})
            </h2>
            {proposals.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">
                  Every case code found in correspondence, on a payment link and in the legacy field
                  has a case behind it.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {proposals.map((p) => (
                  <ProposalCard key={p.proposedCaseSerialId} p={p} onDone={refresh} />
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Clients with no case ({missing.length})
            </h2>
            <p className="text-xs text-muted-foreground">
              Parked and Lost clients are excluded — they need not have a case. Everyone here must,
              and most have no code to go on, so there is nothing to propose beyond opening their
              first case.
            </p>
            {missing.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">
                  Every client outside Parked and Lost has a case.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-1.5">
                {missing.map((m) => (
                  <MissingRow key={m.clientId} m={m} onDone={refresh} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
