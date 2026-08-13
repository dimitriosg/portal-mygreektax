import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export type AppendixRow = Database["public"]["Views"]["v_partner_appendix"]["Row"];

export const APPENDIX_FORBIDDEN_MESSAGE = "Forbidden";

// Παράρτημα Α, the per-partner wholesale rate card.
//
// Every query below runs on context.supabase, the per-request client that
// requireSupabaseAuth builds from the signed-in user's JWT, so the RLS policies
// on partner_rate_cards / partner_profiles / user_roles apply to the caller.
// The service-role admin client is deliberately not imported here: it bypasses
// RLS, and this feature's whole security model is that Postgres, not the UI,
// decides who sees which wholesale line.
export const getAppendix = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    // Gate: admin, or partner whose profile is not disabled. Checked here so
    // the request 403s before any rate data is queried; the RLS policy on
    // partner_rate_cards enforces the same rule underneath in case this gate
    // is ever wrong. user_roles and partner_profiles are self-readable under
    // their own RLS, so the caller's JWT is enough to resolve the answer.
    const [rolesRes, profileRes] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase
        .from("partner_profiles")
        .select("user_id, full_name, disabled_at")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);

    if (rolesRes.error || profileRes.error) {
      console.error("[appendix] access check failed", {
        userId,
        rolesError: rolesRes.error?.message ?? null,
        profileError: profileRes.error?.message ?? null,
      });
      throw new Error("Could not verify portal access. Please contact the administrator.");
    }

    const roles = (rolesRes.data ?? []).map((row) => row.role);
    const isAdmin = roles.includes("admin");
    const isActivePartner =
      roles.includes("partner") && !!profileRes.data && profileRes.data.disabled_at === null;

    // Thrown as an Error, not a Response: TanStack Start hands a thrown
    // Response back to the caller as a successful raw result, so the loader
    // would never see it as a failure. The Error's message survives
    // serialization and is what the route's error component matches on;
    // setResponseStatus keeps the actual HTTP status a 403.
    if (!isAdmin && !isActivePartner) {
      setResponseStatus(403);
      throw new Error(APPENDIX_FORBIDDEN_MESSAGE);
    }

    const { data, error } = await supabase
      .from("v_partner_appendix")
      .select("*")
      .order("category")
      .order("service_code");

    if (error) {
      console.error("[appendix] view query failed", { userId, message: error.message });
      throw new Error("Could not load the rate card. Please try again.");
    }

    const rows: AppendixRow[] = data ?? [];

    // A partner's query returns only their own lines. An admin's returns every
    // partner's lines, so resolve display names for the per-partner headings;
    // partner_profiles is admin-readable under its own RLS.
    let partnerNames: Record<string, string | null> = {};
    if (isAdmin) {
      const partnerIds = [
        ...new Set(rows.map((row) => row.partner_user_id).filter((id): id is string => !!id)),
      ];
      if (partnerIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from("partner_profiles")
          .select("user_id, full_name")
          .in("user_id", partnerIds);
        if (profilesError) {
          console.error("[appendix] partner name lookup failed", {
            userId,
            message: profilesError.message,
          });
        }
        partnerNames = Object.fromEntries(
          (profiles ?? []).map((profile) => [profile.user_id, profile.full_name]),
        );
      }
    } else if (profileRes.data) {
      partnerNames = { [userId]: profileRes.data.full_name };
    }

    return { isAdmin, viewerUserId: userId, rows, partnerNames };
  });
