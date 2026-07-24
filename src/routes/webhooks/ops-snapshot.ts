import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// GET /webhooks/ops-snapshot
//
// Read-only operational snapshot for the MGT Ops Snapshot tool in Make
// (scenario 6687502), which is exposed to Claude as an MCP tool.
//
// Why this route exists rather than Make calling Supabase directly:
// Make would then have to hold the service role key in a keychain, and any
// scenario in that team could reuse it for unrestricted database access.
// Here the service role key never leaves the Worker. Make holds only
// OPS_SNAPSHOT_KEY, which opens this one read-only route and nothing else.
//
// The route is machine-to-machine (no Supabase session), so it authenticates
// with a shared secret header instead of a bearer token:
//   x-ops-key: <OPS_SNAPSHOT_KEY>
//
// Env (Cloudflare Worker secret):
//   OPS_SNAPSHOT_KEY -- long random string, generated once, stored in Make
//                       as an API Key Auth keychain placed in the header
//                       under the name x-ops-key
//
// The underlying function public.mgt_ops_snapshot() is defined in
// supabase/migrations/ and is granted to service_role only. It returns
// aggregate counts plus case_serial_id values. No names, no emails, no
// pricing. Keep it that way: whatever this returns is visible to the AI
// client on the other end of the MCP connection.

export const Route = createFileRoute("/webhooks/ops-snapshot")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expected = process.env.OPS_SNAPSHOT_KEY;
        if (!expected) {
          console.error("[ops-snapshot] OPS_SNAPSHOT_KEY is not set");
          return Response.json(
            {
              error: "Server misconfigured",
              detail:
                "OPS_SNAPSHOT_KEY is not set. Add it as a Secret in Cloudflare, then redeploy.",
            },
            { status: 500 },
          );
        }

        const provided = request.headers.get("x-ops-key") ?? "";
        if (provided !== expected) {
          // Deliberately terse: no hint about which part was wrong.
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          // The generated Database types do not know about this function yet.
          // Cast the client, not the method: pulling .rpc off the lazy proxy
          // detaches it from its receiver and supabase-js then fails on
          // this.rest. Regenerate types and drop the cast on the next refresh.
          type RpcCaller = {
            rpc: (
              fn: string,
            ) => Promise<{ data: unknown; error: { message: string } | null }>;
          };

          const { data, error } = await (
            supabaseAdmin as unknown as RpcCaller
          ).rpc("mgt_ops_snapshot");

          if (error) {
            console.error("[ops-snapshot] rpc failed:", error.message);
            return Response.json(
              { error: "Snapshot failed", detail: error.message },
              { status: 502 },
            );
          }

          return Response.json(data ?? {}, {
            status: 200,
            headers: { "cache-control": "no-store" },
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error("[ops-snapshot] unexpected failure:", detail);
          return Response.json(
            { error: "Snapshot failed", detail },
            { status: 500 },
          );
        }
      },
    },
  },
});
