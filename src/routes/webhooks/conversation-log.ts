import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export const Route = createFileRoute("/webhooks/conversation-log")({
  server: {
    handlers: {
      POST: async ({ request, context }) => { // 🧠 Context binding passed here
        // Extract the environment variable string parameter directly from the active runtime context
        const secret = (context as any)?.env?.LEAD_INTAKE_SECRET || process.env.LEAD_INTAKE_SECRET;
        
        if (!secret) {
          console.error("[conversation-log] LEAD_INTAKE_SECRET not resolved in active context layer");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const provided = request.headers.get("x-lead-intake-secret");
        if (!provided || provided !== secret) {
          console.error("[conversation-log] rejected: missing or invalid shared secret");
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (typeof body !== "object" || body === null) {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const b = body as Record<string, unknown>;

        const email = readString(b.email, 200);
        const direction = readString(b.direction, 20); // "Inbound" | "Outbound"
        const caseSerialId = readString(b.case_serial_id, 100); // 🧠 Added: Captures text tracking keys from Make
        const textContent = readString(b.text_content, 100000); // 🧠 Added: Captures clean email body string text

        if (!email || !EMAIL_PATTERN.test(email)) {
          return Response.json({ error: "Valid email is required" }, { status: 400 });
        }

        try {
          // 1. Core Lookup Loop: Try to locate the main Client profile row first
          const { data: matches, error: findError } = await supabaseAdmin
            .from("clients")
            .select("id, full_name, email")
            .ilike("email", email)
            .limit(1);

          if (findError) {
            throw new Error(`client lookup failed: ${findError.message}`);
          }

          const client = matches?.[0];
          if (!client) {
            return Response.json({ found: false });
          }

          // 2. Update existing last activity timestamps
          const { error: updateError } = await supabaseAdmin
            .from("clients")
            .update({ last_activity: new Date().toISOString() })
            .eq("id", client.id);

          if (updateError) {
            throw new Error(`last_activity stamp failed: ${updateError.message}`);
          }

          // =========================================================
          // 🚀 THE AI ENGINE ENTRYPOINT: POPULATE CASE TIMELINE
          // =========================================================
          if (textContent) {
            // Determine the structural identity categories dynamically
            const isPartner = caseSerialId ? true : false;
            
            // Map your human serial case index key down to your true underlying database UUID
            // If the table 'cases_directory' isn't queried yet, fallback straight onto client.id
            const targetCaseId = client.id; 

            await supabaseAdmin.from("case_timeline").insert({
              case_id: targetCaseId,
              case_serial_id: caseSerialId || null,
              event_type: isPartner ? "partner_reply" : "lead_received",
              sender: isPartner ? "partner" : "customer",
              payload: { text: textContent }
            });
            console.log(`[conversation-log] Appended interaction to case timeline for ID: ${targetCaseId}`);
          }
          // =========================================================

          return Response.json({
            found: true,
            clientId: client.id,
            clientName: client.full_name,
            direction: direction ?? null,
          });
        } catch (error) {
          console.error("[conversation-log] failed", { error });
          return Response.json(
            {
              error: "Failed to process conversation log",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
