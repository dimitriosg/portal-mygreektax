import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { z } from "zod";
import { ArrowLeft, ExternalLink, MoveDown, MoveUp } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { getCaseCorrespondence } from "@/lib/correspondence.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { athensDayLabel, athensFullStamp, athensStamp } from "@/lib/case-thread";
import { stageBadgeClass } from "@/lib/stage-colors";
import {
  byParty,
  filterMessages,
  groupConsecutiveThreads,
  highlightRanges,
  sortByTsAsc,
  type CaseMessageRow,
  type DirectionFilter,
  type MessageFilters,
  type RangeFilter,
  type ThreadBlock,
} from "@/lib/correspondence-shared";

// -----------------------------------------------------------------------------
// /leads/<client_code>/correspondence — the two conversations, side by side.
//
// WHY THE ROUTE FILE IS NAMED leads_. AND NOT leads.
//
// The trailing underscore is TanStack Router's non-nested marker. Without it
// this file registers as a child of src/routes/leads.tsx, which turns that
// 1800-line pipeline page into a layout route: it would need an <Outlet/>, and
// LeadsPage plus its four admin queries would mount above every correspondence
// page. The URL is identical either way — the generator strips the underscore —
// so this costs nothing and keeps /leads a leaf.
//
// WHY FILTER STATE LIVES IN THE URL.
//
// "Show me what I sent him about this case in the last week" is a thing worth
// sending to yourself, and a page whose state evaporates on reload cannot be
// linked. Same searchSchema shape as /admin/reports, including .catch() on
// every field so a hand-edited URL lands on the default view rather than in an
// error boundary.
// -----------------------------------------------------------------------------

const searchSchema = z.object({
  dir: z.enum(["all", "inbound", "outbound"]).optional().catch(undefined),
  range: z.enum(["7", "30", "all"]).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
  // Merge the two columns into one interleaved timeline. This is the view that
  // answers "did I chase him before or after she asked", which is the actual
  // question in most stalled cases.
  merged: z.enum(["1"]).optional().catch(undefined),
});
type CorrespondenceSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/leads_/$clientCode/correspondence")({
  // Typed as Record<string, unknown> rather than letting the schema drive the
  // input type, matching admin.reports.tsx: otherwise the router infers every
  // param as required and a plain <Link> to this route stops compiling.
  validateSearch: (search: Record<string, unknown>): CorrespondenceSearch =>
    searchSchema.parse(search),
  component: CaseCorrespondencePage,
});

const DIRECTIONS: { key: DirectionFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "inbound", label: "Inbound" },
  { key: "outbound", label: "Outbound" },
];

const RANGES: { key: RangeFilter; label: string }[] = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "all", label: "All" },
];

