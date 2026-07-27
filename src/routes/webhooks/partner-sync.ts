import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /webhooks/partner-sync
//
// Triggers the "[BRAIN] Gmail Sync (partner)" Make scenario once per active
// partner address, scoped to a single case.
//
// Why the server picks the addresses: the browser must not get to say whose
// mailbox to search. The list comes from partner_profiles where disabled_at is
// null, so removing a partner there removes them from every future sync.
//
// Why ref_core rather than the full serial: case-reply.ts writes the reference
// line as "MGT-REF-ID: [CS001-CLT0037]", stripping the MGT- prefix. A Gmail
// search for the full serial would match nothing. The Make scenario searches
//   (from:X OR to:X) "<ref_core>"
// so only mail carrying this case's code is imported. Without that term a sync
// would pull the partner's correspondence about every other client into this
// case.
//
// Env (Cloudflare Worker):
//   MAKE_PARTNER_SYNC_URL -- the webhook URL of scenario 6718804

type Body = { conversation_id?: unknown };

function readString(v: unknown, max = 200): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

export const Route = createFileRoute("/webhooks/partner-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const hookUrl = process.env.MAKE_PARTNER_SYNC_URL;
        if (!hookUrl) {
          console.error("[partner-sync] MAKE_PARTNER_SYNC_URL not set");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        // Admin session required: this is a human-triggered action.
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

        const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
        if (userError || !userData?.user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const conversationId = readString(body.conversation_id);
        if (!conversationId) {
          return Response.json({ error: "conversation_id is required" }, { status: 400 });
        }

        const { data: convRows, error: convError } = await supabaseAdmin
          .from("brain_conversations")
          .select("id, case_serial_id")
          .eq("id", conversationId)
          .limit(1);

        if (convError) {
          return Response.json(
            { error: "Lookup failed", detail: convError.message },
            { status: 500 },
          );
        }

        const conversation = convRows?.[0];
        if (!conversation) {
          return Response.json({ error: "Case not found" }, { status: 404 });
        }

        const serial = conversation.case_serial_id as string | null;
        if (!serial) {
          return Response.json(
            {
              error: "This case has no case code",
              detail:
                "Partner mail is matched by the case code in the message, so a case without one cannot be synced.",
            },
            { status: 422 },
          );
        }

        const refCore = serial.replace(/^MGT-/i, "");

        const { data: partners, error: partnerError } = await supabaseAdmin
          .from("partner_profiles")
          .select("email, full_name")
          .is("disabled_at", null);

        if (partnerError) {
          return Response.json(
            { error: "Partner lookup failed", detail: partnerError.message },
            { status: 500 },
          );
        }

        const addresses = (partners ?? [])
          .map((p) => (p as { email: string | null }).email)
          .filter((e): e is string => !!e && e.includes("@"));

        if (addresses.length === 0) {
          return Response.json(
            { error: "No active partners", detail: "No partner profile has a usable email." },
            { status: 422 },
          );
        }

        // One call per address. Make's webhook takes a single email per run, and
        // firing them separately keeps one bad address from killing the rest.
        const results = await Promise.all(
          addresses.map(async (address) => {
            try {
              const res = await fetch(hookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  email: address,
                  case_serial_id: serial,
                  ref_core: refCore,
                }),
              });
              return { address, ok: res.ok, status: res.status };
            } catch (error) {
              console.error("[partner-sync] webhook call failed", { address, error });
              return { address, ok: false, status: 0 };
            }
          }),
        );

        const started = results.filter((r) => r.ok).length;

        return Response.json(
          {
            ok: started > 0,
            started,
            attempted: addresses.length,
            caseSerialId: serial,
            refCore,
            results,
          },
          { status: started > 0 ? 202 : 502 },
        );
      },
    },
  },
});
