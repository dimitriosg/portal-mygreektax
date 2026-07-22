import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// POST /webhooks/gmail-sync
//
// Admin-only. Kicks off the "[BRAIN] Gmail Sync" Make scenario for one customer.
// The scenario searches your Gmail for that address and posts each message to
// /webhooks/conversation-log, which dedups on the Gmail message id and backdates
// occurred_at. This route only triggers the run; imported messages arrive
// asynchronously and surface on the case through the existing brain_events
// realtime subscription.
//
// Env (already present, plus one new):
//   SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
//   MAKE_GMAIL_SYNC_WEBHOOK_URL  (new Cloudflare secret: the scenario's webhook)
// -----------------------------------------------------------------------------

let cachedClient: SupabaseClient | undefined;
function getSupabase(): { client: SupabaseClient } | { configError: string } {
  if (cachedClient) return { client: cachedClient };
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { configError: "Supabase env not configured" };
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client: cachedClient };
}

function readString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const Route = createFileRoute("/webhooks/gmail-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 1. Authenticate the caller (admin only).
        const authHeader = request.headers.get("authorization") || "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) return Response.json({ error: "Not authenticated" }, { status: 401 });

        const supa = getSupabase();
        if ("configError" in supa) {
          return Response.json(
            { error: "Server misconfigured", detail: supa.configError },
            { status: 500 },
          );
        }
        const supabase = supa.client;

        const { data: userData, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !userData?.user) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }
        const { data: roleRow } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "admin")
          .limit(1);
        if (!roleRow || roleRow.length === 0) {
          return Response.json({ error: "Not authorized (admin role required)" }, { status: 403 });
        }

        // 2. Read and validate input.
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const b = (raw ?? {}) as Record<string, unknown>;
        const email = readString(b.email, 200);
        const caseSerialId = readString(b.caseSerialId, 100);
        const conversationId = readString(b.conversationId, 100);

        if (!email || !EMAIL_RE.test(email)) {
          return Response.json({ error: "Valid customer email required" }, { status: 400 });
        }

        const webhookUrl = process.env.MAKE_GMAIL_SYNC_WEBHOOK_URL;
        if (!webhookUrl) {
          return Response.json(
            {
              error: "Server misconfigured",
              detail:
                "MAKE_GMAIL_SYNC_WEBHOOK_URL is not set. Add the Gmail Sync scenario webhook as a Secret in Cloudflare, then redeploy.",
            },
            { status: 500 },
          );
        }

        // 3. Trigger the Make scenario. Fire it and return; the scenario writes
        //    back to conversation-log on its own schedule.
        try {
          const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email,
              case_serial_id: caseSerialId ?? "",
              conversation_id: conversationId ?? "",
            }),
          });
          if (!res.ok) {
            const detail = await res.text().catch(() => "");
            console.error("[gmail-sync] make webhook rejected:", res.status, detail);
            return Response.json(
              { error: "Sync could not start", detail: `Make responded ${res.status}` },
              { status: 502 },
            );
          }
          return Response.json({ ok: true, triggered: true });
        } catch (error) {
          console.error("[gmail-sync] error", { error });
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      },
    },
  },
});
