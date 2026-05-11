import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";

export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const { data } = await supabase.auth.getSession();
    let token = data.session?.access_token;

    if (!token) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      token = refreshed.session?.access_token;
    }

    // If we still have no token after attempting a refresh, abort the request
    // immediately on the client side. Forwarding without an Authorization header
    // would result in a guaranteed 401 from the server and pollutes the console.
    if (!token) {
      throw new Error("No active session — request aborted");
    }

    return next({
      sendContext: {},
      headers: { Authorization: `Bearer ${token}` },
    });
  },
);
