import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivityEvent } from "./activity.server";

/**
 * Called by the client right after a successful login (deduped per session)
 * so we can include partner logins in the daily/weekly admin summary.
 */
export const recordPartnerLogin = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, claims } = context;
    const email = (claims.email as string | undefined) ?? null;

    const [{ data: roles }, { data: partner }] = await Promise.all([
      supabaseAdmin.from("user_roles").select("role").eq("user_id", userId),
      supabaseAdmin
        .from("partner_profiles")
        .select("full_name")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
    const isAdmin = !!roles?.some((r) => r.role === "admin");
    const isPartner = !!roles?.some((r) => r.role === "partner");
    const role = isAdmin ? "admin" : isPartner ? "partner" : "user";

    await logActivityEvent({
      eventType: "partner_login",
      actorUserId: userId,
      actorEmail: email,
      actorName: partner?.full_name ?? email,
      metadata: { role },
    });
    return { ok: true };
  });