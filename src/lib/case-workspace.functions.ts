import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { requireAdminAccess } from "./access-context.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Left-rail data for the case workspace: payments received and open job items
// for the case's client. Read-only. The rail cannot query these tables from
// the browser because payments and jobs carry no RLS policy for authenticated
// users (service-role reads only), so it goes through this admin-gated server
// function instead, the same way /leads and /dashboard read their data.

const RECORD_ID = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[0-9a-fA-F-]{36}$/, "Invalid record id");

export interface CaseRailPayment {
  id: string;
  amount: number;
  currency: string;
  received_at: string;
  status: string;
  kind: string | null;
  payer_reference: string | null;
}

export interface CaseRailJob {
  id: string;
  job_code: string | null;
  status: string | null;
  next_action_needed: string | null;
  sla_deadline: string | null;
}

export interface CaseRailData {
  payments: CaseRailPayment[];
  jobs: CaseRailJob[];
}

export const getCaseRail = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { clientId: string }) => z.object({ clientId: RECORD_ID }).parse(d))
  .handler(async ({ data, context }): Promise<CaseRailData> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const [payments, jobs] = await Promise.all([
      supabaseAdmin
        .from("payments")
        .select("id, amount, currency, received_at, status, kind, payer_reference")
        .eq("client_id", data.clientId)
        .neq("status", "ignored")
        .order("received_at", { ascending: false })
        .limit(20),
      supabaseAdmin
        .from("jobs")
        .select("id, job_code, status, next_action_needed, sla_deadline")
        .eq("client_id", data.clientId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    if (payments.error) throw new Error(`Failed to load payments: ${payments.error.message}`);
    if (jobs.error) throw new Error(`Failed to load jobs: ${jobs.error.message}`);

    return {
      payments: (payments.data ?? []) as CaseRailPayment[],
      jobs: (jobs.data ?? []) as CaseRailJob[],
    };
  });
