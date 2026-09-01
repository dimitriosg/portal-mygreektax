import { describe, expect, it } from "vitest";

import { isAllowedOnPaymentHost } from "./payment-host";

// The cost of getting this list wrong is asymmetric. Too strict and the pay
// page renders but cannot fetch something it needs, which looks like a broken
// payment rather than a broken allowlist. Too loose and the portal is served
// on a domain we only ever gave to clients for paying. So both directions are
// spelled out here rather than left to reading the implementation.

describe("isAllowedOnPaymentHost", () => {
  const allowed: Array<{ path: string; why: string }> = [
    { path: "/pay/pay_9tbrrlpL58n4IJRNfHzZVA", why: "the payment page itself" },
    { path: "/pay/signal", why: "the view and claim beacon the page posts to" },
    { path: "/done", why: "where Stripe returns the client after the card form" },
    { path: "/api/checkout-session", why: "mints the Stripe session for the embedded form" },
    { path: "/api/checkout-status", why: "what /done reads to report the outcome" },
    {
      path: "/_serverFn/src_lib_payments-functions_ts--getPublicPayment",
      why: "TanStack re-runs the loader client-side on navigation; blocking this breaks the page after first render",
    },
    { path: "/assets/index-CVnTWrKz.js", why: "the bundle the page cannot run without" },
    { path: "/assets/styles-abc123.css", why: "same, for styling" },
    { path: "/favicon.svg", why: "root static file, matched by having an extension" },
    { path: "/og-image.png", why: "same" },
    { path: "/icon-maskable-512.png", why: "same" },
  ];

  for (const { path, why } of allowed) {
    it(`allows ${path} (${why})`, () => {
      expect(isAllowedOnPaymentHost(path)).toBe(true);
    });
  }

  const blocked: Array<{ path: string; why: string }> = [
    { path: "/", why: "the bare domain used to serve the portal landing page" },
    { path: "/login", why: "no reason to offer a sign-in on the payment domain" },
    { path: "/dashboard", why: "portal page" },
    { path: "/admin", why: "portal page" },
    { path: "/admin/payments", why: "portal page, nested" },
    { path: "/leads", why: "portal page" },
    { path: "/track/abc123", why: "tracking links are sent from the portal domain, not this one" },
    { path: "/donations", why: "must not slip through on a startsWith against /done" },
    {
      path: "/api/checkout-status-internal",
      why: "same, for the API paths: they are exact matches",
    },
    { path: "/pay", why: "no token, so nothing to pay; only /pay/ with something after it" },
  ];

  for (const { path, why } of blocked) {
    it(`blocks ${path} (${why})`, () => {
      expect(isAllowedOnPaymentHost(path)).toBe(false);
    });
  }
});
