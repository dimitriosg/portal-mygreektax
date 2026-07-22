import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /webhooks/summarize-case
//
// On-demand case summary. Mirrors generate-draft: admin session required, then
// it calls the same Brain endpoint with mode "summarize". The Brain reads the
// full thread plus the approved knowledge base, writes the summary to
// case_summaries, and returns it. One AI call per click, same cost control as
// Generate draft.
//
// Env (already present, same as generate-draft):
//   BRAIN_ORCHESTRATE_URL, BRAIN_WEBHOOK_SECRET

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

        // Admin-only: verify the caller's Supabase session.
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

        // Resolve the conversation so we hand the Brain a stable case_id.
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

        try {
          const brainResponse = await fetch(orchestrateUrl, {
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
          });

          const rawText = await brainResponse.text();
          let parsed: unknown = null;
          try {
            parsed = rawText ? JSON.parse(rawText) : null;
          } catch {
            parsed = rawText;
          }

          if (!brainResponse.ok) {
            console.error("[summarize-case] Brain returned non-2xx", {
              status: brainResponse.status,
              body: parsed,
            });
            return Response.json(
              {
                error: "Summary generation failed",
                status: brainResponse.status,
                detail:
                  typeof parsed === "object" && parsed !== null && "error" in parsed
                    ? (parsed as Record<string, unknown>).error
                    : rawText.slice(0, 500),
              },
              { status: 502 },
            );
          }

          const summary =
            typeof parsed === "object" && parsed !== null && "summary" in parsed
              ? (parsed as Record<string, unknown>).summary
              : null;

          return Response.json({
            ok: true,
            conversationId: conversation.id,
            caseSerialId: conversation.case_serial_id,
            summary,
          });
        } catch (error) {
          console.error("[summarize-case] call to Brain failed", { error });
          return Response.json(
            {
              error: "Could not reach the Brain",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 502 },
          );
        }
      },
    },
  },
});
