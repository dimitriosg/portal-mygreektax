import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

export type AccessType = "admin" | "partner" | "unauthorized";
export type AccessStatus = "resolved" | "unauthorized" | "verification_failed";

type PartnerProfile = Database["public"]["Tables"]["partner_profiles"]["Row"];
type AdminRow = Database["public"]["Tables"]["Admins"]["Row"];
type AdminSummary = Pick<AdminRow, "user_id" | "email">;

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
  admin: AdminSummary | null;
  partner: PartnerProfile | null;
};

function normalizeEmail(email: string | null | undefined): string | null {
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
}

function createAccessContext(input: {
  userId: string;
  email: string | null;
  admin: AdminSummary | null;
  partner: PartnerProfile | null;
  accessStatus: AccessStatus;
  accessError?: string | null;
}): UserAccessContext {
  const isAdmin = !!input.admin;
  const isPartner = !!input.partner;
  const accessType: AccessType = isAdmin ? "admin" : isPartner ? "partner" : "unauthorized";

  console.info("[auth] context resolved", {
    userId: input.userId,
    email: input.email,
    isAdmin,
    isPartner,
    accessType,
    accessStatus: input.accessStatus,
    accessError: input.accessError ?? null,
  });

  return {
    userId: input.userId,
    email: input.email,
    isAdmin,
    isPartner,
    accessType,
    accessStatus: input.accessStatus,
    accessError: input.accessError ?? null,
    admin: input.admin,
    partner: input.partner,
  };
}

function createVerificationFailureContext(input: {
  userId: string;
  email: string | null;
  partner: PartnerProfile | null;
}): UserAccessContext {
  return createAccessContext({
    userId: input.userId,
    email: input.email,
    admin: null,
    partner: input.partner,
    accessStatus: "verification_failed",
    accessError: ACCESS_VERIFICATION_ERROR_MESSAGE,
  });
}

async function queryAdminByUserId(userId: string): Promise<{
  admin: AdminSummary | null;
  verificationFailed: boolean;
}> {
  const { data, error } = await supabaseAdmin
    .from("Admins")
    .select("user_id, email")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[auth] admin lookup by user_id failed", {
      userId,
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    return { admin: null, verificationFailed: true };
  }

  return { admin: data, verificationFailed: false };
}

async function queryAdminByEmail(email: string): Promise<{
  admin: AdminSummary | null;
  verificationFailed: boolean;
}> {
  const { data, error } = await supabaseAdmin
    .from("Admins")
    .select("user_id, email")
    .ilike("email", email)
    .maybeSingle();

  if (error) {
    console.error("[auth] admin lookup by email failed", {
      email,
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    return { admin: null, verificationFailed: true };
  }

  return { admin: data, verificationFailed: false };
}

export async function listAdminEmails(): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("Admins").select("user_id, email");
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
    (data ?? []).map(async (row) => {
      const email = normalizeEmail(row.email);
      if (email) {
        return email;
      }

      if (!row.user_id) return null;

      const { data: authUser, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(
        row.user_id,
      );

      if (authUserError) {
        console.error("[auth] failed to resolve admin email from user_id", {
          userId: row.user_id,
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

  const { data: partner, error: partnerError } = await supabaseAdmin
    .from("partner_profiles")
    .select("*")
    .eq("user_id", input.userId)
    .maybeSingle();

  if (partnerError) {
    console.error("[auth] failed to load partner profile", {
      userId: input.userId,
      message: partnerError.message,
      details: partnerError.details,
      hint: partnerError.hint,
      code: partnerError.code,
    });
    return createVerificationFailureContext({
      userId: input.userId,
      email,
      partner: null,
    });
  }

  const adminByUserId = await queryAdminByUserId(input.userId);
  if (adminByUserId.verificationFailed) {
    return createVerificationFailureContext({
      userId: input.userId,
      email,
      partner: partner ?? null,
    });
  }

  if (adminByUserId.admin) {
    return createAccessContext({
      userId: input.userId,
      email,
      admin: adminByUserId.admin,
      partner: partner ?? null,
      accessStatus: "resolved",
    });
  }

  if (email) {
    const adminByEmail = await queryAdminByEmail(email);
    if (adminByEmail.verificationFailed) {
      return createVerificationFailureContext({
        userId: input.userId,
        email,
        partner: partner ?? null,
      });
    }

    if (adminByEmail.admin) {
      return createAccessContext({
        userId: input.userId,
        email,
        admin: adminByEmail.admin,
        partner: partner ?? null,
        accessStatus: "resolved",
      });
    }
  }

  return createAccessContext({
    userId: input.userId,
    email,
    admin: null,
    partner: partner ?? null,
    accessStatus: partner ? "resolved" : "unauthorized",
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
