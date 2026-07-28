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

export const SECURE_FORM_PUBLIC_KEY = "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA0m0HST5iWtLTc1PL7ahgAgA8agFALHYqrEA3Y40X6P1VEadwriQE8CkIS0YORbJA1Ffq0vQlE7iNmat33lyXNNsmimLJZ+n+aTlanQFEgMRzL87N6NGChM0hGk4d137/zfFFMYlOr/GcFouHn644pEX+f5gDkkIuydudjXfQ9qj47lPZv4nGLorVJw9F9aYoOKMr248bmjhghZ//Uo302cbp25+2LTkb8cjNlFGOpw/rwwgfpIOWqH5VWEo+JxxKL20SUsq3u9Gz0iXPgkYCmcEi04TZjiv8JjTkwNG4tIDteuiCF27eFXk0YpEO+okfy0ur5Ofn/dsBtzgmtYPioKYFii6sMzqE+wdFv5SAfIhXdQUgzSEGR/Oh+KeWsy0V2U0P4LDiCaOFwPB8lfRA0ZlzompM2jf6Ga/yL1/rMtt2LIuPi6DCQJXOwb5rL3jK5EUfYNUShJB+oYJCREDmDWqs9YqMWxy9r7SJRC7lbM/cONR49mSy1pFB57KtR8AGQBiCr1sNvSalncRxfY2UdmYfgxtTXdQ1SnchOa2I7Tpyu0NKCTp+GcOZRF9pOi/OOKKajG4ZI9L0WMCcuMVx0Cvi3PXfmseFCLnbuRcFPVogIFUorSbyI34AGotvg8BMoXGl0NSRXJz16rkmzVjwrgs29EGKOLSkx1TzIVNh8HUCAwEAAQ==";
export const SECURE_FORM_KEY_FINGERPRINT = "REPLACE_WITH_FINGERPRINT";

export function secureFormKeyConfigured(): boolean {
  return !SECURE_FORM_PUBLIC_KEY.startsWith("REPLACE_WITH");
}
