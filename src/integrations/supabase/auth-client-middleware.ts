import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";
import { describeSupabaseToken, getSupabaseProjectHost } from "./auth-diagnostics";

const INVALID_SUPABASE_SESSION_TOKEN_MESSAGE =
  "Invalid Supabase session token. Please sign out and sign in again.";

export class AuthSessionError extends Error {
  readonly code = "NO_ACTIVE_SESSION" as const;

  constructor() {
    super("No active session — request aborted");
    this.name = "AuthSessionError";
  }
}

export class InvalidSupabaseSessionTokenError extends Error {
  readonly code = "INVALID_SESSION_TOKEN" as const;

  constructor() {
    super(INVALID_SUPABASE_SESSION_TOKEN_MESSAGE);
    this.name = "InvalidSupabaseSessionTokenError";
  }
}

export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const projectHost = getSupabaseProjectHost(
      import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    );
    const { data } = await supabase.auth.getSession();
    let session = data.session;
    const hasSession = !!session;
    let token = data.session?.access_token;
    let refreshAttempted = false;
    let tokenDiagnostics = describeSupabaseToken(token);

    console.info("[attachSupabaseAuth] session lookup", {
      hasSession,
      hasAccessToken: !!token,
      tokenLength: tokenDiagnostics.length,
      tokenHasThreeSegments: tokenDiagnostics.hasThreeSegments,
      tokenPrefixType: tokenDiagnostics.prefixType,
      tokenShape: tokenDiagnostics.headerValue,
      refreshAttempted,
      projectHost,
    });

    if (!token) {
      refreshAttempted = true;
      const { data: refreshed } = await supabase.auth.refreshSession();
      session = refreshed.session ?? session;
      token = refreshed.session?.access_token;
      tokenDiagnostics = describeSupabaseToken(token);

      console.info("[attachSupabaseAuth] refresh result", {
        hasSession: !!refreshed.session,
        hasAccessToken: !!token,
        tokenLength: tokenDiagnostics.length,
        tokenHasThreeSegments: tokenDiagnostics.hasThreeSegments,
        tokenPrefixType: tokenDiagnostics.prefixType,
        tokenShape: tokenDiagnostics.headerValue,
        refreshAttempted,
        projectHost,
      });
    }

    // If we still have no token after attempting a refresh, abort the request
    // immediately on the client side. Forwarding without an Authorization header
    // would result in a guaranteed 401 from the server and pollutes the console.
    if (!token) {
      console.error("[attachSupabaseAuth] aborting request: no access token", {
        hasSession: !!session,
        hasAccessToken: false,
        refreshAttempted,
        projectHost,
      });
      throw new AuthSessionError();
    }

    if (!tokenDiagnostics.isLikelyJwt) {
      console.error("[attachSupabaseAuth] aborting request: invalid session token shape", {
        hasSession: !!session,
        hasAccessToken: true,
        tokenLength: tokenDiagnostics.length,
        tokenHasThreeSegments: tokenDiagnostics.hasThreeSegments,
        tokenPrefixType: tokenDiagnostics.prefixType,
        tokenShape: tokenDiagnostics.headerValue,
        projectHost,
      });
      throw new InvalidSupabaseSessionTokenError();
    }

    return next({
      sendContext: {},
      headers: {
        Authorization: `Bearer ${token}`,
        "x-mgt-client-session-present": String(!!session),
        "x-mgt-client-access-token-present": String(!!token),
        "x-mgt-client-supabase-project-host": projectHost ?? "unknown",
        "x-mgt-token-shape": tokenDiagnostics.headerValue,
      },
    });
  },
);
