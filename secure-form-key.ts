/**
 * Public key used by client browsers to encrypt credential submissions.
 *
 * This is a public key. It is safe in a public repo and safe in shipped JavaScript.
 * It can only lock, never unlock. The matching private key lives in Bitwarden.
 *
 * Security note: whoever can change this file can substitute their own key and read
 * every subsequent submission. That is the single highest-value target in this
 * feature. Changes here go through a pull request and never straight to main.
 *
 * Generate a pair at /admin/secure-keys, then paste the public key below and update
 * the fingerprint to match what that page displayed.
 */

export const SECURE_FORM_PUBLIC_KEY = "REPLACE_WITH_PUBLIC_KEY_FROM_ADMIN_SECURE_KEYS";

export const SECURE_FORM_KEY_FINGERPRINT = "REPLACE_WITH_FINGERPRINT";

export function secureFormKeyConfigured(): boolean {
  return !SECURE_FORM_PUBLIC_KEY.startsWith("REPLACE_WITH");
}
