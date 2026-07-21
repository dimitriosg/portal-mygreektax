import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Create (or resolve) a case from the portal, given an email.
//
// Calls resolve_case_for_inbound(), the single authority for client/case
// identity, so this never creates a duplicate client:
//   - email is a NEW person   -> creates the client (lead) AND the case
//   - email is an EXISTING lead -> reuses that lead, opens/links the case
//   - the lead already has an open case -> returns it (no duplicate case)
//
// That find-or-create behaviour is the reason we route through the resolver
// instead of a plain client insert: "New case" is safe to use whether or not
// the person is already in /leads.
//
// Auth: the browser sends the caller's Supabase access token as a Bearer
// header. The route verifies it and requires the 'admin' role.
//
// Env (already present):
//   SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
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

export const Route = createFileRoute("/webhooks/case-create")({
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
        const name = readString(b.name, 200);
        const nationality = readString(b.nationality, 100);

        if (!email || !EMAIL_RE.test(email)) {
          return Response.json({ error: "Valid email required" }, { status: 400 });
        }

        // 3. Find-or-create the client + case via the resolver.
        //    p_provider is passed only to select the 7-arg overload; with no
        //    message, no brain_events row is logged, so the value is inert.
        const { data, error } = await supabase.rpc("resolve_case_for_inbound", {
          p_email: email,
          p_name: name ?? null,
          p_nationality: nationality ?? null,
          p_provider: "portal_new_case",
        });

        if (error) {
          console.error("[case-create] resolve failed:", error.message);
          return Response.json(
            { error: "Could not create the case", detail: error.message },
            { status: 502 },
          );
        }

        const row = Array.isArray(data) ? data[0] : data;
        if (!row?.out_conversation_id) {
          return Response.json({ error: "Resolver returned no case" }, { status: 500 });
        }

        return Response.json({
          ok: true,
          conversationId: row.out_conversation_id,
          caseSerialId: row.out_case_serial_id ?? null,
          isNewCase: Boolean(row.out_is_new_case),
          isNewCustomer: Boolean(row.out_is_new_customer),
        });
      },
    },
  },
});
