import { createFileRoute } from "@tanstack/react-router";

// -----------------------------------------------------------------------------
// Diagnostic health endpoint.
//
// WHY THIS EXISTS: until now there was no way to tell whether a Cloudflare
// secret was set on this Worker without opening the dashboard. That turned
// every "is the key configured?" into a question only one person could answer,
// and it blocked a deploy on 06/08/2026 for exactly that reason: nobody could
// confirm MAILGUN_WEBHOOK_SIGNING_KEY existed, and /webhooks/mailgun-events
// hard-500s without it.
//
// WHY IT IS GATED: the first cut of this route returned the full inventory to
// anyone. That was a mistake and it was caught by using it. Fourteen secret
// NAMES, plus which of them are currently unset, is a map: it took one
// anonymous request to learn that MGT_WEBHOOK_SECRET was false, and a false in
// that list points straight at the route whose guard is currently off. Values
// were never exposed and are still not, but names plus status was already too
// much.
//
// So: a bare liveness answer to anyone, the inventory only to a caller holding
// HEALTH_CHECK_SECRET, sent as x-health-check-secret. Same shape as the
// x-lead-intake-secret convention this repo already uses on /webhooks/lead-intake.
//
// The one-time cost is that HEALTH_CHECK_SECRET itself has to be set from the
// dashboard before any of this is readable, which is the very trip the endpoint
// exists to avoid. That trip is now paid once rather than once per secret, and
// there is no way around it: an endpoint that reveals the configuration to an
// unauthenticated caller is the thing being fixed.
//
// PRESENCE ONLY, NEVER VALUES. Every secret is Boolean(). Do not be tempted to
// echo a prefix "just to check the right one is set" — a prefix is enough to
// confirm a guess. If you add a secret to this Worker, add it to secretPresence
// below as a boolean.
// -----------------------------------------------------------------------------

// Length-independent comparison. The secret is high-entropy and this is over
// the network, so a timing attack is not realistic, but the cost of not leaking
// a comparison is five lines.
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// Grouped by what breaks without them, so a false reads as a consequence
// rather than a name.
function secretPresence() {
  return {
    // Database. Everything server-side fails without these.
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),

    // Mailgun. Two DIFFERENT credentials: the sending API key, and the webhook
    // signing key used to verify inbound events. Confusing them is easy and the
    // failure is silent, so both are listed.
    MAILGUN_API_KEY: Boolean(process.env.MAILGUN_API_KEY),
    MAILGUN_WEBHOOK_SIGNING_KEY: Boolean(process.env.MAILGUN_WEBHOOK_SIGNING_KEY),

    // Inbound webhook shared secrets.
    LEAD_INTAKE_SECRET: Boolean(process.env.LEAD_INTAKE_SECRET),
    MGT_WEBHOOK_SECRET: Boolean(process.env.MGT_WEBHOOK_SECRET),
    BRAIN_WEBHOOK_SECRET: Boolean(process.env.BRAIN_WEBHOOK_SECRET),
    OPS_SNAPSHOT_KEY: Boolean(process.env.OPS_SNAPSHOT_KEY),

    // Outbound integrations.
    BRAIN_ORCHESTRATE_URL: Boolean(process.env.BRAIN_ORCHESTRATE_URL),
    MAKE_PARTNER_SYNC_URL: Boolean(process.env.MAKE_PARTNER_SYNC_URL),
    MAKE_GMAIL_SYNC_WEBHOOK_URL: Boolean(process.env.MAKE_GMAIL_SYNC_WEBHOOK_URL),
    LOVABLE_API_KEY: Boolean(process.env.LOVABLE_API_KEY),
    LOVABLE_SEND_URL: Boolean(process.env.LOVABLE_SEND_URL),
    PLAUSIBLE_API_KEY: Boolean(process.env.PLAUSIBLE_API_KEY),
  };
}

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const bare = { ok: true, worker: "portal-mygreektax" };
        const noStore = { headers: { "cache-control": "no-store" } };

        const expected = process.env.HEALTH_CHECK_SECRET;
        const provided = request.headers.get("x-health-check-secret");

        // No secret configured: liveness only, never the inventory. Fails
        // closed, so forgetting to set HEALTH_CHECK_SECRET cannot reproduce the
        // open endpoint this gate was added to remove.
        if (!expected) {
          console.warn("[health] HEALTH_CHECK_SECRET not configured; detail withheld");
          return Response.json({ ...bare, detail: "unavailable" }, noStore);
        }

        // Same answer for a missing header and a wrong one. 200 rather than
        // 401, so an unauthenticated caller learns nothing about whether the
        // gate exists or what it guards.
        if (!provided || !secretsMatch(provided, expected)) {
          return Response.json({ ...bare, detail: "unavailable" }, noStore);
        }

        const secrets = secretPresence();

        // The one route that refuses to run at all without its secret. Called
        // out because a false here is not degraded service: it is every Mailgun
        // event rejected, so no bounce suppression, no complaint alerts and no
        // conversation capture.
        const mailgunEventsReady = secrets.MAILGUN_WEBHOOK_SIGNING_KEY;

        return Response.json(
          {
            ...bare,
            secrets,
            // Not secret, and useful to read back: these determine where alerts
            // are sent from and to. Behind the gate anyway, since there is no
            // reason to volunteer configuration to an anonymous caller.
            mailgunDomain: process.env.MAILGUN_DOMAIN || "mygreektax.eu",
            mailgunAlertTo: process.env.MAILGUN_ALERT_TO || "jim@mygreektax.eu",
            routes: { mailgunEventsReady },
          },
          noStore,
        );
      },
    },
  },
});
