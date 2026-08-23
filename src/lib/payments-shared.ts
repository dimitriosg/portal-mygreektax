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

/**
 * The label is derived from what fraction of the quote this payment is, NOT
 * from payment_tokens.kind. The two can legitimately disagree: a token with
 * kind 'deposit' covering the whole quote is labelled "full payment".
 *
 * Rounded to the nearest whole percent before comparing — €49.50 against a €99
 * quote is exactly half, but floating point does not always agree, and €168
 * against €467 is 35.97% and must land on "deposit".
 */
export function paymentNoteLabel(
  amount: number,
  quoteAmount: number | null | undefined,
): PaymentNoteLabel {
  if (!Number.isFinite(amount) || amount <= 0) return "deposit";
  if (quoteAmount == null || !Number.isFinite(quoteAmount) || quoteAmount <= 0) return "deposit";

  const percent = Math.round((amount / quoteAmount) * 100);
  if (percent === 50) return "upfront payment";
  if (percent === 100) return "full payment";
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

  // No case code is not expected — it is nullable in the schema, so degrade to
  // the name as the identifier rather than emitting a bare label.
  if (!caseCode) {
    return fullName ? `${fullName}, ${label}` : label;
  }

  const withoutName = `${caseCode}, ${label}`;
  if (!fullName) return withoutName;

  // What the name costs on top: " (" + name + ")".
  const availableForName = PAYMENT_NOTE_MAX_LENGTH - withoutName.length - " ()".length;
  if (availableForName < MIN_NAME_CHARS) return withoutName;

  // Truncated without an ellipsis: it would spend characters a bank statement
  // will not thank us for.
  const fittedName =
    fullName.length <= availableForName ? fullName : fullName.slice(0, availableForName).trimEnd();
  // The minimum applies to the room available, not to the name itself: a
  // genuinely short name ("Bo") fits and is kept.
  if (!fittedName) return withoutName;

  return `${caseCode} (${fittedName}), ${label}`;
}
