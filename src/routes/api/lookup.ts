import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// GET /api/lookup?email=someone@example.com
//
// Called by the Gmail side panel extension. Given the address of whoever sent
// the email currently on screen, it answers one question: is this a client, and
// if so what is their state.
//
// WHY THIS ROUTE EXISTS SEPARATELY.
//
// The portal's own screens read through server functions with the session the
// browser already holds. The extension has no such session, because it is not
// the portal: it runs on mail.google.com under its own origin. So this route
// takes a bearer token explicitly and validates it here.
//
// WHAT IT DELIBERATELY DOES NOT RETURN.
//
// No ΑΦΜ, no phone, no notes, no internal fees, no partner detail. The panel is
// glanceable context while reading mail, and it renders in a page Google
// controls. Anything sensitive that is not needed at a glance stays out, so a
// future bug in the panel cannot leak it.

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// Deliberately loose. Address validity is not ours to adjudicate, we only need
// to refuse something that is obviously not an address before it reaches a
// query. Bounded so a very long string cannot be used to probe the database.
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

const MAX_JOBS = 20;

type LookupJob = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
};

type LookupPayment = {
  amount: number;
  currency: string;
  paidAt: string;
};

type LookupClient = {
  id: string;
  fullName: string;
  email: string;
  leadStage: string;
  jobs: LookupJob[];
  lastPayment: LookupPayment | null;
};

// The extension's origin is chrome-extension://<id>, and that id is stable for
// a given unpacked folder but differs per machine. It is configuration, not a
// constant, so it comes from the environment. Unset means the route answers
// nobody cross-origin, which is the safe default for a deploy that has not been
// told about an extension yet.
function allowedOrigins(): string[] {
  return (process.env.EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    // Origin is echoed back, so anything in between must key its cache on it.
    Vary: "Origin",
  };
}

function fail(request: Request, status: number, error: string) {
  return Response.json({ error }, { status, headers: { ...NO_STORE, ...corsHeaders(request) } });
}

export const Route = createFileRoute("/api/lookup")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const headers = corsHeaders(request);
        // No CORS headers means the origin is not one we know. Answering 403
        // rather than 204 makes a misconfigured EXTENSION_ORIGINS visible in
        // the browser console instead of looking like a network fault.
        if (Object.keys(headers).length === 0) {
          return new Response(null, { status: 403 });
        }
        return new Response(null, {
          status: 204,
          headers: { ...headers, "Access-Control-Max-Age": "600" },
        });
      },

      GET: async ({ request }) => {
        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !serviceRoleKey) {
          console.error("[lookup] supabase server credentials not configured");
          return fail(request, 500, "Server configuration error");
        }

        const token = (request.headers.get("Authorization") ?? "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        if (!token) return fail(request, 401, "Not authenticated");

        const email = (new URL(request.url).searchParams.get("email") ?? "").trim().toLowerCase();
        if (!EMAIL_PATTERN.test(email)) return fail(request, 400, "Invalid email");

        const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // The service role key bypasses row level security, so the caller is
        // established from their own token first and every later query is
        // gated on the result. Order matters here.
        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        const user = userData?.user;
        if (userError || !user) return fail(request, 401, "Not authenticated");

        const { data: roleRow, error: roleError } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .eq("role", "admin")
          .maybeSingle();

        if (roleError) {
          console.error("[lookup] role check failed", roleError.message);
          return fail(request, 500, "Could not check permissions");
        }
        // Partners see their own caseload through the portal, not through this
        // route. A partner with a valid token is authenticated and still not
        // authorised, which is a 403 and not a 401.
        if (!roleRow) return fail(request, 403, "Admin access required");

        const { data: client, error: clientError } = await supabase
          .from("clients")
          .select("id, full_name, email, stage")
          .ilike("email", email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (clientError) {
          console.error("[lookup] client query failed", clientError.message);
          return fail(request, 500, "Lookup failed");
        }
        // Not a client is an ordinary answer, not an error. The panel renders
        // it as its own state, so it gets a 200 with an explicit null.
        if (!client) {
          return Response.json(
            { client: null },
            { headers: { ...NO_STORE, ...corsHeaders(request) } },
          );
        }

        const [jobsResult, paymentResult] = await Promise.all([
          supabase
            .from("jobs")
            .select("id, job_code, status, updated_at")
            .eq("client_id", client.id)
            .order("updated_at", { ascending: false })
            .limit(MAX_JOBS),
          supabase
            .from("payments")
            .select("amount, currency, received_at")
            .eq("client_id", client.id)
            .eq("status", "confirmed")
            .order("received_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        // A client with an unreadable job list is still worth showing. These
        // two failures degrade the panel rather than emptying it.
        if (jobsResult.error) {
          console.error("[lookup] jobs query failed", jobsResult.error.message);
        }
        if (paymentResult.error) {
          console.error("[lookup] payment query failed", paymentResult.error.message);
        }

        const payment = paymentResult.data;
        const body: { client: LookupClient } = {
          client: {
            id: client.id,
            fullName: client.full_name ?? email,
            email: client.email ?? email,
            leadStage: client.stage ?? "Unknown",
            jobs: (jobsResult.data ?? []).map((job) => ({
              id: job.id,
              title: job.job_code ?? "Job",
              status: job.status ?? "Unknown",
              updatedAt: job.updated_at,
            })),
            lastPayment: payment
              ? {
                  amount: payment.amount,
                  currency: payment.currency,
                  paidAt: payment.received_at,
                }
              : null,
          },
        };

        return Response.json(body, { headers: { ...NO_STORE, ...corsHeaders(request) } });
      },
    },
  },
});
