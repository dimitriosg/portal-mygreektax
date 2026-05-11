import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";

export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    // getSession() can return stale/null data — try refreshSession() as fallback
    // to ensure we always have a valid token before calling server functions
    const { data } = await supabase.auth.getSession();

    let token = data.session?.access_token;

    if (!token) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      token = refreshed.session?.access_token;
    }

    return next({
      sendContext: {},
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
