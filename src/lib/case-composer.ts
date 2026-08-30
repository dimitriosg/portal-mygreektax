// The rules the composer enforces, as pure functions. No React and no
// Supabase, so vitest (node environment) covers them.
//
// Two rules bind what may be sent from the case desk:
//
// R2, the pricing firewall. Text addressed to a partner must never carry a
// retail price, a margin, or a client fee total. The rule as written says to
// scan every currency figure in a partner draft and confirm each one is a
// wholesale figure or one the partner proposed, so that is what this does: it
// finds the figures and the operator confirms them. Nothing here can tell a
// wholesale 120 from a retail 120, and pretending otherwise would be worse
// than asking. Words that can only mean retail (margin, markup, our price)
// are a different matter and block outright.
//
// R7, the deposit gate. While a case has not cleared the deposit, no document
// checklist, methodology or locked figure goes to the client, and no ανάθεση
// or scoping request goes to the partner. Scope clarification, the questions
// needed to unlock the quote, and payment logistics are all still fine.

export type ComposerTarget = "client" | "partner";

/**
 * The words of an HTML body, as the reader will see them.
 *
 * Block ends become newlines and every other tag is removed WITHOUT putting a
 * space in its place. That distinction is the whole point: replacing every tag
 * with a space turns "check<strong>list</strong>" into "check list", which
 * reads past a rule that is looking for "checklist" while the email still
 * renders the word. Bolding half a word would have been enough to walk a
 * gated term through the gate.
 *
 * Same shape as htmlToText in /webhooks/send-approved, which builds the plain
 * text part of the outgoing mail, so the rules are applied to the same reading
 * of the body that is actually sent.
 */
export function visibleText(html: string): string {
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
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Reaching one of these requires the deposit: updateLead refuses a manual
// Quoted -> Active move without a recorded deposit, and the job sync only
// writes Active for a case that has a real job on it.
const STAGES_PAST_THE_GATE = new Set(["Active", "Delivered", "Complete"]);

// Stages that have not cleared it. Parked and Lost are in this list on
// purpose: they are side states reachable from anywhere, including Quoted, so
// a lead that was quoted and went quiet is parked without ever having paid.
// They are also why this is a set and not a comparison against
// getClientStageSortOrder: CLIENT_STAGES is a display order, in which Parked
// and Lost sort after Active, and reading it as a progression switched the
// gate off for exactly the cases that most need it.
const STAGES_BEFORE_THE_GATE = new Set(["Potential", "Quoted", "Parked", "Lost"]);

/**
 * Whether the deposit gate (R7) is still shut on this case.
 *
 * `depositRecorded` is clients.deposit > 0, which is what the portal already
 * treats as the deposit being confirmed: confirm_payment writes it and the
 * Quoted -> Active move checks it. It settles the question on its own, so a
 * case that paid and was later parked is not gated.
 *
 * An unknown or missing stage is not evidence of an unpaid deposit, so it does
 * not gate: blocking on absent data would stop ordinary work for no reason.
 * A missing `depositRecorded` gates rather than clears, so a caller that has
 * not been taught about it errs shut.
 */
export function isBeforeDeposit(
  stage: string | null | undefined,
  depositRecorded = false,
): boolean {
  if (depositRecorded) return false;
  if (!stage) return false;
  if (STAGES_PAST_THE_GATE.has(stage)) return false;
  return STAGES_BEFORE_THE_GATE.has(stage);
}

// ---------------------------------------------------------------------------
// R2: money in partner-facing text
// ---------------------------------------------------------------------------

/**
 * Every currency figure in the text, as written.
 *
 * Covers the shapes that actually appear in this data: "249 EUR", "EUR 249",
 * "€249", "249€", "249 euro", "34.50 euro", "150-250 EUR", and the Greek
 * "120 ευρώ", which is the likeliest form of all here since partner mail is
 * written in Greek. Deliberately does not match a bare number, because a bare
 * number is far more often a form code (Δ210, E1, M1), a year, or an article
 * reference than a price.
 *
 * The unit is bounded by "not a letter" rather than by \b, and the Greek word
 * is spelled both ways. Both matter: \b never falls between a digit and a
 * letter, so "249EUR" written without a space was silently invisible to the
 * whole rule; and Greek capitals drop the accent by convention, so "250 ΕΥΡΩ"
 * did not case-fold onto "ευρώ" either. Missing a figure here is not a smaller
 * failure than blocking one wrongly, because nothing downstream looks again.
 *
 * The currency vocabulary is kept in step with the Brain's own CURRENCY_MARKER
 * (/€|\bEURO?S?\b|ευρώ/i, brain-mygreektax src/index.js), which is what sets
 * case_partner_drafts.pricing_flag. The Brain answers "is there money in here
 * at all"; this answers "which figures", because R2 asks for each one to be
 * confirmed rather than for a yes or no.
 */
export function findCurrencyFigures(text: string): string[] {
  if (!text) return [];
  // \p{L} rather than [A-Za-z] so "ευρώπη" guards the Greek form too. The u
  // flag is what makes the property escape work; i folds ΕΥΡΩ onto ευρω.
  const unit = "(?:€|(?<!\\p{L})EURO?S?(?!\\p{L})|(?<!\\p{L})ΕΥΡ[ΩΏ](?!\\p{L}))";
  const amount = "\\d[\\d.,]*(?:\\s*[-–]\\s*\\d[\\d.,]*)?";
  const patterns = [
    // Symbol or code first: €249, EUR 249,50, EUR249
    new RegExp(`${unit}\\s*${amount}`, "giu"),
    // Amount first: 249€, 249 EUR, 249EUR, 34.50 euro, 150-250 EUR, 120 ευρώ
    new RegExp(`${amount}\\s*${unit}`, "giu"),
  ];
  const found: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const hit = m[0].trim();
      if (!found.some((f) => f.toLowerCase() === hit.toLowerCase())) found.push(hit);
    }
  }
  return found;
}

