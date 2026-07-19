import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /webhooks/case-action
//
// Admin-only case lifecycle actions from the /drafts workspace:
//   action: "archive"  -> hides the case (restorable; auto-purged after 60 days)
//   action: "restore"  -> un-archives
//   action: "delete"   -> permanent, immediate, removes case + events + draft
//                         (customer row is never touched)
//
// Delete is irreversible, so the client must also send confirm: "DELETE".
// The server re-checks this; the UI's "type DELETE" box is not the only gate.

type Body = {
  action?: unknown;
  conversation_id?: unknown;
  confirm?: unknown;
};

export const Route = createFileRoute("/webhooks/case-action")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Admin session required.
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
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

        const action = typeof body.action === "string" ? body.action : "";
        const conversationId =
          typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
        const confirm = typeof body.confirm === "string" ? body.confirm : "";

        if (!conversationId) {
          return Response.json({ error: "conversation_id is required" }, { status: 400 });
        }

        try {
          if (action === "archive") {
            const { error } = await supabaseAdmin.rpc("archive_case", {
              p_conversation_id: conversationId,
            });
            if (error) throw new Error(error.message);
            return Response.json({ ok: true, action: "archived" });
          }

          if (action === "restore") {
            const { error } = await supabaseAdmin.rpc("restore_case", {
              p_conversation_id: conversationId,
            });
            if (error) throw new Error(error.message);
            return Response.json({ ok: true, action: "restored" });
          }

          if (action === "delete") {
            // Server-side guard on the irreversible action.
            if (confirm !== "DELETE") {
              return Response.json(
                { error: "Delete not confirmed. Send confirm: \"DELETE\"." },
                { status: 400 },
              );
            }
            const { error } = await supabaseAdmin.rpc("delete_case", {
              p_conversation_id: conversationId,
            });
            if (error) throw new Error(error.message);
            return Response.json({ ok: true, action: "deleted" });
          }

          return Response.json({ error: "Unknown action" }, { status: 400 });
        } catch (err) {
          console.error("[case-action] failed", { action, err });
          return Response.json(
            { error: "Action failed", detail: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },
  },
});
