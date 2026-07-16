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
      POST: async ({ request }) => {
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
        const direction = readString(b.direction, 20); 
        const caseSerialId = readString(b.case_serial_id, 100); // e.g. 'CS001-CLT0001'
        const textContent = readString(b.text_content, 100000); 

        if (!email || !EMAIL_PATTERN.test(email)) {
          return Response.json({ error: "Valid email is required" }, { status: 400 });
        }

        try {
          // 1. Core Lookup: Find the basic client record row by email matching
          const { data: matches, error: findError } = await supabaseAdmin
            .from("clients")
            .select("id, full_name, email")
            .ilike("email", email)
            .limit(1);

          if (findError) throw new Error(`Client lookup failed: ${findError.message}`);
          const client = matches?.[0];

          if (!client) {
            return Response.json({ found: false, message: "No matching email profile found" });
          }

          // 2. Stamp active human operational metrics
          await supabaseAdmin
            .from("clients")
            .update({ last_activity: new Date().toISOString() })
            .eq("id", client.id);

          // =========================================================
          // 🧠 THE CORE AI BRAIN BRIDGE MAPPING LAYER
          // =========================================================
          if (textContent) {
            const isPartner = caseSerialId ? true : false;
            
            // CRITICAL FIX: Establish your true operational Case UUID tracking vector
            let targetCaseId = client.id; 

            // If Make passed an email token, query your directory to find its master tracking UUID
            if (caseSerialId) {
              const { data: directoryRow } = await supabaseAdmin
                .from("cases_directory")
                .select("id")
                .eq("case_serial_id", caseSerialId)
                .single();
              
              if (directoryRow) {
                targetCaseId = directoryRow.id;
              }
            }

            // Write the parsed email payload straight into the core timeline table
            const { error: timelineError } = await supabaseAdmin
              .from("case_timeline")
              .insert({
                case_id: targetCaseId,
                case_serial_id: caseSerialId || null,
                event_type: isPartner ? "partner_reply" : "lead_received",
                sender: isPartner ? "partner" : "customer",
                payload: { text: textContent }
              });

            if (timelineError) {
              console.error("[conversation-log] Supabase timeline sync failed:", timelineError);
            } else {
              console.log(`[conversation-log] Successfully logged message for Case ID: ${targetCaseId}`);
            }
          }
          // =========================================================

          return Response.json({
            found: true,
            clientId: client.id,
            clientName: client.full_name,
            direction: direction ?? null,
          });
        } catch (error) {
          console.error("[conversation-log] runtime processing failed", { error });
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
