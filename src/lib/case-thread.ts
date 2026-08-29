// Read-time helpers for the case workspace thread. Pure functions with no
// React and no Supabase, so vitest (node environment) can cover them.
//
// Quoted-text detection happens here at render time, never at ingest:
// brain_events.body_text keeps the full email exactly as imported, and the
// thread simply folds the quoted tail behind a toggle.

export interface ThreadEvent {
  id: string;
  event_type: string | null;
  actor: string | null;
  direction: string | null;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  occurred_at: string | null;
}

// A partner message is one whose actor is the partner, or whose event type is
// explicitly a partner email. Everything else belongs to the client thread.
export function isPartnerEvent(e: Pick<ThreadEvent, "actor" | "event_type">): boolean {
  if (e.actor === "partner") return true;
  return e.event_type === "partner_email_received" || e.event_type === "partner_email_sent";
}

// ---------------------------------------------------------------------------
// Quoted-text folding
// ---------------------------------------------------------------------------

export interface QuotedSplit {
  /** The author's own text, with the quoted tail removed. */
  visible: string;
  /** The quoted tail (attribution line included), or null when there is none. */
  quoted: string | null;
  /** Line count of the quoted tail, for the "show quoted text, N lines" label. */
  quotedLineCount: number;
}

// Gmail wraps long attribution lines, so "wrote:" can land one or two lines
// below the "On ..." opener (often already inside the "> " quote prefix).
const ATTRIBUTION_OPENERS = /^(On |Στις )/;
const ATTRIBUTION_CLOSER = /(wrote|έγραψε):\s*$/;
const QUOTE_DIVIDERS = [
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-+ ?(Forwarded message|Προωθημένο μήνυμα) ?-+\s*$/i,
  /^_{6,}\s*$/,
];

// A Gmail-style tail only folds when it really is a quote block: at least this
// share of its lines must be quote-shaped. Inline replies (answers interleaved
// between "> " lines) fall below it and stay fully visible.
const GMAIL_QUOTE_RATIO = 0.9;

function isDividerLine(line: string): boolean {
  return QUOTE_DIVIDERS.some((d) => d.test(line));
}

function isAttributionAt(lines: string[], i: number): boolean {
  if (!ATTRIBUTION_OPENERS.test(lines[i])) return false;
  const horizon = Math.min(i + 3, lines.length);
  for (let j = i; j < horizon; j++) {
    if (ATTRIBUTION_CLOSER.test(lines[j])) return true;
  }
  return false;
}

export function splitQuoted(body: string): QuotedSplit {
  const lines = body.split(/\r\n|\n|\r/);
  const whole: QuotedSplit = { visible: body, quoted: null, quotedLineCount: 0 };

  let start = -1;
  let gmailStyle = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(">")) {
      start = i;
      gmailStyle = true;
      break;
    }
    if (isDividerLine(lines[i])) {
      start = i;
      break;
    }
    if (isAttributionAt(lines, i)) {
      start = i;
      gmailStyle = true;
      break;
    }
  }
  if (start === -1) return whole;

  // A body that begins at a quote marker (a forward, or a reply that is all
  // quote) has no author text of its own: folding would render a blank card,
  // so show everything instead.
  const hasOwnText = lines.slice(0, start).some((l) => l.trim() !== "");
  if (!hasOwnText) return whole;

  const tail = lines.slice(start);
  if (gmailStyle) {
    const quoteShaped = tail.filter(
      (l) =>
        l.startsWith(">") || l.trim() === "" || isDividerLine(l) || ATTRIBUTION_OPENERS.test(l),
    ).length;
    if (quoteShaped / tail.length < GMAIL_QUOTE_RATIO) return whole;
  }

  let end = start;
  while (end > 0 && lines[end - 1].trim() === "") end--;

  return {
    visible: lines.slice(0, end).join("\n"),
    quoted: lines.slice(start).join("\n"),
    quotedLineCount: lines.length - start,
  };
}

// ---------------------------------------------------------------------------
// Athens-time formatting
// ---------------------------------------------------------------------------
// Every timestamp on the thread renders in Europe/Athens regardless of the
// viewer's machine, matching how deadlines and AADE hours are reasoned about.

const ATHENS_TZ = "Europe/Athens";

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ATHENS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayLabelFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: ATHENS_TZ,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const stampFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: ATHENS_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Stable per-day key in Athens time (YYYY-MM-DD), for grouping under dividers. */
export function athensDayKey(iso: string | null): string {
  const d = parse(iso);
  return d ? dayKeyFormat.format(d) : "";
}

/** Divider label, e.g. "Thursday 12 June 2026" (Athens time). */
export function athensDayLabel(iso: string | null): string {
  const d = parse(iso);
  return d ? dayLabelFormat.format(d).replace(/,/g, "") : "";
}

function stampParts(d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of stampFormat.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** Compact card stamp, e.g. "12/06 09:14" (Athens time; year lives on the divider). */
export function athensStamp(iso: string | null): string {
  const d = parse(iso);
  if (!d) return "";
  const p = stampParts(d);
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

/** Full stamp for tooltips, e.g. "12/06/2026 09:14 Athens". */
export function athensFullStamp(iso: string | null): string {
  const d = parse(iso);
  if (!d) return "";
  const p = stampParts(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} Athens`;
}
