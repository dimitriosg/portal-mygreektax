// Row shapes and pure logic behind the Correspondence view on /leads and the
// per-case page at /leads/<client_code>/correspondence.
//
// WHY THE ARITHMETIC LIVES HERE AND NOT IN THE PAGES.
//
// Same reason as src/lib/reports-aggregate.ts: two pages read the same numbers
// and they must not be able to disagree. The consolidated table shows six
// counts per case; the per-case page shows the same six counts in its header
// and then renders the individual messages those counts came from. If "stale"
// or "unanswered" were decided inline in JSX, the table could flag a case that
// the detail page does not. Everything that decides meaning is a pure function
// here, and it is unit-tested in correspondence-shared.test.ts.
//
// Nothing in this file imports React, Supabase or anything server-only: the
// server functions in correspondence.functions.ts import the types from here,
// and so do the components.

/** One row of public.v_case_correspondence — one case, six counts, three dates. */
export type CorrespondenceRow = {
  client_id: string | null;
  client_code: string | null;
  client_name: string | null;
  stage: string | null;
  client_in: number | null;
  client_out: number | null;
  client_last: string | null;
  partner_in: number | null;
  partner_out: number | null;
  partner_last: string | null;
  any_last: string | null;
};

/** One row of public.v_case_messages — one Gmail message, resolved to a case. */
export type CaseMessageRow = {
  message_id: string | null;
  thread_id: string | null;
  party: string | null;
  direction: string | null;
  ts: string | null;
  subject: string | null;
  snippet: string | null;
  from_addr: string | null;
  to_addr: string | null;
  client_id: string | null;
  client_code: string | null;
  client_name: string | null;
  stage: string | null;
  gmail_url: string | null;
};

/** The latest public.sync_runs row for one source, or null if none has ever run. */
export type SyncRunRow = {
  id: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  rows_written: number;
  error: string | null;
  triggered_by: string;
};

// ---------------------------------------------------------------------------
// Stage grouping
// ---------------------------------------------------------------------------

/**
 * The three stages the consolidated table shows expanded, in this order.
 *
 * Deliberately not CLIENT_STAGES from leads-shared: that array is a display
 * order for the whole pipeline and its own comment warns against reading it as
 * a ranking. This is a different, smaller question — which cases are live
 * enough that an unanswered partner thread matters today.
 */
export const OPEN_CORRESPONDENCE_STAGES = ["Active", "Quoted", "Potential"] as const;

/**
 * Everything else, collapsed behind "Show closed cases".
 *
 * Delivered sits here rather than with the open three. The work is done on a
 * Delivered case and the correspondence that remains is usually about payment,
 * so it does not belong in the same glance as "who owes me a reply". An unknown
 * or null stage lands here too, under "Other", rather than vanishing.
 */
export const CLOSED_CORRESPONDENCE_STAGES = ["Delivered", "Parked", "Complete", "Lost"] as const;

export function isOpenStage(stage: string | null | undefined): boolean {
  return (OPEN_CORRESPONDENCE_STAGES as readonly string[]).includes(stage ?? "");
}

export type StageGroup = { stage: string; rows: CorrespondenceRow[] };

/**
 * Bucket rows into stage groups in display order, dropping empty buckets.
 *
 * `closed` selects which half you get. Rows whose stage matches nothing known
 * are collected under "Other" at the end of the closed half — a case cannot
 * fall out of this table just because someone typed a new stage name.
 */
export function groupByStage(rows: CorrespondenceRow[], closed: boolean): StageGroup[] {
  const order: string[] = closed
    ? [...CLOSED_CORRESPONDENCE_STAGES]
    : [...OPEN_CORRESPONDENCE_STAGES];

  const buckets = new Map<string, CorrespondenceRow[]>(order.map((stage) => [stage, []]));
  const other: CorrespondenceRow[] = [];

  for (const row of rows) {
    const stage = row.stage ?? "";
    const bucket = buckets.get(stage);
    if (bucket) {
      bucket.push(row);
    } else if (closed && !isOpenStage(stage)) {
      // Unknown or null stage. It goes to the closed half so that it appears
      // exactly once across the two calls, and under "Other" so that a stage
      // nobody has heard of is visible rather than silently dropped.
      other.push(row);
    }
  }

  const groups: StageGroup[] = order.map((stage) => ({ stage, rows: buckets.get(stage) ?? [] }));
  if (other.length > 0) groups.push({ stage: "Other", rows: other });
  return groups.filter((g) => g.rows.length > 0);
}

