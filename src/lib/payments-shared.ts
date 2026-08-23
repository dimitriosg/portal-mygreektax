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

export type PaymentNoteLabel =
  "upfront payment" | "full payment" | "deposit" | "balance payment" | "part payment";

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

function isNear(percent: number, target: number): boolean {
  return Math.abs(percent - target) <= NEAR_PERCENT;
}

/**
 * The label is derived from the money, NOT from payment_tokens.kind. The two
 * can legitimately disagree: a token with kind 'deposit' covering the whole
 * quote is labelled "full payment".
 *
 * Which fraction matters depends on whether the case has already received
 * money. Against the quote alone, a 150 deposit and a 150 balance on a 300
 * quote both compute to 50% and both read "upfront payment" — two Revolut
 * transactions on one case carrying identical strings, in the field whose only
 * job is telling them apart. So once `clients.deposit` is non-zero the label
 * comes from the share of what is still outstanding instead.
 *
 * `depositSoFar` is `clients.deposit`, which is nullable: it must be coalesced
 * before arithmetic or `quoteAmount - null` is NaN and every label collapses
 * to "deposit".
 */
export function paymentNoteLabel(
  amount: number,
  quoteAmount: number | null | undefined,
  depositSoFar?: number | null,
): PaymentNoteLabel {
  if (!Number.isFinite(amount) || amount <= 0) return "deposit";
  if (quoteAmount == null || !Number.isFinite(quoteAmount) || quoteAmount <= 0) return "deposit";

  const paidSoFar = depositSoFar != null && Number.isFinite(depositSoFar) ? depositSoFar : 0;

  // First money on this case.
  if (paidSoFar <= 0) {
    const percent = (amount / quoteAmount) * 100;
    if (isNear(percent, 100)) return "full payment";
    if (isNear(percent, 50)) return "upfront payment";
    return "deposit";
  }

  // Money has already landed, so measure against what is left.
  const outstanding = quoteAmount - paidSoFar;
  // A link minted against a fully settled case. Rare — expanding scope adds a
  // job, which raises quote_amount by trigger and makes this positive again.
  if (outstanding <= 0) return "deposit";

  const percent = (amount / outstanding) * 100;
  if (isNear(percent, 100)) return "balance payment";
  return "part payment";
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
  // clients.deposit — what this case has already received. Read only; it is
  // written by confirm_payment() and by nothing else.
  depositSoFar?: number | null;
}): string {
  const caseCode = (input.caseCode ?? "").trim();
  const fullName = (input.fullName ?? "").trim();
  const label = paymentNoteLabel(input.amount, input.quoteAmount, input.depositSoFar);

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
