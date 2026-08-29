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

function isQuoteStart(lines: string[], i: number): boolean {
  const line = lines[i];
  if (line.startsWith(">")) return true;
  if (QUOTE_DIVIDERS.some((d) => d.test(line))) return true;
  if (ATTRIBUTION_OPENERS.test(line)) {
    const horizon = Math.min(i + 3, lines.length);
    for (let j = i; j < horizon; j++) {
      if (ATTRIBUTION_CLOSER.test(lines[j])) return true;
    }
  }
  return false;
}

export function splitQuoted(body: string): QuotedSplit {
  const lines = body.split(/\r\n|\n|\r/);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isQuoteStart(lines, i)) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return { visible: body, quoted: null, quotedLineCount: 0 };
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
