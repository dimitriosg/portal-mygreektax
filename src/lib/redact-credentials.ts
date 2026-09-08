// Credential masking for stored correspondence.
//
// WHY THIS EXISTS
// Clients type their TAXISnet login into email. At least five distinct
// credentials arrived that way between July and September 2026, and because a
// reply quotes the message it answers, each spread across a whole thread: 73
// rows of brain_events, plus derived copies in a case note, two case summaries
// and a draft. Migration 20260908080000 cleaned those; this keeps the next one
// from landing.
//
// THE RULE: key on the LABEL, never on the value.
// A pattern built from a secret would put the secret in this repository and its
// history, which is the problem rather than the fix. So this matches
// "Password:" and replaces what follows, and never needs to know what a
// password looks like.
//
// THE VALUE MAY BE ON THE NEXT LINE, BUT NOT IF THAT LINE IS QUOTED
// Two real shapes pull in opposite directions. A structured case note writes
// the label as a heading:
//
//   TAXISnet PASSWORD:
//   hunter2
//
// while quoted email puts a quote marker in the way:
//
//   > Password:
//   > hunter2
//
// Crossing the newline is required for the first and destructive for the
// second, where it would replace the ">" and leave the secret behind, having
// mangled the thread on the way past. So exactly one newline is allowed, and
// only when the next line does not begin with ">". A label followed by a blank
// line matches nothing, so it cannot swallow the next paragraph.
//
// WHAT THIS STILL CANNOT DO
// It needs a ":" or "=". Prose -- "username alex1, password hunter2" -- has
// neither, and a rule that masked the token after a bare label word would
// rewrite ordinary English across every row. Two AI summaries were written that
// way and the migration resets them rather than pretending a pattern reaches
// them. The real defence there is upstream: once the events this reads from are
// masked, a regenerated summary has no credential to restate.
//
// This is one of two implementations of the same rule. The other is
// public.redact_credentials(text) in SQL, applied by trigger to every write,
// including the ones that do not come through this code at all -- the Brain's
// summarisation path wrote a credential into case_summaries without touching
// either webhook. The tests assert both against the same cases.

/**
 * Labels that introduce a credential. English first, then the Greek forms that
 * appear in this mailbox. `κωδικ...` is matched loosely because Greek inflects
 * the ending (κωδικός, κωδικό, κωδικοί) and the ending carries no meaning here.
 */
const CREDENTIAL_LABEL =
  "(?:login|user(?:\\s?name)?|pass(?:word|code)?|pwd|pin|otp" +
  "|κωδικ[^\\s:=]*|συνθηματικ[^\\s:=]*|κλειδ[αά]ριθμ[^\\s:=]*" +
  // Latin "kleidarithmos" as well as the Greek. The structured case note that
  // prompted this wrote KLEIDARITHMOS: in Latin capitals, and the Greek-only
  // label walked straight past it.
  "|kleidarithmos" +
  "|[οό]νομα[^\\S\\r\\n]+χρ[ηή]στη)";

/**
 * A qualifier may sit between the label and the colon. Only the ones that still
 * mean a credential are listed: this is what keeps "Κωδικός εργασίας: 0043" --
 * a job code, and useful on the case page -- out of the match, while catching
 * "Κωδικός πρόσβασης".
 */
const CREDENTIAL_QUALIFIER = "(?:[^\\S\\r\\n]+(?:πρ[οό]σβασης|χρ[ηή]στη|εισ[οό]δου|ασφαλε[ιί]ας))?";

/**
 * Label, optional qualifier, separator, then the value to the end of its token.
 *
 * The leading lookbehind stops a label matching inside a longer word, so
 * "compass:" and "enduser:" are left alone. The lookahead after the separator
 * makes the whole thing a fixpoint: applying it to already-masked text
 * reproduces that text rather than masking the marker again.
 */
const CREDENTIAL_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${CREDENTIAL_LABEL}${CREDENTIAL_QUALIFIER}` +
    // Separator, then the value -- which may sit on the next line, but only one
    // line down and only if that line does not begin with a quote marker.
    //
    // Both restrictions are load-bearing. Allowing the next line is what
    // catches the structured note shape, where the label is a heading:
    //
    //   TAXISnet PASSWORD:
    //   hunter2
    //
    // Refusing it when the line starts with ">" is what keeps quoted email
    // safe: there the next line is "> hunter2", and a pattern that crossed
    // into it would replace the quote marker and leave the secret. Allowing
    // exactly one newline is what stops a label followed by a blank line from
    // swallowing the first word of the next paragraph.
    `[^\\S\\r\\n]*[:=][^\\S\\r\\n]*(?:\\r?\\n[^\\S\\r\\n]*)?)(?!>)(?!\\[redacted)\\S+`,
  "giu",
);

export const CREDENTIAL_MARKER = "[redacted]";

/**
 * Replace the value after any credential label, leaving the label and the rest
 * of the text intact.
 *
 * Returns the input unchanged when there is nothing to mask, and handles null
 * and undefined so call sites can pass a nullable column straight through.
 */
export function redactCredentials(text: string): string;
export function redactCredentials(text: null | undefined): null;
export function redactCredentials(text: string | null | undefined): string | null;
export function redactCredentials(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return String(text).replace(CREDENTIAL_PATTERN, `$1${CREDENTIAL_MARKER}`);
}

/**
 * Whether the text carries a credential label followed by an unmasked value.
 *
 * Reporting only -- the redaction does not consult it. Useful for asserting a
 * table is clean without pulling any body text out of the database.
 */
export function containsCredential(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  // A fresh regex: CREDENTIAL_PATTERN carries /g, whose lastIndex is stateful
  // across calls to .test(), which is a classic way to get alternating results
  // from the same input.
  return new RegExp(CREDENTIAL_PATTERN.source, "iu").test(String(text));
}
