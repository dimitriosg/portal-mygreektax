// What may be served on the payment hostname.
//
// pay.mygreektax.eu and the portal are the same Worker on two hostnames, so
// without this the whole application answers on the payment domain: a client
// who trims the token off their link lands on the portal sign-in, and the
// admin is reachable at a URL we only ever handed out for paying.
//
// This is presentation, not a security boundary. Nothing here is what stops a
// stranger reading a case; the auth middleware does that, on every hostname.
// What it does is keep the payment domain looking like one thing.
//
// Kept out of server.ts so it can be tested as a plain function. Getting this
// list wrong breaks paying, and the failure mode is quiet: the page renders
// and then cannot fetch something it needs.

export const PAYMENT_HOST = "pay.mygreektax.eu";

// Where anything else goes. 302 rather than 301 at the call site: a permanent
// redirect is cached hard by browsers and would be painful to walk back if
// this domain ever serves something else.
export const PAYMENT_HOST_FALLBACK_URL = "https://mygreektax.eu";

// /_serverFn/ has to be here. TanStack re-runs route loaders client-side on
// navigation, and getPublicPayment is a server function, so blocking that
// prefix would break the pay page in a way that only appears after the first
// render. It exposes nothing on its own: those endpoints carry their own auth.
const ALLOWED_PREFIXES = ["/pay/", "/_serverFn/", "/assets/"] as const;

// Exact matches, so /donations does not slip through on a startsWith.
const ALLOWED_PATHS = ["/done", "/api/checkout-session", "/api/checkout-status"] as const;

export function isAllowedOnPaymentHost(pathname: string): boolean {
  if ((ALLOWED_PATHS as readonly string[]).includes(pathname)) return true;
  if (ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;

  // Any request for a file rather than a page: favicon.svg, og-image.png, a
  // source map, anything a future build emits at the root. Every route in this
  // application is extensionless, so a dot in the last segment is a reliable
  // way to say "static asset" without keeping a list in step with the build.
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return lastSegment.includes(".");
}
