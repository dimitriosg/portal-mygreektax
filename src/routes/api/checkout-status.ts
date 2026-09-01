import { createFileRoute } from "@tanstack/react-router";

// GET /api/checkout-status?session_id=cs_...
//
// Called by /done once Stripe has sent the client back from the card form.
// Stripe puts the session id in the return URL, and the only way to learn what
// happened to that session is to ask Stripe with the secret key, which cannot
// live in the browser. So this route exists purely to make that one read.
//
// WHAT THIS ROUTE IS NOT.
//
// It does not record the payment. That is the webhook's job, and the
// distinction matters: a client who pays and then closes the tab before the
// redirect never loads /done at all. If this page were the confirmation, those
// payments would silently go unrecorded. This is a display helper, nothing
// more, and nothing downstream should depend on it having run.
//
// It also returns almost nothing on purpose. Status, whether the payment part
// succeeded, and the email Stripe will send the receipt to. No amounts, no
// metadata, and in particular no payment token: the session id ends up in
// browser history and could be screenshotted or shared, so it must not be a
// route back to a live payment credential.

const STRIPE_API = "https://api.stripe.com/v1";

// Stripe's checkout session ids are cs_test_... or cs_live_... followed by an
// opaque string. Bounded on both ends so a junk query string is rejected here
// rather than turned into an outbound request.
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{10,250}$/;

type StripeSession = {
  status?: string;
  payment_status?: string;
  customer_details?: { email?: string | null } | null;
  error?: { message?: string };
};

// A payment result must never be served from a cache, by us or by anything in
// between. The client could otherwise refresh after a retry and be shown the
// previous attempt's outcome.
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export const Route = createFileRoute("/api/checkout-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) {
          console.error("[checkout-status] STRIPE_SECRET_KEY not configured");
          return Response.json(
            { error: "Server configuration error" },
            { status: 500, headers: NO_STORE },
          );
        }

        const sessionId = (new URL(request.url).searchParams.get("session_id") ?? "").trim();
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          return Response.json({ error: "Invalid session id" }, { status: 400, headers: NO_STORE });
        }

        let response: Response;
        try {
          response = await fetch(`${STRIPE_API}/checkout/sessions/${sessionId}`, {
            headers: { Authorization: `Bearer ${stripeKey}` },
          });
        } catch (error) {
          console.error("[checkout-status] stripe unreachable", error);
          return Response.json(
            { error: "Could not check the payment" },
            { status: 502, headers: NO_STORE },
          );
        }

        const data = (await response.json().catch(() => ({}))) as StripeSession;

        if (!response.ok) {
          // A wrong or expired id is a 404 from Stripe and is not our bug, so
          // it is logged at warn. Anything else means the integration is
          // broken and deserves a louder line.
          const log = response.status === 404 ? console.warn : console.error;
          log("[checkout-status] stripe lookup failed", {
            status: response.status,
            message: data.error?.message,
          });
          return Response.json(
            { error: "Could not check the payment" },
            { status: 502, headers: NO_STORE },
          );
        }

        return Response.json(
          {
            status: data.status ?? "unknown",
            paymentStatus: data.payment_status ?? "unknown",
            email: data.customer_details?.email ?? null,
          },
          { headers: NO_STORE },
        );
      },
    },
  },
});
