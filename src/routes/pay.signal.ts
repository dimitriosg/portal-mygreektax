import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PAYMENT_TOKEN_PATTERN } from "@/lib/payments.functions";

// -----------------------------------------------------------------------------
// POST /pay/signal
//
// Public beacon target for the /pay/$token page. The page fires portal_view
// from JS on load (never from the SSR loader — Gmail's image proxy, Outlook
// SafeLinks and antivirus scanners all prefetch links) and portal_claim when
// the client taps "I've paid". This route validates the token server-side and
// forwards the signal to n8n, which writes the payment_signals row, bumps
// open_count on a view and sends the Telegram message on a claim. Repeat
// claims are deduplicated by n8n (24h window), not here.
//
// The response is always { ok: true } for well-formed requests: a stranger
// probing tokens must not learn which ones exist, and a failed signal must
// never break the page for the client.
//
// Env (new Cloudflare secrets):
//   N8N_PAYMENT_SIGNAL_URL     the n8n webhook URL
//   N8N_PAYMENT_SIGNAL_SECRET  value of the X-Mgt-Signal-Secret header
// -----------------------------------------------------------------------------

const SIGNAL_SOURCES = ["portal_view", "portal_claim"] as const;
type SignalSource = (typeof SIGNAL_SOURCES)[number];

function isSignalSource(v: unknown): v is SignalSource {
  return typeof v === "string" && (SIGNAL_SOURCES as readonly string[]).includes(v);
}

export const Route = createFileRoute("/pay/signal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        const body = (raw ?? {}) as Record<string, unknown>;
        const token = typeof body.token === "string" ? body.token.trim() : "";
        const source = body.source;

        if (!isSignalSource(source) || !PAYMENT_TOKEN_PATTERN.test(token)) {
          // Neutral response: don't confirm or deny anything about the token.
          return Response.json({ ok: true });
        }

        try {
          const { data: row, error } = await supabaseAdmin
            .from("payment_tokens")
            .select("token, amount, currency, kind, revoked_at, expires_at, paid_at")
            .eq("token", token)
            .maybeSingle();
          if (error || !row) return Response.json({ ok: true });

          const expired = !!row.expires_at && new Date(row.expires_at).getTime() < Date.now();
          if (row.revoked_at || expired || row.paid_at) return Response.json({ ok: true });

          const webhookUrl = process.env.N8N_PAYMENT_SIGNAL_URL;
          const secret = process.env.N8N_PAYMENT_SIGNAL_SECRET;
          if (!webhookUrl || !secret) {
            console.error("[pay-signal] N8N_PAYMENT_SIGNAL_URL / _SECRET not configured");
            return Response.json({ ok: true });
          }

          const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Mgt-Signal-Secret": secret,
            },
            body: JSON.stringify({
              source,
              token: row.token,
              amount: row.amount.toFixed(2),
              currency: row.currency,
              country: request.headers.get("cf-ipcountry") ?? undefined,
              metadata: { kind: row.kind },
            }),
          });
          if (!res.ok) {
            console.error("[pay-signal] n8n webhook rejected", { status: res.status, source });
          }
        } catch (error) {
          console.error("[pay-signal] error", { error });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
