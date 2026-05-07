import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { linkPartnerProfile, claimFirstAdmin, getMyContext } from "@/lib/auth.functions";

type Ctx = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAdmin: boolean;          // effective admin (false while impersonating)
  isRealAdmin: boolean;      // signed-in user actually has admin role
  isPartner: boolean;
  impersonatingId: string | null;
  impersonatingName: string | null;
  startImpersonation: (id: string, name: string) => void;
  stopImpersonation: () => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | undefined>(undefined);

const IMP_ID_KEY = "mgt:impersonateId";
const IMP_NAME_KEY = "mgt:impersonateName";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRealAdmin, setIsRealAdmin] = useState(false);
  const [isPartner, setIsPartner] = useState(false);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const [impersonatingName, setImpersonatingName] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setImpersonatingId(sessionStorage.getItem(IMP_ID_KEY));
    setImpersonatingName(sessionStorage.getItem(IMP_NAME_KEY));
  }, []);

  const refresh = async () => {
    try {
      const ctx = await getMyContext();
      setIsRealAdmin(ctx.isAdmin);
      setIsPartner(ctx.isPartner);
    } catch {
      setIsRealAdmin(false);
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
        setIsRealAdmin(false);
        setIsPartner(false);
        if (typeof window !== "undefined") {
          sessionStorage.removeItem(IMP_ID_KEY);
          sessionStorage.removeItem(IMP_NAME_KEY);
        }
        setImpersonatingId(null);
        setImpersonatingName(null);
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
    if (typeof window !== "undefined") {
      sessionStorage.removeItem(IMP_ID_KEY);
      sessionStorage.removeItem(IMP_NAME_KEY);
    }
    await supabase.auth.signOut();
  };

  const startImpersonation = (id: string, name: string) => {
    if (!isRealAdmin) return;
    sessionStorage.setItem(IMP_ID_KEY, id);
    sessionStorage.setItem(IMP_NAME_KEY, name);
    setImpersonatingId(id);
    setImpersonatingName(name);
  };

  const stopImpersonation = () => {
    sessionStorage.removeItem(IMP_ID_KEY);
    sessionStorage.removeItem(IMP_NAME_KEY);
    setImpersonatingId(null);
    setImpersonatingName(null);
  };

  const isAdmin = isRealAdmin && !impersonatingId;

  return (
    <AuthCtx.Provider
      value={{
        user: session?.user ?? null,
        session,
        loading,
        isAdmin,
        isRealAdmin,
        isPartner,
        impersonatingId,
        impersonatingName,
        startImpersonation,
        stopImpersonation,
        refresh,
        signOut,
      }}
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
