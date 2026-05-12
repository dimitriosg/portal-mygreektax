import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logActivityEvent } from "./activity.server";
import { resolveUserAccess } from "./access-context.server";

/**
 * Called by the client right after a successful login (deduped per session)
 * so we can include partner logins in the daily/weekly admin summary.
 */
export const recordPartnerLogin = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, claims } = context;
    const email = (claims.email as string | undefined) ?? null;

    const access = await resolveUserAccess({ userId, email });
    if (access.accessStatus === "verification_failed") {
      return { ok: false, disabled: false, verificationFailed: true } as const;
    }
    const { partner } = access;

    if (access.isPartner && !access.isAdmin && partner?.disabled_at) {
      try {
        await supabaseAdmin.auth.admin.signOut(userId, "global");
      } catch (e) {
        console.error("[recordPartnerLogin] disabled signOut failed", e);
      }
      return { ok: false, disabled: true } as const;
    }

    await logActivityEvent({
      eventType: "partner_login",
      actorUserId: userId,
      actorEmail: email,
      actorName: partner?.full_name ?? email,
      metadata: { role: access.accessType },
    });
    return { ok: true, disabled: false } as const;
  });
