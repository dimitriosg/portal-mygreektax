import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 🧠 DYNAMIC CONFIGURATION RESOLVERS: Hardcoding your public URL as a fail-safe fallback
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://supabase.co";

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
        const caseSerialId = readString(b.case_serial_id, 100); 
        const textContent = readString(b.text_content, 100000); 

        if (!email || !EMAIL_PATTERN.test(email)) {
          return Response.json({ error: "Valid email is required" }, { status: 400 });
        }

        try {
          // Use your clean project URL variable string instead of volatile system objects
          console.log("[conversation-log] Target Supabase Cluster endpoint:", SUPABASE_URL);

          // 1. Locate Client Row profile mappings
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

          // 2. Refresh target tracking activity indexes
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
            const isPartner = caseSerialId ? true : false;
            
            // Map the identifier dynamically down to your target case profile
            let targetCaseId = client.id; 

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
              console.error("[conversation-log] Supabase timeline insert failed:", timelineError);
            } else {
              console.log(`[conversation-log] Successfully logged interaction payload for case ID: ${targetCaseId}`);
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
          console.error("[conversation-log] failed processing event", { error });
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
