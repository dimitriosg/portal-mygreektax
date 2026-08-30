import type { SupabaseClient } from "@supabase/supabase-js";

// The guard that keeps a partner send partner-only.
//
// Extracted when there were two endpoints that could mail a partner, so they
// could not drift apart on it. Only send-approved remains, and this still
// lives apart from it: it is the check that stops a partner endpoint being
// pointed at a client, or at any other address, whatever the browser posts,
// and the next such endpoint should reuse it rather than rewrite it. The
// address is matched against partner_profiles and the value used for delivery
// afterwards is the one the database returned, never the raw request value.

// A partner send must name a real address, not a pattern. The retired
// partner-reply route checked this before its lookup, and the check moved here
// with the lookup rather than being left behind.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * ILIKE wildcards, escaped.
 *
 * % and _ are the documented pair, but PostgREST also accepts * as an alias
 * for %, so an unescaped "*" would reach the query as "match anything" and
 * return whichever active partner sorted first. The address format check
 * above already rejects it; escaping it too means neither guard is load
 * bearing on its own.
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_*]/g, (c) => `\\${c}`);
}

export interface PartnerRecipient {
  email: string;
  full_name: string | null;
}

export type PartnerLookup =
  | { ok: true; partner: PartnerRecipient }
  | { ok: false; status: number; error: string; detail: string };

/**
 * The partner a send may go to, or the reason it may not.
 *
 * `requestedEmail` is the browser's claim about who the operator picked. It is
 * used only to look a partner up: on success the address returned is the one
 * `partner_profiles` holds, so a posted address that is not an enabled
 * partner (a client's, or one that was disabled since the page loaded) cannot
 * be mailed by a partner endpoint.
 *
 * Errors carry a status and two strings: `error` for the operator and `detail`
 * for what they can do about it. The database's own message never travels,
 * since it names tables and columns and tells the caller nothing they can act
 * on.
 */
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
  if (!EMAIL_RE.test(requestedEmail)) {
    return {
      ok: false,
      status: 400,
      error: "partner_email is not an address",
      detail: "A partner send must name one address, not a pattern.",
    };
  }

  const { data, error } = await supabase
    .from("partner_profiles")
    .select("email, full_name")
    .is("disabled_at", null)
    .ilike("email", escapeLike(requestedEmail))
    .limit(1);

  if (error) {
    // The database's own words name tables and columns and tell the caller
    // nothing they can act on. They go to the log, not the response.
    console.error("[partner-recipient] lookup failed:", error.message);
    return {
      ok: false,
      status: 500,
      error: "Partner lookup failed",
      detail: "The partner list could not be read. The reason is in the server log.",
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
