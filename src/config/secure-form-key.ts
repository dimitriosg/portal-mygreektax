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

export const SECURE_FORM_PUBLIC_KEY =
  "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA2POmgoodibAsVlCicRQxs/Px35HmSl9nDHs/VCjLPMwkwi3dyFNY2Xn07IuoMSw6LmdZKnZilZLTkSzReaCy9nq8GD0hPiLmjKGIPKdFSwcjzH9pCGpMnlqsE7rXAGD/J4HEa/EtG9mRn+sEKT4ubwCPSHIJRJwQOzNGaavKWrnruh94loSijyvikbCHCBgvs450INIa/KZqqe9FdVJewCLgISGZ+jVvXmnOm439XbzNZkRAViHawEgyQ1EnJYlJSztmbxmIMgsOL/BWbBNeLC7ZszPUecEfZn+If3mvMCczAM8e9ecK+NaCnVIFh3Mrsg/wN7Wj5UiAvv6S76SsZqGMu2Q7bkIkeks+Ki5vTOH+Z4Nf4C3LNfp28Vu2LDgb+Uri69aY+nDf2Dy1g1v7CuAdQCLrj2CC1C9v0BkGgUgColXfszKXqCJNwOrcSl4iT5TL27Ev90L/XwyrxwBHSmC4tzBTPUwYWhD7kprvsazkfTf9pqddUdal5oLcWhGm1LrRiPkseuaPs88+yJepKTl+9F4r+Q+rQ479GUVo6NnAzK3s1PI6hAPZriEDJdEzPd5GBMASBpqruQpFRchhG98mCTj3IEkOFMdxRm03BgdZRQLf0X7ZWY0HRTpbPaVys4UL4CCGuz0plLvMv3hjE0S3T85MLfZ3Di488uFsHv0CAwEAAQ==";

export const SECURE_FORM_KEY_FINGERPRINT = "d3ed4849d577471a";

export function secureFormKeyConfigured(): boolean {
  return !SECURE_FORM_PUBLIC_KEY.startsWith("REPLACE_WITH");
}
