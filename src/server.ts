import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;
const PUBLIC_TRACKING_HEADERS = {
  "cache-control": "private, no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

// Public token-gated pages that render without the logged-in chrome and must
// never be cached or indexed.
const PUBLIC_TOKEN_PATH_PREFIXES = ["/track/", "/pay/"] as const;

function getPublicTokenPathPrefix(pathname: string): string | null {
  return PUBLIC_TOKEN_PATH_PREFIXES.find((prefix) => pathname.startsWith(prefix)) ?? null;
}

// Rate limit for the signal beacon only. The payment page itself is a cheap
// read behind an unguessable token, and clients behind carrier-grade NAT share
// an IP with strangers — being rate-limited out of paying is a worse outcome
// than the token scanning a limit would deter. /pay/signal is the endpoint
// worth protecting, since it is the one that fans out to n8n and Telegram.
//
// Per-isolate and in-memory by design: no dependency, no binding. It is
// therefore approximate — each isolate keeps its own counts and they reset
// whenever an isolate recycles. Good enough to blunt a flood, not a quota.
const SIGNAL_RATE_LIMIT = { windowMs: 60_000, maxRequests: 30, maxBuckets: 5_000 } as const;
const signalRateBuckets = new Map<string, { count: number; resetAt: number }>();

function isSignalRateLimited(request: Request, pathname: string): boolean {
  if (pathname !== "/pay/signal") return false;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const bucket = signalRateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (signalRateBuckets.size >= SIGNAL_RATE_LIMIT.maxBuckets) signalRateBuckets.clear();
    signalRateBuckets.set(key, { count: 1, resetAt: now + SIGNAL_RATE_LIMIT.windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > SIGNAL_RATE_LIMIT.maxRequests;
}

function signalRateLimitedResponse(): Response {
  // JSON, to match the endpoint's own shape. The page treats a non-2xx claim
  // as undelivered and tells the client honestly rather than faking success.
  return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
    status: 429,
    headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60" },
  });
}

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function normalizePublicTrackingRequest(request: Request): Response | null {
  const url = new URL(request.url);
  const prefix = getPublicTokenPathPrefix(url.pathname);
  if (!prefix || url.pathname === prefix || !url.pathname.endsWith("/")) {
    return null;
  }
  url.pathname = url.pathname.slice(0, -1);
  return Response.redirect(url.toString(), 307);
}

function applyPublicTrackingHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  if (!getPublicTokenPathPrefix(url.pathname)) return response;

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(PUBLIC_TRACKING_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

function applyCloudflareEnvBindings(env: unknown) {
  if (!env || typeof env !== "object") return;
  if (typeof process === "undefined") return;

  process.env ??= {};

  const bindings = env as Record<string, unknown>;
  const copiedKeys: string[] = [];

  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value !== "string") continue;
    if (process.env[key]) continue;
    process.env[key] = value;
    copiedKeys.push(key);
  }

  if (copiedKeys.length > 0) {
    console.info("[server] copied Cloudflare env bindings into process.env", {
      keys: copiedKeys,
    });
  }
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const normalizedTrackingResponse = normalizePublicTrackingRequest(request);
      if (normalizedTrackingResponse) return normalizedTrackingResponse;

      if (isSignalRateLimited(request, new URL(request.url).pathname)) {
        return applyPublicTrackingHeaders(request, signalRateLimitedResponse());
      }

      applyCloudflareEnvBindings(env);
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return applyPublicTrackingHeaders(request, await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return applyPublicTrackingHeaders(request, brandedErrorResponse());
    }
  },
};
