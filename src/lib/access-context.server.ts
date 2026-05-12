import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

export type AccessType = "admin" | "partner" | "unauthorized";
export type AccessStatus = "resolved" | "unauthorized" | "verification_failed";

type PartnerProfile = Database["public"]["Tables"]["partner_profiles"]["Row"];
type UserRole = Database["public"]["Tables"]["user_roles"]["Row"]["role"];

export const ACCESS_VERIFICATION_ERROR_MESSAGE =
  "Could not verify portal access. Please contact the administrator.";

export type UserAccessContext = {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  isPartner: boolean;
  accessType: AccessType;
  accessStatus: AccessStatus;
  accessError: string | null;
  partner: PartnerProfile | null;
};

function normalizeEmail(email: string | null | undefined): string | null {
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
}

function createAccessContext(input: {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  isPartner: boolean;
  partner: PartnerProfile | null;
  accessStatus: AccessStatus;
  accessError?: string | null;
}): UserAccessContext {
  const accessType: AccessType = input.isAdmin
    ? "admin"
    : input.isPartner
      ? "partner"
      : "unauthorized";

  console.info("[auth] context resolved", {
    userId: input.userId,
    email: input.email,
    isAdmin: input.isAdmin,
    isPartner: input.isPartner,
    accessType,
    accessStatus: input.accessStatus,
    accessError: input.accessError ?? null,
  });

  return {
    userId: input.userId,
    email: input.email,
    isAdmin: input.isAdmin,
    isPartner: input.isPartner,
    accessType,
    accessStatus: input.accessStatus,
    accessError: input.accessError ?? null,
    partner: input.partner,
  };
}

function createVerificationFailureContext(input: {
  userId: string;
  email: string | null;
  isPartner?: boolean;
  partner: PartnerProfile | null;
}): UserAccessContext {
  return createAccessContext({
    userId: input.userId,
    email: input.email,
    isAdmin: false,
    isPartner: input.isPartner ?? !!input.partner,
    partner: input.partner,
    accessStatus: "verification_failed",
    accessError: ACCESS_VERIFICATION_ERROR_MESSAGE,
  });
}

export async function listAdminEmails(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin");
  if (error) {
    console.error("[auth] failed to list admin emails", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    throw new Error(ACCESS_VERIFICATION_ERROR_MESSAGE);
  }

  const resolvedEmails = await Promise.all(
    (data ?? []).map(async ({ user_id }) => {
      const { data: authUser, error: authUserError } =
        await supabaseAdmin.auth.admin.getUserById(user_id);

      if (authUserError) {
        console.error("[auth] failed to resolve admin email", {
          userId: user_id,
          message: authUserError.message,
        });
        return null;
      }

      return normalizeEmail(authUser.user?.email);
    }),
  );

  const emails = new Set(resolvedEmails.filter((email): email is string => !!email));
  return Array.from(emails);
}

export async function resolveUserAccess(input: {
  userId: string;
  email?: string | null;
}): Promise<UserAccessContext> {
  const email = normalizeEmail(input.email);

  const [{ data: roleRows, error: rolesError }, { data: partner, error: partnerError }] =
    await Promise.all([
      supabaseAdmin.from("user_roles").select("role").eq("user_id", input.userId),
      supabaseAdmin.from("partner_profiles").select("*").eq("user_id", input.userId).maybeSingle(),
    ]);

  if (rolesError || partnerError) {
    if (rolesError) {
      console.error("[auth] failed to load user roles", {
        userId: input.userId,
        message: rolesError.message,
        details: rolesError.details,
        hint: rolesError.hint,
        code: rolesError.code,
      });
    }

    if (partnerError) {
      console.error("[auth] failed to load partner profile", {
        userId: input.userId,
        message: partnerError.message,
        details: partnerError.details,
        hint: partnerError.hint,
        code: partnerError.code,
      });
    }

    return createVerificationFailureContext({
      userId: input.userId,
      email,
      isPartner: !!partner,
      partner: partner ?? null,
    });
  }

  const roleSet = new Set<UserRole>((roleRows ?? []).map((row) => row.role));
  const isAdmin = roleSet.has("admin");
  const isPartner = roleSet.has("partner") || !!partner;

  return createAccessContext({
    userId: input.userId,
    email,
    isAdmin,
    isPartner,
    partner: partner ?? null,
    accessStatus: isAdmin || isPartner ? "resolved" : "unauthorized",
  });
}

export async function requireVerifiedAccess(input: {
  userId: string;
  email?: string | null;
}): Promise<UserAccessContext> {
  const access = await resolveUserAccess(input);
  if (access.accessStatus === "verification_failed") {
    throw new Error(access.accessError ?? ACCESS_VERIFICATION_ERROR_MESSAGE);
  }
  return access;
}

export async function requireAdminAccess(input: {
  userId: string;
  email?: string | null;
}): Promise<UserAccessContext> {
  const access = await requireVerifiedAccess(input);
  if (!access.isAdmin) throw new Error("Forbidden");
  return access;
}
