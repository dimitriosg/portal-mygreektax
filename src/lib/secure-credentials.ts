import { supabase } from "@/integrations/supabase/client";

/**
 * The credential tables and functions are newer than src/integrations/supabase/types.ts.
 * Until that file is regenerated from the Supabase dashboard, the typed client does not
 * know about them, so this module holds one narrowly scoped cast and exposes typed
 * wrappers around it. When types.ts is refreshed, delete the cast and the local types,
 * not the wrappers.
 */

type PgError = { message: string } | null;

type Filtered<T> = PromiseLike<{ data: T[] | null; error: PgError }>;

type Selected<T> = Filtered<T> & {
  order: (column: string, options: { ascending: boolean }) => Filtered<T>;
};

type Table<T> = {
  select: (columns: string) => Selected<T>;
  insert: (values: Record<string, unknown>) => PromiseLike<{ error: PgError }>;
};

type UntypedClient = {
  rpc: <T>(fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: T; error: PgError }>;
  from: <T>(table: string) => Table<T>;
};

const db = supabase as unknown as UntypedClient;

export type RequestInfo = {
  valid: boolean;
  firstName: string | null;
  serviceLabel: string | null;
};

export type SubmissionRow = {
  id: string;
  client_id: string | null;
  ciphertext: string | null;
  key_fingerprint: string;
  status: string;
  submitted_at: string;
  retain_until: string | null;
  access_count: number;
  last_accessed_at: string | null;
  clients: { full_name: string | null; client_code: string | null } | null;
};

type OpenRow = {
  out_valid: boolean;
  out_first_name: string | null;
  out_service_label: string | null;
};

function fail(error: PgError, fallback: string): never {
  throw new Error(error?.message ?? fallback);
}

/** Generates a 32-byte URL-safe token. Called client side, so it uses Web Crypto. */
export function newRequestToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Public. Validates a form token and returns display-only information. */
export async function openRequest(token: string): Promise<RequestInfo> {
  const { data, error } = await db.rpc<OpenRow[]>("credential_request_open", { p_token: token });
  if (error) fail(error, "Could not open this form.");
  const row = data?.[0];
  return {
    valid: Boolean(row?.out_valid),
    firstName: row?.out_first_name ?? null,
    serviceLabel: row?.out_service_label ?? null,
  };
}

/** Public. Submits an already-encrypted envelope. Plaintext never reaches this function. */
export async function submitCredentials(input: {
  token: string;
  ciphertext: string;
  keyFingerprint: string;
}): Promise<string> {
  const { data, error } = await db.rpc<string>("credential_submit", {
    p_token: input.token,
    p_ciphertext: input.ciphertext,
    p_key_fingerprint: input.keyFingerprint,
  });
  if (error) fail(error, "Submission failed.");
  return data;
}

/** Admin. */
export async function listSubmissions(): Promise<SubmissionRow[]> {
  const { data, error } = await db
    .from<SubmissionRow>("credential_submissions")
    .select(
      "id, client_id, ciphertext, key_fingerprint, status, submitted_at, retain_until, access_count, last_accessed_at, clients(full_name, client_code)",
    )
    .order("submitted_at", { ascending: false });
  if (error) fail(error, "Could not load submissions.");
  return data ?? [];
}

/** Admin. Creates a request row and returns the token for the link. */
export async function createRequest(input: {
  clientId: string | null;
  serviceLabel: string;
  note: string;
}): Promise<string> {
  const token = newRequestToken();
  const { error } = await db.from("credential_requests").insert({
    token,
    client_id: input.clientId,
    service_label: input.serviceLabel,
    note: input.note || null,
  });
  if (error) fail(error, "Could not create the link.");
  return token;
}

/** Admin. Records that a payload was decrypted, and why. */
export async function markAccessed(submissionId: string, serviceLabel: string): Promise<void> {
  const { error } = await db.rpc("credential_mark_accessed", {
    p_submission_id: submissionId,
    p_service_label: serviceLabel || null,
  });
  if (error) fail(error, "Could not record access.");
}

/** Admin. Wipes the ciphertext and keeps the row as evidence of destruction. */
export async function deleteSubmission(submissionId: string): Promise<void> {
  const { error } = await db.rpc("credential_delete", { p_submission_id: submissionId });
  if (error) fail(error, "Could not delete.");
}
