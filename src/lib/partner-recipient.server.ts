import type { SupabaseClient } from "@supabase/supabase-js";

// The guard that keeps a partner send partner-only.
//
// Extracted so the two endpoints that can mail a partner cannot drift apart on
// it. This is the check that stops a partner endpoint being pointed at a
// client, or at any other address, whatever the browser posts: the address is
// matched against partner_profiles and the value used for delivery afterwards
// is the one the database returned, never the raw request value.

/** ILIKE treats % and _ as wildcards, and both are legal in an address. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface PartnerRecipient {
  email: string;
  full_name: string | null;
}

export type PartnerLookup =
  | { ok: true; partner: PartnerRecipient }
  | { ok: false; status: number; error: string; detail: string };

export async function resolveActivePartner(
  supabase: SupabaseClient,
  requestedEmail: string,
): Promise<PartnerLookup> {
  if (!requestedEmail) {
    return {
      ok: false,
      status: 400,
      error: "partner_email is required",
      detail: "A partner send must name the partner it is going to.",
    };
  }

  const { data, error } = await supabase
    .from("partner_profiles")
    .select("email, full_name")
    .is("disabled_at", null)
    .ilike("email", escapeLike(requestedEmail))
    .limit(1);

  if (error) {
    return {
      ok: false,
      status: 500,
      error: "Partner lookup failed",
      detail: error.message,
    };
  }

  const row = data?.[0] as PartnerRecipient | undefined;
  if (!row?.email) {
    return {
      ok: false,
      status: 422,
      error: "Recipient is not an active partner",
      detail: `${requestedEmail} is not in partner_profiles or is disabled.`,
    };
  }

  // The canonical address from the database, for both delivery and logging.
  return { ok: true, partner: { email: row.email, full_name: row.full_name ?? null } };
}
