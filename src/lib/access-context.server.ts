import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

export type AccessType = "admin" | "partner" | "unauthorized";

type PartnerProfile = Database["public"]["Tables"]["partner_profiles"]["Row"];
type AdminRecord = Record<string, unknown>;

export type UserAccessContext = {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  isPartner: boolean;
  accessType: AccessType;
  admin: AdminRecord | null;
  partner: PartnerProfile | null;
};

function normalizeEmail(email: string | null | undefined): string | null {
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
}

function getStringField(row: AdminRecord, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function listAdminRows(): Promise<AdminRecord[]> {
  const { data, error } = await (supabaseAdmin as any).from("Admins").select("*");
  if (error) {
    console.error("[auth] failed to load Admins table", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    throw new Error("Could not resolve admin access.");
  }

  return Array.isArray(data) ? (data as AdminRecord[]) : [];
}

export async function listAdminEmails(): Promise<string[]> {
  const rows = await listAdminRows();
  const emails = new Set<string>();

  await Promise.all(
    rows.map(async (row) => {
      const directEmail = normalizeEmail(getStringField(row, "email"));
      if (directEmail) {
        emails.add(directEmail);
        return;
      }

      const userId = getStringField(row, "user_id");
      if (!userId) return;

      const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (error) {
        console.error("[auth] failed to resolve admin email", { userId, message: error.message });
        return;
      }

      const resolvedEmail = normalizeEmail(data.user?.email);
      if (resolvedEmail) emails.add(resolvedEmail);
    }),
  );

  return Array.from(emails);
}

export async function resolveUserAccess(input: {
  userId: string;
  email?: string | null;
}): Promise<UserAccessContext> {
  const email = normalizeEmail(input.email);
  const [partner, adminRows] = await Promise.all([
    supabaseAdmin.from("partner_profiles").select("*").eq("user_id", input.userId).maybeSingle(),
    listAdminRows(),
  ]);

  if (partner.error) {
    console.error("[auth] failed to load partner profile", {
      userId: input.userId,
      message: partner.error.message,
    });
    throw new Error("Could not resolve partner access.");
  }

  const adminByUserId = adminRows.find((row) => getStringField(row, "user_id") === input.userId) ?? null;
  const adminByEmail =
    !adminByUserId && email
      ? adminRows.find((row) => normalizeEmail(getStringField(row, "email")) === email) ?? null
      : null;

  const admin = adminByUserId ?? adminByEmail;
  const isAdmin = !!admin;
  const isPartner = !!partner.data;
  const accessType: AccessType = isAdmin ? "admin" : isPartner ? "partner" : "unauthorized";

  console.info("[auth] context resolved", {
    userId: input.userId,
    email,
    isAdmin,
    isPartner,
    accessType,
  });

  return {
    userId: input.userId,
    email,
    isAdmin,
    isPartner,
    accessType,
    admin,
    partner: partner.data ?? null,
  };
}

export async function requireAdminAccess(input: {
  userId: string;
  email?: string | null;
}): Promise<UserAccessContext> {
  const access = await resolveUserAccess(input);
  if (!access.isAdmin) throw new Error("Forbidden");
  return access;
}