// Words that cannot be innocent in partner-facing text: they describe the
// markup itself, or name the client's side of the price.
//
// Every gap between words is \s+ rather than a literal space, here and in the
// R7 lists below. A body reaches these rules through visibleText, which keeps
// block structure as newlines, so a phrase broken across a line break (a
// Shift+Enter, or a Brain draft whose plain text wrapped) would otherwise walk
// straight past a rule while the email still renders it as one sentence.
const RETAIL_TERMS: Array<{ re: RegExp; label: string }> = [
  { re: /\bmargins?\b/i, label: "margin" },
  { re: /\bmark[-\s]?ups?\b/i, label: "markup" },
  { re: /\bretail\b/i, label: "retail" },
  { re: /περιθώριο/i, label: "περιθώριο" },
  { re: /\bclient\s+(?:fee|price|total|rate)s?\b/i, label: "client fee" },
  { re: /\bcustomer\s+(?:fee|price|total|rate)s?\b/i, label: "customer fee" },
  // First person only. "you charge" and "you quoted" in partner-facing text
  // address the partner, and R2 permits a figure the partner themselves
  // proposed, so asking them to reconfirm their own rate is the rule working.
  { re: /\bwe\s+(?:charge|charged|quote[ds]?)\b/i, label: "what we charge" },
  { re: /\bour\s+(?:fee|price|total|rate)s?\b/i, label: "our price" },
  { re: /χρεών(?:ουμε|ω)/i, label: "χρεώνουμε" },
  { re: /τιμή\s+πελάτη/i, label: "τιμή πελάτη" },
];

export interface PricingFinding {
  /** Terms that can only mean retail. These block the send. */
  retailTerms: string[];
  /** Currency figures needing a human "yes, that is wholesale". */
  figures: string[];
}

/**
 * What a partner-facing body has to answer for before it can go out.
 *
 * Only meaningful for the partner target: the client is entitled to their own
 * prices, so this is never run against client mail.
 */
export function findPricingExposure(text: string): PricingFinding {
  return {
    retailTerms: RETAIL_TERMS.filter((t) => t.re.test(text)).map((t) => t.label),
    figures: findCurrencyFigures(text),
  };
}

// ---------------------------------------------------------------------------
// R7: what the deposit gate withholds
// ---------------------------------------------------------------------------

