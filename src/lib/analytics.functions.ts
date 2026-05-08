import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { getRequestHeader } from "@tanstack/react-start/server";

const PLAUSIBLE_SITE_ID = "portal.mygreektax.eu";
const PLAUSIBLE_BASE = "https://plausible.io/api/v1/stats";

type AggregateMetric = { value: number };
type AggregateResponse = {
  results: {
    visitors?: AggregateMetric;
    pageviews?: AggregateMetric;
    bounce_rate?: AggregateMetric;
    visit_duration?: AggregateMetric;
  };
};
type TimeseriesResponse = {
  results: { date: string; visitors: number }[];
};
type BreakdownResponse = {
  results: { [key: string]: string | number; visitors: number }[];
};

export type AdminAnalyticsData = {
  enabled: boolean;
  error: string | null;
  aggregate: {
    visitors: number;
    pageviews: number;
    bounceRate: number; // percent
    visitDuration: number; // seconds
  };
  timeseries: { date: string; visitors: number }[];
  topPages: { page: string; visitors: number }[];
  topEvents: { name: string; visitors: number }[];
};

async function requireAdmin(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Response("Server configuration error", { status: 500 });
  }
  const authHeader = getRequestHeader("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Response("Unauthorized", { status: 401 });
  }
  const token = authHeader.slice("Bearer ".length).trim();
  const supabase = createClient(url, serviceKey);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);
  if (authError || !user) {
    throw new Response("Unauthorized", { status: 401 });
  }
  const { data: roles, error: rolesError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  if (rolesError || !roles?.some((r) => r.role === "admin")) {
    throw new Response("Forbidden", { status: 403 });
  }
}

async function plausibleFetch<T>(path: string, query: Record<string, string>): Promise<T> {
  const apiKey = process.env.PLAUSIBLE_API_KEY;
  if (!apiKey) throw new Error("PLAUSIBLE_API_KEY is not configured");
  const params = new URLSearchParams({ site_id: PLAUSIBLE_SITE_ID, ...query });
  const res = await fetch(`${PLAUSIBLE_BASE}/${path}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Plausible API ${path} failed [${res.status}]: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

const EMPTY: AdminAnalyticsData = {
  enabled: false,
  error: null,
  aggregate: { visitors: 0, pageviews: 0, bounceRate: 0, visitDuration: 0 },
  timeseries: [],
  topPages: [],
  topEvents: [],
};

export const getPlausibleStats = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminAnalyticsData> => {
    await requireAdmin();

    if (!process.env.PLAUSIBLE_API_KEY) {
      return {
        ...EMPTY,
        enabled: false,
        error:
          "Plausible analytics is not configured yet. Add a PLAUSIBLE_API_KEY secret to enable this panel.",
      };
    }

    try {
      const [aggregate, timeseries, topPages, topEvents] = await Promise.all([
        plausibleFetch<AggregateResponse>("aggregate", {
          period: "30d",
          metrics: "visitors,pageviews,bounce_rate,visit_duration",
        }),
        plausibleFetch<TimeseriesResponse>("timeseries", {
          period: "30d",
          metrics: "visitors",
        }),
        plausibleFetch<BreakdownResponse>("breakdown", {
          period: "7d",
          property: "event:page",
          metrics: "visitors",
          limit: "8",
        }),
        plausibleFetch<BreakdownResponse>("breakdown", {
          period: "7d",
          property: "event:name",
          metrics: "visitors",
          limit: "10",
        }),
      ]);

      return {
        enabled: true,
        error: null,
        aggregate: {
          visitors: aggregate.results.visitors?.value ?? 0,
          pageviews: aggregate.results.pageviews?.value ?? 0,
          bounceRate: aggregate.results.bounce_rate?.value ?? 0,
          visitDuration: aggregate.results.visit_duration?.value ?? 0,
        },
        timeseries: timeseries.results.map((r) => ({
          date: r.date,
          visitors: r.visitors,
        })),
        topPages: topPages.results.map((r) => ({
          page: String(r.page ?? ""),
          visitors: r.visitors,
        })),
        topEvents: topEvents.results.map((r) => ({
          name: String(r.name ?? ""),
          visitors: r.visitors,
        })),
      };
    } catch (err) {
      console.error("getPlausibleStats failed", err);
      return {
        ...EMPTY,
        enabled: true,
        error:
          err instanceof Error
            ? err.message
            : "Could not load analytics from Plausible.",
      };
    }
  },
);