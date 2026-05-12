import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";

function getSupabaseProjectHost() {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!supabaseUrl) return null;

  try {
    return new URL(supabaseUrl).host;
  } catch {
    return null;
  }
}

export class AuthSessionError extends Error {
  readonly code = "NO_ACTIVE_SESSION" as const;

  constructor() {
    super("No active session — request aborted");
    this.name = "AuthSessionError";
  }
}

export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const projectHost = getSupabaseProjectHost();
    const { data } = await supabase.auth.getSession();
    const hasSession = !!data.session;
    let token = data.session?.access_token;
    let refreshAttempted = false;

    console.info("[attachSupabaseAuth] session lookup", {
      hasSession,
      hasToken: !!token,
      refreshAttempted,
      projectHost,
    });

    if (!token) {
      refreshAttempted = true;
      const { data: refreshed } = await supabase.auth.refreshSession();
      token = refreshed.session?.access_token;

      console.info("[attachSupabaseAuth] refresh result", {
        hasSession: !!refreshed.session,
        hasToken: !!token,
        refreshAttempted,
        projectHost,
      });
    }

    // If we still have no token after attempting a refresh, abort the request
    // immediately on the client side. Forwarding without an Authorization header
    // would result in a guaranteed 401 from the server and pollutes the console.
    if (!token) {
      console.error("[attachSupabaseAuth] aborting request: no access token", {
        hasSession,
        hasToken: false,
        refreshAttempted,
        projectHost,
      });
      throw new AuthSessionError();
    }

    return next({
      sendContext: {},
      headers: { Authorization: `Bearer ${token}` },
    });
  },
);
