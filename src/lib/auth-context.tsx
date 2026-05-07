import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { linkPartnerProfile, claimFirstAdmin, getMyContext } from "@/lib/auth.functions";

type Ctx = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAdmin: boolean;
  isPartner: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPartner, setIsPartner] = useState(false);

  const refresh = async () => {
    try {
      const ctx = await getMyContext();
      setIsAdmin(ctx.isAdmin);
      setIsPartner(ctx.isPartner);
    } catch {
      setIsAdmin(false);
      setIsPartner(false);
    }
  };

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s) {
        // bootstrap on every sign-in: try to claim admin (no-op if any exists), then link partner profile
        setTimeout(async () => {
          try {
            await claimFirstAdmin();
            await linkPartnerProfile();
            await refresh();
          } catch (e) {
            console.error("auth bootstrap failed", e);
          }
        }, 0);
      } else {
        setIsAdmin(false);
        setIsPartner(false);
      }
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) refresh();
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthCtx.Provider
      value={{ user: session?.user ?? null, session, loading, isAdmin, isPartner, refresh, signOut }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const v = useContext(AuthCtx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}