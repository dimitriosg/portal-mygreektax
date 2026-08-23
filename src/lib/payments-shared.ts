// Pure helpers shared by the payment server functions and the admin form, so
// the note previewed in /admin/payments is byte-for-byte what gets stored on
// the token. No server imports belong in here.

// The Revolut note field truncates around here. Observed from a real payment
// rather than documented, so it lives in one place: if we learn better, this
// is the single edit.
export const PAYMENT_NOTE_MAX_LENGTH = 64;

// Below this, a name fragment is noise in a bank statement — drop the name and
// its parentheses instead.
const MIN_NAME_CHARS = 3;

export type PaymentNoteLabel = "upfront payment" | "full payment" | "deposit";

// How close to 50% or 100% still counts, in percentage points.
//
// Half of a quote rounded to whole cents is off by at most half a cent, which
// is (0.5 / quote) percentage points — below 0.1 for any quote above €5. So
// this window absorbs cent rounding on every realistic quote while still
// rejecting a genuine shortfall.
//
// Rounding to whole percents instead would be too coarse: €248 against a €249
// quote is 99.598% and would round up to a "full payment" that leaves €1
// outstanding. Exact cent arithmetic would be too strict in the other
// direction: €50.00 against €99.99 is 50.005% and is plainly the upfront half.
const NEAR_PERCENT = 0.1;

/**
 * The label is derived from what fraction of the quote this payment is, NOT
 * from payment_tokens.kind. The two can legitimately disagree: a token with
 * kind 'deposit' covering the whole quote is labelled "full payment".
 */
export function paymentNoteLabel(
  amount: number,
  quoteAmount: number | null | undefined,
): PaymentNoteLabel {
  if (!Number.isFinite(amount) || amount <= 0) return "deposit";
  if (quoteAmount == null || !Number.isFinite(quoteAmount) || quoteAmount <= 0) return "deposit";

  const percent = (amount / quoteAmount) * 100;
  if (Math.abs(percent - 50) <= NEAR_PERCENT) return "upfront payment";
  if (Math.abs(percent - 100) <= NEAR_PERCENT) return "full payment";
  return "deposit";
}

/**
 * Builds the note prefilled into the Revolut link. It reaches the Revolut
 * transaction record, not just the payment page, so it is the only thing tying
 * a Revolut.me payment back to a case: the case serial and the label always
 * survive the length cap, and the name absorbs any truncation.
 *
 * `MGT-CS001-CLT0028 (Dimitrios Galanopoulos), upfront payment`
 */
export function buildPaymentNote(input: {
  caseCode: string | null | undefined;
  fullName: string | null | undefined;
  amount: number;
  quoteAmount: number | null | undefined;
}): string {
  const caseCode = (input.caseCode ?? "").trim();
  const fullName = (input.fullName ?? "").trim();
  const label = paymentNoteLabel(input.amount, input.quoteAmount);

  // A missing case code is not expected — it is nullable in the schema, and the
  // client picker filters by stage rather than by case-code presence, so a new
  // Quoted client without one is ordinary. Degrade to the name as the
  // identifier rather than emitting a bare label, and go through the same
  // fitting path either way so the cap always applies.
  const withoutName = caseCode ? `${caseCode}, ${label}` : label;
  if (!fullName) return withoutName;

  // What the name costs on top of `withoutName`: " (" + name + ")" when there
  // is a case code to hang it off, otherwise the name plus its own ", ".
  const nameOverhead = caseCode ? " ()".length : ", ".length;
  const availableForName = PAYMENT_NOTE_MAX_LENGTH - withoutName.length - nameOverhead;
  if (availableForName < MIN_NAME_CHARS) return withoutName;

  // Truncated without an ellipsis: it would spend characters a bank statement
  // will not thank us for.
  const fittedName =
    fullName.length <= availableForName ? fullName : fullName.slice(0, availableForName).trimEnd();
  // The minimum applies to the room available, not to the name itself: a
  // genuinely short name ("Bo") fits and is kept.
  if (!fittedName) return withoutName;

  return caseCode ? `${caseCode} (${fittedName}), ${label}` : `${fittedName}, ${label}`;
}
