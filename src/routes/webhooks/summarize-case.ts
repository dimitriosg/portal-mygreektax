import { waitUntil } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /webhooks/summarize-case
//
// Async. The Brain summary takes longer than API Gateway's 30s response cap,
// so we fire the request and return 202 immediately. The Lambda keeps running
// and writes the result to case_summaries. The client polls that table.
//
// We return the current generated_at as a baseline so the client can tell when
// a genuinely new summary has landed.

type Body = {
  case_serial_id?: unknown;
  conversation_id?: unknown;
};

function readString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export const Route = createFileRoute("/webhooks/summarize-case")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const orchestrateUrl = process.env.BRAIN_ORCHESTRATE_URL;
        const brainSecret = process.env.BRAIN_WEBHOOK_SECRET;

        if (!orchestrateUrl || !brainSecret) {
          console.error("[summarize-case] BRAIN_ORCHESTRATE_URL or BRAIN_WEBHOOK_SECRET not set");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

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

        const caseSerialId = readString(body.case_serial_id);
        const conversationIdInput = readString(body.conversation_id);
        if (!caseSerialId && !conversationIdInput) {
          return Response.json(
            { error: "case_serial_id or conversation_id is required" },
            { status: 400 },
          );
        }

        const lookup = supabaseAdmin
          .from("brain_conversations")
          .select("id, case_serial_id")
          .limit(1);
        const { data: convRows, error: convError } = conversationIdInput
          ? await lookup.eq("id", conversationIdInput)
          : await lookup.eq("case_serial_id", caseSerialId!);

        if (convError) {
          console.error("[summarize-case] conversation lookup failed", { convError });
          return Response.json({ error: "Lookup failed", detail: convError.message }, { status: 500 });
        }
        const conversation = convRows?.[0];
        if (!conversation) {
          return Response.json({ error: "Case not found" }, { status: 404 });
        }

        // Baseline: what the client already has. Anything newer than this is a
        // fresh result.
        const { data: existing } = await supabaseAdmin
          .from("case_summaries")
          .select("generated_at")
          .eq("case_id", conversation.id)
          .maybeSingle();

        const previousGeneratedAt =
          (existing as { generated_at: string | null } | null)?.generated_at ?? null;

        // Fire and do NOT await. API Gateway invokes the Lambda synchronously,
        // so the Lambda runs to completion even if we drop the connection.
        // The catch is required: an unhandled rejection would take down the
        // isolate.
        waitUntil(
          fetch(orchestrateUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-brain-secret": brainSecret,
            },
            body: JSON.stringify({
              record: {
                case_id: conversation.id,
                case_serial_id: conversation.case_serial_id,
                sender: "portal_summarize",
                mode: "summarize",
                event_type: "summary_requested",
              },
            }),
          }).catch((error) => {
            console.error("[summarize-case] background call to Brain failed", { error });
          }),
        );

        return Response.json(
          {
            ok: true,
            accepted: true,
            conversationId: conversation.id,
            caseSerialId: conversation.case_serial_id,
            previousGeneratedAt,
          },
          { status: 202 },
        );
      },
    },
  },
});
