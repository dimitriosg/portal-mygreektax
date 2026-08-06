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
// This Worker carries more secrets than the site Worker and fails harder
// without them, so the same booleans-only endpoint the site has is worth more
// here.
//
// REPORTS PRESENCE, NEVER VALUES. Every secret is Boolean(). The only strings
// returned are non-sensitive configuration whose whole purpose is to be read
// back, the Mailgun sending domain and the alert recipient, both of which are
// already visible in sent mail. If you add a secret to this Worker, add it to
// SECRETS below as a boolean, and do not be tempted to echo a prefix "just to
// check the right one is set" — a prefix is enough to confirm a guess.
//
// GET only, and deliberately unauthenticated, like the site's. What it exposes
// is the shape of the configuration, not its content, and requiring a secret to
// check whether secrets are set defeats the purpose.
// -----------------------------------------------------------------------------

// Secrets, reported as booleans only. Grouped by what breaks without them, so a
// false is immediately readable as a consequence rather than a name.
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
      GET: async () => {
        const secrets = secretPresence();

        // The one route on this Worker that refuses to run at all without a
        // secret. Called out separately because a false here is not degraded
        // service, it is every Mailgun event rejected with a 500: no bounce
        // suppression, no complaint alerts, and no conversation capture.
        const mailgunEventsReady = secrets.MAILGUN_WEBHOOK_SIGNING_KEY;

        return Response.json(
          {
            ok: true,
            worker: "portal-mygreektax",
            secrets,
            // Not secret, and useful to read back: these determine where alerts
            // are sent from and to.
            mailgunDomain: process.env.MAILGUN_DOMAIN || "mygreektax.eu",
            mailgunAlertTo: process.env.MAILGUN_ALERT_TO || "jim@mygreektax.eu",
            routes: {
              // false means /webhooks/mailgun-events is rejecting everything.
              mailgunEventsReady,
            },
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
