import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown, ChevronUp, HelpCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { athensFullStamp, athensStamp } from "@/lib/case-thread";
import { relativeTime } from "@/lib/relative-time";
import { stageBadgeClass } from "@/lib/stage-colors";
import {
  defaultDirFor,
  groupByStage,
  hasNoPartnerEmail,
  isPartnerStale,
  isPartnerUnanswered,
  sortRows,
  type CorrespondenceRow,
  type CorrespondenceSortKey,
  type SortDir,
  type SyncRunRow,
  type UnmatchedPartnerMessage,
} from "@/lib/correspondence-shared";

// The consolidated correspondence table — the third view on /leads.
//
// One row per case, two conversations side by side: Jim and the client, Jim and
// Chrysostomos. The whole point of the layout is that those two column groups
// must never be mistaken for one another, so they carry a spanning group header
// and a heavier rule between them rather than nine flat columns.

/**
 * A run still on 'running' this long after it started is not in flight, it is
 * stuck: the webhook accepted the request and nothing ever reported back. Two
 * hours is the schedule interval, so anything past it has also been overtaken
 * by the cron.
 */
const STALLED_RUN_MS = 2 * 60 * 60 * 1000;

type Props = {
  rows: CorrespondenceRow[];
  lastRun: SyncRunRow | null;
  refreshConfigured: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  /** Surfaced verbatim: a refresh that failed silently is the bug this page fixes. */
  refreshError: string | null;
  /** Pinned once per render so every row measures staleness against one instant. */
  now: Date;
  /**
   * Partner messages the matching rule could not place on exactly one case.
   * Rendered as a count under the table, and only when it is non-zero.
   *
   * These messages are in the mailbox and in no column above. Leaving that
   * unsaid would make the table quietly wrong in the one direction a reader
   * cannot detect — an absence looks identical to a case with no partner mail.
   */
  unmatched: UnmatchedPartnerMessage[];
};

const CLOSED_STORAGE_KEY = "mgt-leads-correspondence-show-closed";

function loadShowClosed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CLOSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

type Column = {
  key: CorrespondenceSortKey;
  label: string;
  numeric?: boolean;
  /** First column of a group — takes the heavier left rule. */
  groupStart?: boolean;
};

const COLUMNS: Column[] = [
  { key: "case", label: "Case" },
  { key: "client", label: "Client" },
  { key: "stage", label: "Stage" },
  { key: "client_in", label: "In", numeric: true, groupStart: true },
  { key: "client_out", label: "Out", numeric: true },
  { key: "client_last", label: "Last" },
  { key: "partner_in", label: "In", numeric: true, groupStart: true },
  { key: "partner_out", label: "Out", numeric: true },
  { key: "partner_last", label: "Last" },
];

const GROUP_RULE = "border-l-2 border-border";

