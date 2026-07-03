// Client Code generation — the ONE shared place this logic lives.
//
// Format: CLT####-XX
//   #### = 4-digit, zero-padded sequence number, continuing from whatever the
//          current max is (never restarts at 0001 once codes exist).
//   XX   = always XX at creation time. Nationality is set manually on review,
//          not guessed here.
//
// Any future code path that creates a Client record should call
// createClientWithCode() below instead of writing "Client Code" itself -
// that's what keeps this a single place the numbering logic lives, per the
// house rule (see Operating Manual: "never create a second place a fact lives").
import {
  airtableListAll,
  airtablePatch,
  airtablePost,
  TABLES,
  type AirtableRecord,
  type ClientFields,
} from "./airtable.server";

const CLIENT_CODE_PATTERN = /^CLT(\d{4})-/;

/** Pure — no I/O. Extracts the numeric sequence from one Client Code, or null if it doesn't match the format. */
export function parseClientCodeSequence(code?: string | null): number | null {
  if (!code) return null;
  const match = CLIENT_CODE_PATTERN.exec(code.trim());
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/** Pure — no I/O. Highest existing sequence + 1, or 1 if there are no valid codes yet. Never "restarts" once real codes exist — it only ever goes up. */
export function nextClientCodeSequence(existingCodes: Array<string | null | undefined>): number {
  let max = 0;
  for (const code of existingCodes) {
    const seq = parseClientCodeSequence(code);
    if (seq !== null && seq > max) max = seq;
  }
  return max + 1;
}

/** Pure — no I/O. Always CLT####-XX; nationality is set manually on review, not guessed here. */
export function formatClientCode(sequence: number): string {
  const padded = String(sequence).padStart(4, "0");
  return `CLT${padded}-XX`;
}

/** I/O — reads every existing Client Code fresh and returns the next candidate code. Called both for the first attempt and for the one allowed retry. */
export async function generateNextClientCode(): Promise<string> {
  const { records } = await airtableListAll<ClientFields>(TABLES.clients, {
    "fields[]": ["Client Code"],
    pageSize: "100",
  });
  const codes = records.map((r) => r.fields["Client Code"]);
  const sequence = nextClientCodeSequence(codes);
  return formatClientCode(sequence);
}

/** I/O — true if no *other* record currently holds this code. */
async function isClientCodeUnique(code: string, ownRecordId: string): Promise<boolean> {
  const { records } = await airtableListAll<ClientFields>(TABLES.clients, {
    "fields[]": ["Client Code"],
    pageSize: "100",
  });
  const holders = records.filter((r) => r.fields["Client Code"] === code && r.id !== ownRecordId);
  return holders.length === 0;
}

/**
 * THE shared create-client entry point. Every field the caller passes is
 * written as-is; this function's only job is generating and attaching a
 * correct, race-checked Client Code.
 *
 * Race handling: Airtable has no unique constraint and no transactions, so
 * two near-simultaneous creates can both read the same "current max" and
 * pick the same code. We can't prevent that on the read side, but we detect
 * it right after writing (re-read + look for a duplicate holder) and correct
 * our own record once. In practice this project has exactly one admin using
 * the portal at a time, so true concurrent collisions are extremely unlikely
 * - this is a pragmatic guard, not a distributed lock. If the retry *also*
 * collides (astronomically unlikely), we log it rather than fail the create
 * outright, since the client record itself was created successfully and a
 * duplicate code is a fixable data issue, not a lost record.
 */
export async function createClientWithCode(
  fields: Record<string, unknown>,
): Promise<AirtableRecord<ClientFields>> {
  const code = await generateNextClientCode();

  const created = (await airtablePost(TABLES.clients, {
    ...fields,
    "Client Code": code,
  })) as AirtableRecord<ClientFields>;

  const unique = await isClientCodeUnique(code, created.id);
  if (!unique) {
    const retryCode = await generateNextClientCode();
    await airtablePatch(TABLES.clients, created.id, { "Client Code": retryCode });
    created.fields["Client Code"] = retryCode;

    const stillUnique = await isClientCodeUnique(retryCode, created.id);
    if (!stillUnique) {
      console.error(
        `[client-code] Collision persisted after retry for record ${created.id} (code ${retryCode}). Needs manual review.`,
      );
    }
  }

  return created;
}