// ---------------------------------------------------------------------------
// The two signals the table exists to surface
// ---------------------------------------------------------------------------

/**
 * Jim has written to the partner about this case and the partner has not
 * written back. `in 0 / out 2` is the shape; it is the single most useful thing
 * on the page, so it is a named predicate rather than an inline comparison.
 */
export function isPartnerUnanswered(row: CorrespondenceRow): boolean {
  return (row.partner_in ?? 0) === 0 && (row.partner_out ?? 0) > 0;
}

/** No partner email on this case at all — absence of data, not a count of zero. */
export function hasNoPartnerEmail(row: CorrespondenceRow): boolean {
  return (row.partner_in ?? 0) === 0 && (row.partner_out ?? 0) === 0 && !row.partner_last;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole working days (Mon–Fri) strictly between two instants, counted in UTC.
 *
 * Counting in UTC rather than Athens is a deliberate simplification: the
 * threshold this feeds is "about a working week", and a case cannot cross the
 * five-day line because of a two-hour offset — it would have to be within two
 * hours of a Saturday boundary AND exactly on the threshold. Greek public
 * holidays are not modelled either, for the same reason: this drives a colour,
 * not a deadline.
 *
 * Returns 0 for a future or unparseable date rather than a negative count, so a
 * clock skew cannot make a case look stale.
 */
export function workingDaysBetween(fromIso: string | null | undefined, now: Date): number {
  if (!fromIso) return 0;
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return 0;
  const to = now.getTime();
  if (to <= from) return 0;

  // Walk whole calendar days from the day after `from` up to and including the
  // day of `to`, counting weekdays. At this range (days, not years) the loop is
  // cheaper and more obviously correct than the closed-form weekday formula.
  const startDay = Math.floor(from / DAY_MS);
  const endDay = Math.floor(to / DAY_MS);
  let count = 0;
  for (let day = startDay + 1; day <= endDay; day += 1) {
    // 1970-01-01 was a Thursday, so day 0 is weekday index 4 in a Sun=0 scheme.
    const weekday = (day + 4) % 7;
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/** The threshold the spec sets for "the partner has gone quiet on a live case". */
export const PARTNER_STALE_WORKING_DAYS = 5;

/**
 * An Active case whose last partner message is more than five working days old.
 *
 * Only Active: a Quoted or Potential case has no partner work assigned yet, so
 * partner silence there is expected and colouring it would train the eye to
 * ignore the colour. A case with no partner email at all is not stale either —
 * that is hasNoPartnerEmail, and it renders as an em-space.
 */
export function isPartnerStale(row: CorrespondenceRow, now: Date): boolean {
  if (row.stage !== "Active") return false;
  if (!row.partner_last) return false;
  return workingDaysBetween(row.partner_last, now) > PARTNER_STALE_WORKING_DAYS;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type CorrespondenceSortKey =
  | "case"
  | "client"
  | "stage"
  | "client_in"
  | "client_out"
  | "client_last"
  | "partner_in"
  | "partner_out"
  | "partner_last"
  | "any_last";

export type SortDir = "asc" | "desc";

function sortValue(row: CorrespondenceRow, key: CorrespondenceSortKey): string | number | null {
  switch (key) {
    case "case":
      return row.client_code;
    case "client":
      return row.client_name;
    case "stage":
      return row.stage;
    case "client_in":
      return row.client_in ?? 0;
    case "client_out":
      return row.client_out ?? 0;
    case "partner_in":
      return row.partner_in ?? 0;
    case "partner_out":
      return row.partner_out ?? 0;
    case "client_last":
    case "partner_last":
    case "any_last": {
      const raw = row[key];
      if (!raw) return null;
      const t = new Date(raw).getTime();
      return Number.isFinite(t) ? t : null;
    }
  }
}

/**
 * Compare two rows on one column. Nulls sort last in both directions, so
 * flipping the arrow never buries the rows that have data under the rows that
 * do not — the same rule tab-pipeline.tsx uses.
 */
export function compareRows(
  a: CorrespondenceRow,
  b: CorrespondenceRow,
  key: CorrespondenceSortKey,
  dir: SortDir,
): number {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  const sign = dir === "asc" ? 1 : -1;
  if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
  // numeric:true so CLT0009 sorts before CLT0010 rather than after it.
  return (
    String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * sign
  );
}

export function sortRows(
  rows: CorrespondenceRow[],
  key: CorrespondenceSortKey,
  dir: SortDir,
): CorrespondenceRow[] {
  return [...rows].sort((a, b) => compareRows(a, b, key, dir));
}

/** Counts and dates start descending (biggest/newest first); text starts A–Z. */
export function defaultDirFor(key: CorrespondenceSortKey): SortDir {
  return key === "case" || key === "client" || key === "stage" ? "asc" : "desc";
}

// ---------------------------------------------------------------------------
// Message filtering, for the per-case page
// ---------------------------------------------------------------------------

export type DirectionFilter = "all" | "inbound" | "outbound";
export type RangeFilter = "7" | "30" | "all";

export type MessageFilters = {
  direction: DirectionFilter;
  range: RangeFilter;
  query: string;
};

/** Days back for each quick range, or null for "everything on record". */
export function rangeDays(range: RangeFilter): number | null {
  if (range === "7") return 7;
  if (range === "30") return 30;
  return null;
}

/**
 * Apply direction, date range and free-text search to a message list.
 *
 * The search is over subject and snippet only, and the UI says so: `snippet` is
 * the Gmail preview, not the email, so a match here means "these ~300
 * characters contain the term", never "this email contains the term".
 *
 * A message with a null ts is kept by the date filter rather than dropped. It
 * cannot happen with today's data (every row has one) but silently hiding a
 * message would be the worse failure of the two.
 */
export function filterMessages(
  messages: CaseMessageRow[],
  filters: MessageFilters,
  now: Date,
): CaseMessageRow[] {
  const days = rangeDays(filters.range);
  const cutoff = days == null ? null : now.getTime() - days * DAY_MS;
  const needle = filters.query.trim().toLowerCase();

  return messages.filter((m) => {
    if (filters.direction !== "all") {
      const want = filters.direction === "inbound" ? "Inbound" : "Outbound";
      if (m.direction !== want) return false;
    }
    if (cutoff != null && m.ts) {
      const t = new Date(m.ts).getTime();
      if (Number.isFinite(t) && t < cutoff) return false;
    }
    if (needle) {
      const hay = `${m.subject ?? ""}\n${m.snippet ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** Oldest first, the reading order of a conversation. Nulls last. */
export function sortByTsAsc(messages: CaseMessageRow[]): CaseMessageRow[] {
  return [...messages].sort((a, b) => {
    const at = a.ts ? new Date(a.ts).getTime() : NaN;
    const bt = b.ts ? new Date(b.ts).getTime() : NaN;
    const aok = Number.isFinite(at);
    const bok = Number.isFinite(bt);
    if (!aok && !bok) return 0;
    if (!aok) return 1;
    if (!bok) return -1;
    return at - bt;
  });
}

export function byParty(messages: CaseMessageRow[], party: "client" | "partner"): CaseMessageRow[] {
  return messages.filter((m) => m.party === party);
}

/**
 * Consecutive messages sharing a thread_id, so the subject line can be printed
 * once per run rather than on every message.
 *
 * Consecutive, not grouped-by-thread: the order is chronological and must stay
 * that way. Two runs of the same thread separated by a message from another
 * thread are two blocks, because collapsing them would move messages in time.
 */
export type ThreadBlock = {
  threadId: string | null;
  subject: string | null;
  messages: CaseMessageRow[];
};

export function groupConsecutiveThreads(messages: CaseMessageRow[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  for (const m of messages) {
    const last = blocks[blocks.length - 1];
    if (last && last.threadId != null && last.threadId === m.thread_id) {
      last.messages.push(m);
      continue;
    }
    blocks.push({ threadId: m.thread_id, subject: m.subject, messages: [m] });
  }
  return blocks;
}

/**
 * Highlight ranges for a search term inside one string.
 *
 * Returned as offsets rather than markup so the caller decides the element and
 * the class, and so this stays testable without a DOM. Case-insensitive,
 * non-overlapping, left to right.
 */
export function highlightRanges(text: string, needle: string): Array<[number, number]> {
  const term = needle.trim();
  if (!term) return [];
  const hay = text.toLowerCase();
  const term_ = term.toLowerCase();
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(term_, from);
    if (at === -1) break;
    out.push([at, at + term_.length]);
    from = at + term_.length;
  }
  return out;
}