export function CorrespondenceTable({
  rows,
  lastRun,
  refreshConfigured,
  onRefresh,
  refreshing,
  refreshError,
  now,
  unmatched,
}: Props) {
  const [sort, setSort] = useState<{ key: CorrespondenceSortKey; dir: SortDir }>({
    key: "any_last",
    dir: "desc",
  });
  const [showClosed, setShowClosed] = useState<boolean>(() => loadShowClosed());

  function toggleShowClosed() {
    setShowClosed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(CLOSED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* localStorage unavailable — non-fatal */
      }
      return next;
    });
  }

  function toggleSort(key: CorrespondenceSortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: defaultDirFor(key) },
    );
  }

  const sorted = useMemo(() => sortRows(rows, sort.key, sort.dir), [rows, sort]);
  const openGroups = useMemo(() => groupByStage(sorted, false), [sorted]);
  const closedGroups = useMemo(() => groupByStage(sorted, true), [sorted]);
  const closedCount = useMemo(
    () => closedGroups.reduce((n, g) => n + g.rows.length, 0),
    [closedGroups],
  );

  const visibleGroups = showClosed ? [...openGroups, ...closedGroups] : openGroups;

  return (
    <div className="space-y-3">
      <FreshnessBar
        lastRun={lastRun}
        refreshConfigured={refreshConfigured}
        onRefresh={onRefresh}
        refreshing={refreshing}
        refreshError={refreshError}
        now={now}
      />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/50 text-left">
            {/* The group header is the whole reason this is not nine flat
                columns: "in 0 / out 2" only means something once you know which
                conversation it counts. */}
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 pt-2" colSpan={3} />
              <th className={cn("px-3 pt-2 pb-1", GROUP_RULE)} colSpan={3} scope="colgroup">
                You and the client
              </th>
              <th className={cn("px-3 pt-2 pb-1", GROUP_RULE)} colSpan={3} scope="colgroup">
                You and Chrysostomos
              </th>
            </tr>
            <tr>
              {COLUMNS.map((col) => {
                const active = sort.key === col.key;
                return (
                  <th
                    key={`${col.key}`}
                    scope="col"
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={cn(
                      "px-3 pb-2",
                      col.numeric && "text-right",
                      col.groupStart && GROUP_RULE,
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={cn(
                        "inline-flex items-center gap-0.5 rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        col.numeric && "flex-row-reverse",
                        active && "font-semibold text-foreground",
                      )}
                    >
                      {col.label}
                      {active &&
                        (sort.dir === "asc" ? (
                          <ChevronUp className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="h-3 w-3" aria-hidden="true" />
                        ))}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleGroups.length === 0 && (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No case has any email on record yet.
                </td>
              </tr>
            )}
            {visibleGroups.map((group) => (
              <StageSection key={group.stage} stage={group.stage} rows={group.rows} now={now} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggleShowClosed}
          aria-pressed={showClosed}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          {showClosed
            ? "Hide closed cases"
            : `Show closed cases${closedCount ? ` (${closedCount})` : ""}`}
        </button>
        <p className="text-xs text-muted-foreground">
          Counts come from email only. An em-space in a partner column means no partner email on
          that case — often the exchange happened on WhatsApp.
        </p>
      </div>

      <UnmatchedNote unmatched={unmatched} />
    </div>
  );
}

/**
 * The counts above exclude partner mail that cannot be tied to one case. This
 * says how much, and lets it be opened.
 *
 * Two reasons, and they are not the same problem. `no_case_code` is normal —
 * the ΣΥΝΟΨΗ ΑΝΑΘΕΣΕΩΝ digest covers several cases and belongs to none of them
 * — and only becomes interesting if the number climbs, which would mean the
 * subject convention is lapsing. `ambiguous_code` is a naming collision:
 * CLT0041-XX and CLT0041-SO share a prefix, so a subject saying CLT0041 names
 * two clients and the message is withheld rather than filed against both. That
 * one is fixed in the subject line, not here, so the message is linkable.
 *
 * Renders nothing at zero. A permanent "0 excluded" line is furniture.
 */
function UnmatchedNote({ unmatched }: { unmatched: UnmatchedPartnerMessage[] }) {
  const ambiguous = unmatched.filter((m) => m.reason === "ambiguous_code").length;
  const uncoded = unmatched.length - ambiguous;
  if (unmatched.length === 0) return null;

  // Said in whichever way is true, rather than one sentence with a zero in it.
  // Only the ambiguous ones are a problem to act on, so they carry the weight
  // when both kinds are present.
  const why =
    ambiguous === 0
      ? "none of them names a case in its subject"
      : uncoded === 0
        ? `${ambiguous === 1 ? "it names" : "each names"} more than one client`
        : `${uncoded} with no case code, ${ambiguous} naming more than one client`;

  return (
    <details className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
      <summary className="cursor-pointer list-none text-muted-foreground marker:content-none">
        <span className="inline-flex items-center gap-1.5">
          <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className={cn(ambiguous > 0 && "text-foreground")}>
            {unmatched.length} partner {unmatched.length === 1 ? "message is" : "messages are"} not
            counted above — {why}
          </span>
        </span>
      </summary>
      <ul className="mt-2 space-y-1 border-t border-border pt-2">
        {unmatched.map((m) => (
          <li key={m.message_id ?? `${m.thread_id}-${m.ts}`} className="flex flex-wrap gap-x-2">
            <span className="tabular-nums text-muted-foreground">{athensStamp(m.ts)}</span>
            {m.gmail_url ? (
              <a
                href={m.gmail_url}
                target="_blank"
                rel="noreferrer"
                className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.subject ?? "(no subject)"}
              </a>
            ) : (
              <span>{m.subject ?? "(no subject)"}</span>
            )}
            {m.reason === "ambiguous_code" && (
              <span className="text-amber-600 dark:text-amber-400">
                {m.subject_clt} matches {m.matching_clients ?? 0} client codes
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function StageSection({
  stage,
  rows,
  now,
}: {
  stage: string;
  rows: CorrespondenceRow[];
  now: Date;
}) {
  return (
    <>
      <tr>
        <td colSpan={COLUMNS.length} className="p-0">
          <div
            className={cn(
              "px-3 py-1.5 text-xs font-semibold uppercase",
              stageBadgeClass(stage === "Other" ? null : stage),
            )}
          >
            {stage} · {rows.length}
          </div>
        </td>
      </tr>
      {rows.map((row) => (
        <CaseRow key={row.client_id ?? row.client_code ?? stage} row={row} now={now} />
      ))}
    </>
  );
}

function CaseRow({ row, now }: { row: CorrespondenceRow; now: Date }) {
  const unanswered = isPartnerUnanswered(row);
  const stale = isPartnerStale(row, now);
  const noPartner = hasNoPartnerEmail(row);
  const code = row.client_code ?? "";

  return (
    <tr className="border-t border-border hover:bg-muted/30">
      <td className="px-3 py-2 font-medium">
        {code ? (
          <Link
            to="/leads/$clientCode/correspondence"
            params={{ clientCode: code }}
            className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {code}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {row.client_name ?? <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2">
        <span
          className={cn(
            "inline-flex rounded-md border px-2 py-0.5 text-xs font-medium",
            stageBadgeClass(row.stage),
          )}
        >
          {row.stage ?? "—"}
        </span>
      </td>

      <td className={cn("px-3 py-2 text-right tabular-nums", GROUP_RULE)}>{row.client_in ?? 0}</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.client_out ?? 0}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <Stamp iso={row.client_last} />
      </td>

      {/* Partner group. Two distinct signals share these three cells: nobody has
          replied (unanswered) and nobody has written in a working week (stale).
          A case with no partner email at all is neither — it gets an em-space. */}
      <td
        className={cn(
          "px-3 py-2 text-right tabular-nums",
          GROUP_RULE,
          unanswered && "font-semibold text-amber-700 dark:text-amber-400",
        )}
      >
        {noPartner ? <span className="text-muted-foreground">&emsp;</span> : (row.partner_in ?? 0)}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right tabular-nums",
          unanswered && "font-semibold text-amber-700 dark:text-amber-400",
        )}
      >
        {noPartner ? <span className="text-muted-foreground">&emsp;</span> : (row.partner_out ?? 0)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        {noPartner ? (
          <span className="text-muted-foreground" title="No partner email on this case">
            &emsp;
          </span>
        ) : stale ? (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100"
            title={`${athensFullStamp(row.partner_last)} — over a working week ago on an Active case`}
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {athensStamp(row.partner_last)}
          </span>
        ) : (
          <Stamp iso={row.partner_last} />
        )}
      </td>
    </tr>
  );
}

/** Compact Athens stamp, full Athens stamp on hover. Em-space, never a zero, for absent. */
function Stamp({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground">&emsp;</span>;
  return <span title={athensFullStamp(iso)}>{athensStamp(iso)}</span>;
}

function FreshnessBar({
  lastRun,
  refreshConfigured,
  onRefresh,
  refreshing,
  refreshError,
  now,
}: Pick<
  Props,
  "lastRun" | "refreshConfigured" | "onRefresh" | "refreshing" | "refreshError" | "now"
>) {
  const status = describeRun(lastRun, now);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-sm">
        <span
          className={cn(
            status.tone === "bad" && "text-destructive",
            status.tone === "warn" && "text-amber-700 dark:text-amber-400",
          )}
        >
          {status.headline}
        </span>
        {status.detail && (
          <span className="ml-2 text-xs text-muted-foreground">{status.detail}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {refreshError && <span className="text-xs text-destructive">{refreshError}</span>}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing || !refreshConfigured}
          title={
            refreshConfigured
              ? "Ask n8n to pull the mailbox now"
              : "Manual refresh is not wired up yet — the n8n Gmail sync has no webhook trigger"
          }
        >
          <RefreshCw
            className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")}
            aria-hidden="true"
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </div>
  );
}

type RunStatus = { headline: string; detail?: string; tone: "ok" | "warn" | "bad" };

/**
 * Turn the latest sync_runs row into one honest line.
 *
 * Every branch here exists because the alternative reads as "fine" when it is
 * not: no row at all is "never refreshed", not a blank; a failed run replaces
 * the last success rather than hiding behind it; and a run stuck on 'running'
 * is called stuck rather than shown as in flight forever.
 */
export function describeRun(run: SyncRunRow | null, now: Date): RunStatus {
  if (!run) {
    return {
      headline: "Never refreshed",
      detail: "The Gmail sync has not recorded a run yet.",
      tone: "warn",
    };
  }

  const when = `${relativeTime(run.started_at, now)} · ${athensFullStamp(run.started_at)}`;

  if (run.status === "failed") {
    return {
      headline: `Last refresh failed ${relativeTime(run.finished_at ?? run.started_at, now)}`,
      detail: run.error ?? "No error recorded.",
      tone: "bad",
    };
  }

  if (run.status === "running") {
    const age = now.getTime() - new Date(run.started_at).getTime();
    if (Number.isFinite(age) && age > STALLED_RUN_MS) {
      return {
        headline: `Refresh started ${relativeTime(run.started_at, now)} and never finished`,
        detail: "The sync accepted the run and did not report back.",
        tone: "bad",
      };
    }
    return { headline: "Refreshing now…", detail: when, tone: "warn" };
  }

  return {
    headline: `Last refreshed ${relativeTime(run.finished_at ?? run.started_at, now)}`,
    detail: `${athensFullStamp(run.finished_at ?? run.started_at)} · ${run.rows_written} new ${run.rows_written === 1 ? "message" : "messages"} · ${run.triggered_by}`,
    tone: "ok",
  };
}
