/**
 * Admin impersonation state, kept in sessionStorage so it lasts a tab and no
 * longer. It lives here rather than in auth-context so that route loaders,
 * which run outside React and cannot read the auth context, can read the same
 * value the provider does without pulling a component module into the loader.
 */
export const IMPERSONATION_ID_KEY = "mgt:impersonateId";
export const IMPERSONATION_NAME_KEY = "mgt:impersonateName";

/**
 * The impersonated accountant id, or null when not impersonating or when
 * running on the server, where there is no sessionStorage. The value is an
 * accountants row id, which is what partner_profiles.airtable_accountant_id
 * holds and what the rest of the impersonation feature already keys on.
 */
export function getStoredImpersonationId(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(IMPERSONATION_ID_KEY);
}
