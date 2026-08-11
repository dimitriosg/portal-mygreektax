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
// WHY IT IS GATED: the first cut returned the full inventory to anyone. That
// was a mistake and it was caught by using it. Fourteen names, plus which are
// currently unset, is a map: one anonymous request was enough to learn that
// MGT_WEBHOOK_SECRET was false, and a false in that list points straight at a
// route whose guard is off. Values were never exposed and still are not, but
// names plus status was already too much.
//
// So: a bare liveness answer to anyone, the inventory only to a caller holding
// HEALTH_CHECK_SECRET, sent as x-health-check-secret. Same shape as the
// x-lead-intake-secret convention on /webhooks/lead-intake.
//
// The one-time cost is that HEALTH_CHECK_SECRET must itself be set from the
// dashboard, which is the trip this endpoint exists to avoid. Paid once rather
// than once per secret, and unavoidable: an endpoint that hands its
// configuration to an anonymous caller is the thing being fixed.
//
// PRESENCE ONLY, NEVER VALUES. Everything below is Boolean(). Do not be tempted
// to echo a prefix "just to check the right one is set" — a prefix is enough to
// confirm a guess.
// -----------------------------------------------------------------------------

// Length-independent comparison. The secret is high-entropy and this is over
// the network, so a timing attack is not realistic, but not leaking a
// comparison costs five lines.
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// Actual credentials. Anything here leaking would be an incident.
function secretPresence() {
  return {
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),

    // Two DIFFERENT Mailgun credentials: the sending API key, and the webhook
    // signing key that verifies inbound events. Confusing them is easy and the
    // failure is silent, so both are listed.
    MAILGUN_API_KEY: Boolean(process.env.MAILGUN_API_KEY),
    MAILGUN_WEBHOOK_SIGNING_KEY: Boolean(process.env.MAILGUN_WEBHOOK_SIGNING_KEY),

    // Inbound webhook shared secrets.
    LEAD_INTAKE_SECRET: Boolean(process.env.LEAD_INTAKE_SECRET),
    MGT_WEBHOOK_SECRET: Boolean(process.env.MGT_WEBHOOK_SECRET),
    BRAIN_WEBHOOK_SECRET: Boolean(process.env.BRAIN_WEBHOOK_SECRET),
    OPS_SNAPSHOT_KEY: Boolean(process.env.OPS_SNAPSHOT_KEY),

    // Third-party API keys.
    PLAUSIBLE_API_KEY: Boolean(process.env.PLAUSIBLE_API_KEY),

    // This endpoint's own gate. Listed because its absence is meaningful: it is
    // why a caller sees detail "unavailable" rather than an inventory.
    HEALTH_CHECK_SECRET: Boolean(process.env.HEALTH_CHECK_SECRET),
  };
}

// Required configuration that is NOT secret. Kept separate so the word "secret"
// stays honest, but still reported: an unset BRAIN_ORCHESTRATE_URL breaks
// draft generation just as surely as a missing key, and finding that out is the
// whole point of this route.
function configPresence() {
  return {
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL),
    BRAIN_ORCHESTRATE_URL: Boolean(process.env.BRAIN_ORCHESTRATE_URL),
    MAKE_PARTNER_SYNC_URL: Boolean(process.env.MAKE_PARTNER_SYNC_URL),
    MAKE_GMAIL_SYNC_WEBHOOK_URL: Boolean(process.env.MAKE_GMAIL_SYNC_WEBHOOK_URL),
  };
}

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // `ok` means LIVENESS, and only that: this Worker is running and
        // serving. It is deliberately not a readiness aggregate, because the
        // ungated response goes to anonymous callers and a false there would
        // announce that something on this Worker is misconfigured, which is the
        // leak the gate exists to prevent. Readiness is reported as `ready`,
        // behind the gate, where the caller has already proved they may know.
        const bare = { ok: true, worker: "portal-mygreektax" };
        const noStore = { headers: { "cache-control": "no-store" } };

        const expected = process.env.HEALTH_CHECK_SECRET;
        const provided = request.headers.get("x-health-check-secret");

        // No secret configured: liveness only, never the inventory. Fails
        // closed, so forgetting to set HEALTH_CHECK_SECRET cannot recreate the
        // open endpoint this gate was added to remove.
        if (!expected) {
          console.warn("[health] HEALTH_CHECK_SECRET not configured; detail withheld");
          return Response.json({ ...bare, detail: "unavailable" }, noStore);
        }

        // Identical answer for a missing header and a wrong one, so an
        // unauthenticated caller learns neither that a gate exists nor what it
        // guards.
        if (!provided || !secretsMatch(provided, expected)) {
          return Response.json({ ...bare, detail: "unavailable" }, noStore);
        }

        const secrets = secretPresence();
        const config = configPresence();

        // /webhooks/conversation-log accepts EITHER shared secret during the
        // Make migration, so it is protected as long as one of them exists.
        // Requiring MGT_WEBHOOK_SECRET specifically would report the route dark
        // while it is in fact authenticating every caller, which is the worst
        // possible first impression for an observability tool: a false alarm on
        // the thing it was built to watch.
        const conversationLogReady = secrets.MGT_WEBHOOK_SECRET || secrets.LEAD_INTAKE_SECRET;
        const conversationLogAuth = secrets.MGT_WEBHOOK_SECRET
          ? secrets.LEAD_INTAKE_SECRET
            ? "both"
            : "mgt"
          : secrets.LEAD_INTAKE_SECRET
            ? "lead-intake-legacy"
            : "none";

        // Secrets whose absence stops a route dead rather than degrading it.
        // Everything else can be missing without breaking a request path that
        // is currently in use.
        const required = {
          SUPABASE_URL: config.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: secrets.SUPABASE_SERVICE_ROLE_KEY,
          MAILGUN_WEBHOOK_SIGNING_KEY: secrets.MAILGUN_WEBHOOK_SIGNING_KEY,
          LEAD_INTAKE_SECRET: secrets.LEAD_INTAKE_SECRET,
          // Not MGT_WEBHOOK_SECRET on its own, for the reason above.
          CONVERSATION_LOG_AUTH: conversationLogReady,
        };
        const missing = Object.entries(required)
          .filter(([, present]) => !present)
          .map(([name]) => name);

        return Response.json(
          {
            ...bare,
            // The readiness answer `ok` deliberately is not. False means at
            // least one hard requirement is unset; `missing` names which.
            ready: missing.length === 0,
            missing,
            secrets,
            config,
            // Not secret, and useful to read back: these decide where alerts
            // are sent from and to. Behind the gate regardless, since there is
            // no reason to volunteer configuration to an anonymous caller.
            mailgunDomain: process.env.MAILGUN_DOMAIN || "mygreektax.eu",
            mailgunAlertTo: process.env.MAILGUN_ALERT_TO || "jim@mygreektax.eu",
            routes: {
              // False means /webhooks/mailgun-events rejects everything: no
              // bounce suppression, no complaint alerts, no conversation
              // capture.
              mailgunEventsReady: secrets.MAILGUN_WEBHOOK_SIGNING_KEY,
              // False means /webhooks/conversation-log rejects everything.
              // True on EITHER secret, because that route dual-accepts during
              // the Make migration. conversationLogAuth names which is doing
              // the work: "lead-intake-legacy" means the migration is still
              // outstanding, "mgt" means it is finished and the legacy branch
              // in that route can be deleted.
              conversationLogReady,
              conversationLogAuth,
            },
          },
          noStore,
        );
      },
    },
  },
});
