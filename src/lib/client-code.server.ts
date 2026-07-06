// Client Code generation -- the ONE shared place this logic lives.
//
// Format: CLT####-XX
//   #### = 4-digit, zero-padded sequence number, continuing from whatever the
//          current max is (never restarts at 0001 once codes exist).
//   XX   = always XX at creation time. Nationality is set manually on review
//          (existing rows show suffixes like -PT/-AR once reviewed -- that's
//          expected, this function only ever writes -XX on creation).
//
// Any future code path that creates a Client record should call
// createClientWithCode() below instead of writing "client_code" itself -
// that's what keeps this a single place the numbering logic lives, per the
// house rule (see Operating Manual: "never create a second place a fact lives").
//
// MIGRATION NOTE (Jul 2026): this file used to call the Airtable REST API
// directly (airtableListAll / airtablePost / airtablePatch). The portal's
// read side (/leads) reads from Supabase, so this file now writes to the
// SAME Supabase "clients" table -- otherwise leads created here would land
// in a database nobody reads from anymore.
//
// Schema confirmed live via SQL (Jul 2026) -- public.clients:
//   id uuid PK default gen_random_uuid(), NOT NULL
//   client_code text, UNIQUE (constraint: clients_client_code_key)
//   airtable_id text, UNIQUE, nullable -- legacy link, left null for new rows
//   full_name, email, phone, status, stage, source, urgency, notes: all text, nullable
//   created_at/updated_at: timestamptz, NOT NULL, default now()
// No CHECK constraints on status/stage -- they are free text at the DB level.
//
// RLS CONFIRMED (Jul 2026): public.clients has Row Level Security ENABLED
// with ZERO policies defined (pg_policies returned no rows). That means
// every ordinary role -- anon key, authenticated user, whatever -- gets
// silently denied on every insert/select, which is exactly what was
// throwing "Failed to create lead" with no useful detail. The only role
// that gets through is one with BYPASSRLS, i.e. Supabase's service_role.
// FIX: this file now imports the existing `supabaseAdmin` client from
// "@/integrations/supabase/client.server" (see that file) instead of a
// separate, possibly-anon-keyed client -- supabaseAdmin is built with
// SUPABASE_SERVICE_ROLE_KEY specifically to bypass RLS for trusted
// server-side operations, which is exactly this use case (a machine-to-
// machine webhook route with no logged-in Supabase session).
//
// Because client_code already has a real UNIQUE constraint in Postgres, we
// no longer need to hand-roll a read-after-write collision check like the
// Airtable version had to (Airtable has no such constraint). Instead we
// simply retry ONCE if Postgres reports a unique-violation (error code
// 23505) on client_code -- the database itself is now the source of truth
// for uniqueness, which is strictly safer than the old application-level
// re-check.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const CLIENT_CODE_PATTERN = /^CLT(\d{4})-/;
const CLIENTS_TABLE = "clients";
const CLIENT_CODE_COLUMN = "client_code";

// Postgres error code for "unique_violation".
const UNIQUE_VIOLATION = "23505";

export type ClientRecord = Record<string, unknown> & { id: string };

/** Pure -- no I/O. Extracts the numeric sequence from one Client Code, or null if it doesn't match the format. */
export function parseClientCodeSequence(code?: string | null): number | null {
  if (!code) return null;
  const match = CLIENT_CODE_PATTERN.exec(code.trim());
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/** Pure -- no I/O. Highest existing sequence + 1, or 1 if there are no valid codes yet. Never "restarts" once real codes exist -- it only ever goes up. */
export function nextClientCodeSequence(existingCodes: Array<string | null | undefined>): number {
  let max = 0;
  for (const code of existingCodes) {
    const seq = parseClientCodeSequence(code);
    if (seq !== null && seq > max) max = seq;
  }
  return max + 1;
}

/** Pure -- no I/O. Always CLT####-XX; nationality is set manually on review, not guessed here. */
export function formatClientCode(sequence: number): string {
  const padded = String(sequence).padStart(4, "0");
  return `CLT${padded}-XX`;
}

/** I/O -- reads every existing Client Code fresh (Supabase, via the RLS-bypassing admin client) and returns the next candidate code. */
export async function generateNextClientCode(): Promise<string> {
  const { data, error } = await supabaseAdmin.from(CLIENTS_TABLE).select(CLIENT_CODE_COLUMN);

  if (error) {
    throw new Error(`[client-code] failed to read existing codes: ${error.message}`);
  }

  const codes = (data ?? []).map(
    (row: Record<string, unknown>) => row[CLIENT_CODE_COLUMN] as string | null,
  );
  const sequence = nextClientCodeSequence(codes);
  return formatClientCode(sequence);
}

/**
 * THE shared create-client entry point. Every field the caller passes is
 * written as-is; this function's only job is generating and attaching a
 * correct, collision-safe Client Code.
 *
 * Uses supabaseAdmin (service role, bypasses RLS) since public.clients has
 * RLS enabled with no policies -- any non-service-role client would be
 * silently denied on both the read and the insert below.
 *
 * Race handling: client_code has a real UNIQUE constraint in Postgres
 * (clients_client_code_key), so a genuine race between two near-simultaneous
 * creates surfaces as a clean 23505 unique-violation from the insert itself
 * -- not a silently-corrupted read. We catch exactly that error code, mint
 * one fresh code, and retry the insert once. Any other error (network, bad
 * column, etc.) is rethrown as-is so the caller's catch block sees the real
 * reason instead of a swallowed collision-retry loop.
 */
export async function createClientWithCode(fields: Record<string, unknown>): Promise<ClientRecord> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = await generateNextClientCode();

    const { data: created, error: insertError } = await supabaseAdmin
      .from(CLIENTS_TABLE)
      .insert({ ...fields, [CLIENT_CODE_COLUMN]: code })
      .select()
      .single();

    if (!insertError && created) {
      return created as ClientRecord;
    }

    const isCollision =
      insertError?.code === UNIQUE_VIOLATION && insertError.message?.includes(CLIENT_CODE_COLUMN);

    if (isCollision && attempt === 0) {
      console.warn(`[client-code] Collision on code ${code}, retrying once with a fresh code.`);
      continue;
    }

    throw new Error(
      `[client-code] failed to create client: ${insertError?.message ?? "no row returned"}`,
    );
  }

  throw new Error("[client-code] failed to create client after retry");
}

export async function deleteClient(id: string): Promise<{ ok: true }> {
  const { error } = await supabaseAdmin.from(CLIENTS_TABLE).delete().eq("id", id);
  if (error) throw new Error(error.message);
  return { ok: true };
}
