// Pure helpers for case_draft_versions, the append only record of what the
// Brain wrote and what was actually sent. No React and no Supabase, so vitest
// (node environment) can cover them.

export interface DraftVersionRow {
  id: string;
  version_no: number;
  draft_text: string;
  compliance_insights: string | null;
  context_used: Record<string, unknown> | null;
  model: string | null;
  generated_at: string;
  sent_at: string | null;
  sent_text: string | null;
  sent_mode: string | null;
}

export type SendState = "sent_as_is" | "sent_edited" | "not_sent";

/**
 * Whether a version went out, and whether it was changed before it did.
 *
 * sent_mode is the authority: /webhooks/send-approved computes it in the
 * browser, which is the only place that knows whether the body was touched.
 * A server side comparison of draft_text against sent_text cannot tell, since
 * the desk turns the Brain's plain text into signed HTML before sending, so
 * the two never match even on an untouched send. That bug is what PR #102 and
 * #103 fixed, and re-deriving from the text here would reintroduce it.
 *
 * Only when sent_at exists without a sent_mode (rows stamped before that fix)
 * do the texts get compared at all, and then only to say "as is" when they are
 * genuinely identical.
 */
export function sendState(
  v: Pick<DraftVersionRow, "sent_at" | "sent_mode" | "draft_text" | "sent_text">,
): SendState {
  if (!v.sent_at) return "not_sent";
  if (v.sent_mode === "edited") return "sent_edited";
  if (v.sent_mode === "as_is") return "sent_as_is";
  if (v.sent_text !== null && v.sent_text !== v.draft_text) return "sent_edited";
  return "sent_as_is";
}

/** True when both texts exist and differ, so a side by side view has a point. */
export function hasComparison(v: Pick<DraftVersionRow, "draft_text" | "sent_text">): boolean {
  return typeof v.sent_text === "string" && v.sent_text !== v.draft_text;
}

/**
 * sent_text as the reader received it, rather than as markup.
 *
 * draft_text is the Brain's plain text, but sent_text never is: the desk turns
 * the draft into paragraph HTML and stitches the signature on before posting,
 * and /webhooks/send-approved stores that HTML verbatim. Rendering it beside
 * the draft without this shows the operator angle brackets instead of the
 * email, which defeats the one comparison the panel exists to make.
 *
 * Mirrors htmlToText in /webhooks/send-approved, which turns the same HTML
 * into the plain text part of the outgoing mail, so the two panes are compared
 * on the same footing.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the text carries markup, i.e. it is a stored send rather than a draft. */
export function looksLikeHtml(text: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(text);
}

/**
 * `candidate` when it is strictly later than `reference`, otherwise null.
 *
 * Both come from timestamptz columns but through different queries, so they
 * are parsed rather than string-compared. Anything unparseable is treated as
 * "not later", since claiming a run happened is worse than staying quiet.
 */
export function later(candidate: string | null, reference: string | null): string | null {
  if (!candidate || !reference) return null;
  const a = Date.parse(candidate);
  const b = Date.parse(reference);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return a > b ? candidate : null;
}

/**
 * Human summary of context_used, e.g. "6 messages, 2 notes".
 *
 * Every row in the table carries an empty object today: rows are inserted by
 * the record_case_draft_version() trigger, which copies only the draft text
 * and the insights, so nothing ever populates this column. The reader is
 * written against the keys the Brain would supply and returns an empty string
 * until it does, which is what makes the caller say so plainly rather than
 * printing a line of zeroes.
 */
export function describeContext(ctx: Record<string, unknown> | null): string {
  if (!ctx) return "";
  const num = (k: string): number | null =>
    typeof ctx[k] === "number" ? (ctx[k] as number) : null;
  const parts: string[] = [];

  const client = num("client_messages");
  const partner = num("partner_messages");
  const messages = num("messages");
  const notes = num("notes");
  const knowledge = num("knowledge_entries");

  if (client !== null) parts.push(`${client} client message${client === 1 ? "" : "s"}`);
  if (partner !== null) parts.push(`${partner} partner message${partner === 1 ? "" : "s"}`);
  if (client === null && partner === null && messages !== null) {
    parts.push(`${messages} message${messages === 1 ? "" : "s"}`);
  }
  if (notes !== null) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  if (knowledge !== null) {
    parts.push(`${knowledge} knowledge entr${knowledge === 1 ? "y" : "ies"}`);
  }

  return parts.join(", ");
}

/**
 * The knowledge_base ids a version recorded using, from context_used.
 *
 * Accepts the shapes the Brain could plausibly write: an array of ids under
 * knowledge_ids or knowledge, or an array of objects carrying an id. Returns
 * an empty array for anything else, including the empty object every row
 * holds today, so the Knowledge tab can tell "used nothing" from "recorded
 * nothing".
 */
export function knowledgeIdsFromContext(ctx: Record<string, unknown> | null): string[] {
  if (!ctx) return [];
  const raw = ctx.knowledge_ids ?? ctx.knowledge ?? ctx.knowledge_entries;
  if (!Array.isArray(raw)) return [];

  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      ids.push(entry);
    } else if (entry && typeof entry === "object") {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}