function CaseCorrespondencePage() {
  const { clientCode } = Route.useParams();
  const search = Route.useSearch();
  const { user, loading, sessionReady, isAdmin } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", replace: true });
      return;
    }
    if (!sessionReady) return;
    if (!isAdmin) navigate({ to: "/dashboard", replace: true });
  }, [loading, sessionReady, user, isAdmin, navigate]);

  const fetchCase = useServerFn(getCaseCorrespondence);
  const caseQ = useQuery({
    queryKey: ["correspondence", "case", clientCode],
    queryFn: () => fetchCase({ data: { clientCode } }),
    enabled: !!isAdmin && sessionReady,
  });

  useEffect(() => {
    if (isAuthSessionError(caseQ.error)) navigate({ to: "/login", replace: true });
  }, [caseQ.error, navigate]);

  // Memoised on the three primitive fields rather than on `search`, which is a
  // fresh object every render: without this the filter pass below re-runs on
  // every keystroke elsewhere on the page.
  const filters: MessageFilters = useMemo(
    () => ({
      direction: search.dir ?? "all",
      range: search.range ?? "all",
      query: search.q ?? "",
    }),
    [search.dir, search.range, search.q],
  );
  const merged = search.merged === "1";

  function setSearch(next: Partial<CorrespondenceSearch>) {
    navigate({
      to: "/leads/$clientCode/correspondence",
      params: { clientCode },
      search: { ...search, ...next },
      replace: true,
    });
  }

  const messages = useMemo(() => caseQ.data?.messages ?? [], [caseQ.data]);
  // One instant for the whole filter pass, so a message cannot fall inside the
  // 7-day window in one column and outside it in the other.
  const visible = useMemo(
    () => sortByTsAsc(filterMessages(messages, filters, new Date())),
    [messages, filters],
  );
  const clientMessages = useMemo(() => byParty(visible, "client"), [visible]);
  const partnerMessages = useMemo(() => byParty(visible, "partner"), [visible]);

  const summary = caseQ.data?.summary ?? null;
  const filtersActive =
    filters.direction !== "all" || filters.range !== "all" || filters.query.trim() !== "";

  if (loading || (!!user && !sessionReady)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground">Loading...</div>
    );
  }
  if (!isAdmin) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            to="/leads"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            Back to pipeline
          </Link>
          <h1 className="text-xl font-semibold">
            {summary?.client_name ?? caseQ.data?.messages[0]?.client_name ?? clientCode}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{clientCode}</span>
            {summary?.stage && (
              <span
                className={cn(
                  "inline-flex rounded-md border px-2 py-0.5 text-xs font-medium",
                  stageBadgeClass(summary.stage),
                )}
              >
                {summary.stage}
              </span>
            )}
          </div>
        </div>

        {/* The same six counts as the consolidated table, from the same view, so
            the numbers on the page you came from are still in front of you. */}
        {summary && (
          <div className="flex flex-wrap gap-4 text-sm">
            <CountBlock
              label="You and the client"
              inCount={summary.client_in ?? 0}
              outCount={summary.client_out ?? 0}
              last={summary.client_last}
            />
            <CountBlock
              label="You and Chrysostomos"
              inCount={summary.partner_in ?? 0}
              outCount={summary.partner_out ?? 0}
              last={summary.partner_last}
            />
          </div>
        )}
      </div>

      <Controls
        filters={filters}
        merged={merged}
        onChange={setSearch}
        shown={visible.length}
        total={messages.length}
      />

      {caseQ.isLoading && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Loading correspondence…
          </CardContent>
        </Card>
      )}

      {caseQ.error && !isAuthSessionError(caseQ.error) && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            Could not load this case: {getErrorMessage(caseQ.error)}
          </CardContent>
        </Card>
      )}

      {caseQ.data && messages.length === 0 && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            No email on record for {clientCode}. History starts 31 August 2026 — the Gmail sync
            reads a rolling 7-day window and first ran on 7 September, so anything older is absent
            rather than missing.
          </CardContent>
        </Card>
      )}

      {caseQ.data && messages.length > 0 && (
        <>
          {merged ? (
            <Column
              title="Both conversations, in order"
              subtitle="Each message is labelled with which conversation it belongs to."
              messages={visible}
              query={filters.query}
              showParty
              emptyNote={filtersActive ? "No message matches these filters." : "Nothing to show."}
            />
          ) : (
            <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
              <Column
                title="You and the client"
                subtitle="Gmail previews, not full emails — open the thread for the rest."
                messages={clientMessages}
                query={filters.query}
                emptyNote={
                  filtersActive
                    ? "No client message matches these filters."
                    : "No client email on this case."
                }
              />
              <Column
                title="You and Chrysostomos"
                subtitle="Matched to this case by the CLT code in the subject line."
                messages={partnerMessages}
                query={filters.query}
                emptyNote={
                  filtersActive
                    ? "No partner message matches these filters."
                    : "No partner email on this case. Partner exchanges may have happened on WhatsApp."
                }
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CountBlock({
  label,
  inCount,
  outCount,
  last,
}: {
  label: string;
  inCount: number;
  outCount: number;
  last: string | null;
}) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-3 tabular-nums">
        <span title="Messages received">in {inCount}</span>
        <span title="Messages sent">out {outCount}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {last ? (
          <span title={athensFullStamp(last)}>last {athensStamp(last)}</span>
        ) : (
          "no email on record"
        )}
      </div>
    </div>
  );
}

function Controls({
  filters,
  merged,
  onChange,
  shown,
  total,
}: {
  filters: MessageFilters;
  merged: boolean;
  onChange: (next: Partial<CorrespondenceSearch>) => void;
  shown: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
      <Pills
        label="Direction"
        options={DIRECTIONS}
        value={filters.direction}
        onSelect={(key) => onChange({ dir: key === "all" ? undefined : key })}
      />
      <Pills
        label="Range"
        options={RANGES}
        value={filters.range}
        onSelect={(key) => onChange({ range: key === "all" ? undefined : key })}
      />
      <Input
        placeholder="Search subject and preview…"
        value={filters.query}
        onChange={(e) => onChange({ q: e.target.value || undefined })}
        className="w-full sm:w-56"
        aria-label="Search subject and preview"
      />
      <button
        type="button"
        onClick={() => onChange({ merged: merged ? undefined : "1" })}
        aria-pressed={merged}
        className={cn(
          "rounded-full border px-2.5 py-1 text-xs transition-colors",
          merged
            ? "border-foreground/30 bg-muted font-medium text-foreground"
            : "border-border text-muted-foreground hover:bg-muted/50",
        )}
      >
        Merge chronologically
      </button>
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
        {shown === total ? `${total} messages` : `${shown} of ${total} messages`}
      </span>
    </div>
  );
}

function Pills<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { key: T; label: string }[];
  value: T;
  onSelect: (key: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      {options.map((option) => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onSelect(option.key)}
            aria-pressed={active}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              active
                ? "border-foreground/30 bg-muted font-medium text-foreground"
                : "border-border text-muted-foreground hover:bg-muted/50",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Column({
  title,
  subtitle,
  messages,
  query,
  emptyNote,
  showParty = false,
}: {
  title: string;
  subtitle: string;
  messages: CaseMessageRow[];
  query: string;
  emptyNote: string;
  showParty?: boolean;
}) {
  const blocks = useMemo(() => groupConsecutiveThreads(messages), [messages]);

  return (
    <section className="flex flex-col rounded-lg border border-border">
      <header className="border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </header>
      {/* Each column scrolls on its own, and only once it needs to: the box
          grows with its content up to 70vh and then scrolls. Stretching both to
          the viewport instead would leave a three-message case sitting in a
          screenful of whitespace. items-stretch on the grid keeps the two the
          same height as each other, which is what makes them comparable. */}
      <div className="max-h-[70vh] flex-1 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{emptyNote}</p>
        ) : (
          <ol className="space-y-3">
            {blocks.map((block, i) => (
              <ThreadBlockView
                key={`${block.threadId ?? "none"}-${i}`}
                block={block}
                query={query}
                showParty={showParty}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function ThreadBlockView({
  block,
  query,
  showParty,
}: {
  block: ThreadBlock;
  query: string;
  showParty: boolean;
}) {
  const first = block.messages[0];
  return (
    <li className="rounded-md border border-border/60">
      <div className="flex items-start justify-between gap-2 border-b border-border/60 bg-muted/30 px-2 py-1.5">
        <p className="text-xs font-medium">
          <Highlighted text={block.subject ?? "(no subject)"} query={query} />
        </p>
        {first?.gmail_url && (
          <a
            href={first.gmail_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            title="Open this thread in Gmail"
          >
            Gmail
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </div>
      <div className="divide-y divide-border/60">
        {block.messages.map((m) => (
          <MessageRow
            key={m.message_id ?? `${m.thread_id}-${m.ts}`}
            message={m}
            query={query}
            showParty={showParty}
          />
        ))}
      </div>
    </li>
  );
}

function MessageRow({
  message,
  query,
  showParty,
}: {
  message: CaseMessageRow;
  query: string;
  showParty: boolean;
}) {
  const inbound = message.direction === "Inbound";
  return (
    <article className="px-2 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {/* Direction has to be readable without reading: an arrow and a colour,
            not just the words "Inbound" and "Outbound". */}
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium",
            inbound
              ? "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200"
              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
          )}
          title={inbound ? "Received" : "Sent"}
        >
          {inbound ? (
            <MoveDown className="h-3 w-3" aria-hidden="true" />
          ) : (
            <MoveUp className="h-3 w-3" aria-hidden="true" />
          )}
          {inbound ? "In" : "Out"}
        </span>
        {showParty && (
          <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">
            {message.party === "partner" ? "Chrysostomos" : "Client"}
          </span>
        )}
        <span
          className="text-muted-foreground"
          title={`${athensFullStamp(message.ts)} · ${athensDayLabel(message.ts)}`}
        >
          {athensStamp(message.ts)}
        </span>
        <span
          className="truncate text-muted-foreground"
          title={`${message.from_addr ?? "?"} → ${message.to_addr ?? "?"}`}
        >
          {inbound ? (message.from_addr ?? "?") : (message.to_addr ?? "?")}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/90">
        <Highlighted text={message.snippet ?? ""} query={query} />
      </p>
    </article>
  );
}

/** Renders `text` with every case-insensitive occurrence of `query` marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = useMemo(() => highlightRanges(text, query), [text, query]);
  if (ranges.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([from, to], i) => {
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(
      <mark
        key={`${from}-${i}`}
        className="rounded bg-amber-200 px-0.5 text-inherit dark:bg-amber-700/60"
      >
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