const GATED_CLIENT: Array<{ re: RegExp; label: string }> = [
  { re: /\bchecklists?\b/i, label: "checklist" },
  { re: /\bdocuments?\s+(?:(?:you|we)\s+)?(?:will\s+)?need\b/i, label: "document list" },
  { re: /\brequired\s+documents?\b/i, label: "required documents" },
  { re: /δικαιολογητικ/i, label: "δικαιολογητικά" },
  { re: /\bstep[-\s]by[-\s]step\b/i, label: "step by step" },
  { re: /\bmethodology\b/i, label: "methodology" },
  { re: /\bhere\s+is\s+how\s+(?:it|the\s+process)\s+works\b/i, label: "process explanation" },
  { re: /διαδικασ(?:ία|ίας)/i, label: "διαδικασία" },
];

const GATED_PARTNER: Array<{ re: RegExp; label: string }> = [
  { re: /ανάθεσ(?:η|ης|εις)/i, label: "ανάθεση" },
  { re: /αναθέτ(?:ω|ουμε)/i, label: "αναθέτουμε" },
  { re: /\bassign(?:ment|ing)?\b/i, label: "assignment" },
  { re: /\bplease\s+(?:start|begin|proceed)\b/i, label: "instruction to start" },
  { re: /ξεκίν(?:α|ησε)/i, label: "ξεκίνα" },
  { re: /προχώρ(?:α|ησε)/i, label: "προχώρα" },
];

/**
 * Language the deposit gate withholds, for the target being written to.
 *
 * Returns an empty array when the gate is not active, so the caller does not
 * have to remember to check the stage first.
 */
export function findGatedContent(
  text: string,
  target: ComposerTarget,
  beforeDeposit: boolean,
): string[] {
  if (!beforeDeposit) return [];
  const list = target === "partner" ? GATED_PARTNER : GATED_CLIENT;
  return list.filter((t) => t.re.test(text)).map((t) => t.label);
}

// ---------------------------------------------------------------------------
// The composer's overall verdict
// ---------------------------------------------------------------------------

export interface SendVerdict {
  /** Hard stops. The send button stays disabled while any of these stand. */
  blocking: string[];
  /** Things a human has to look at and confirm before sending. */
  confirmations: string[];
}

export function reviewBody(
  text: string,
  target: ComposerTarget,
  beforeDeposit: boolean,
): SendVerdict {
  const blocking: string[] = [];
  const confirmations: string[] = [];

  if (target === "partner") {
    const pricing = findPricingExposure(text);
    for (const term of pricing.retailTerms) {
      blocking.push(`R2: "${term}" describes retail pricing and cannot go to a partner.`);
    }
    if (pricing.figures.length > 0) {
      confirmations.push(
        `R2: confirm ${pricing.figures.length === 1 ? "this figure is" : "these figures are"} wholesale, not retail: ${pricing.figures.join(", ")}.`,
      );
    }
  }

  // These block rather than ask, unlike the figures above. R7 says it holds
  // under deadline pressure, "which is the exact circumstance it exists for",
  // so there is deliberately no acknowledge-and-proceed path here: a checkbox
  // between a Quoted case and a document checklist is not a gate. The cost is
  // that naming a withheld thing in a sentence about what happens after the
  // deposit ("once your deposit clears I will send the checklist") is caught
  // too, so the message says how to get past it.
  for (const label of findGatedContent(text, target, beforeDeposit)) {
    blocking.push(
      target === "partner"
        ? `R7: "${label}" assigns work before the deposit is confirmed. Ask instead of instructing, or wait for the deposit.`
        : `R7: "${label}" is withheld until the deposit is confirmed. Say what happens next without naming it, or wait for the deposit.`,
    );
  }

  // R7 also withholds "locked figures beyond the quote itself" from a client
  // before the deposit. Beyond the quote itself is the operative phrase: the
  // quote is exactly what a Quoted case is allowed to state, and payment
  // logistics necessarily name the amount to pay. So this asks rather than
  // blocks, the same shape as the pricing confirmation above, because the
  // difference between a permitted figure and a withheld one is a judgement
  // about which figure it is, not something the text can settle.
  if (target === "client" && beforeDeposit) {
    const figures = findCurrencyFigures(text);
    if (figures.length > 0) {
      confirmations.push(
        `R7: this case is before the deposit, so confirm ${figures.length === 1 ? "this figure is" : "these figures are"} the quote or payment logistics, not a locked figure beyond it: ${figures.join(", ")}.`,
      );
    }
  }

  return { blocking, confirmations };
}
