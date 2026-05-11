import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { linkPartnerProfile, claimFirstAdmin, getMyContext } from "@/lib/auth.functions";
import { recordPartnerLogin } from "@/lib/activity.functions";
import { track } from "@/lib/analytics";
import { toast } from "sonner";

type Ctx = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** True only after getSession() has resolved on mount.
   *  Use this (alongside `user`) to guard TanStack Query `enabled` flags
   *  so server functions are never called before the token is valid. */
  sessionReady: boolean;
  isAdmin: boolean;
  isRealAdmin: boolean;
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
  // sessionReady becomes true only after getSession() resolves on mount.
  // onAuthStateChange fires earlier (during Supabase's _initialize) and
  // must NOT be used to gate query execution.
  const [sessionReady, setSessionReady] = useState(false);
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
      try {
        if (typeof window !== "undefined") {
          const flag = "mgt:loginTracked";
          if (!sessionStorage.getItem(flag)) {
            sessionStorage.setItem(flag, "1");
            track("partner_login", {
              role: ctx.isAdmin ? "admin" : ctx.isPartner ? "partner" : "user",
            });
            recordPartnerLogin()
              .then((res) => {
                if (res && (res as any).disabled) {
                  toast.error(
                    "Your access has been disabled. Please contact your administrator.",
                  );
                  supabase.auth.signOut();
                }
              })
              .catch(() => {
                /* never block UI on analytics */
              });
          }
        }
      } catch {
        // ignore
      }
    } catch {
      setIsRealAdmin(false);
      setIsPartner(false);
    }
  };

  useEffect(() => {
    // Subscribe to auth state changes.
    // Only run bootstrap (claimFirstAdmin, linkPartnerProfile) on SIGNED_IN —
    // NOT on INITIAL_SESSION which fires during _initialize before token is ready.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);

      if (event === "SIGNED_IN" && s) {
        (async () => {
          let token = s.access_token;

          for (let attempt = 0; !token && attempt < 8; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            const { data } = await supabase.auth.getSession();
            token = data.session?.access_token;
          }

          if (!token) {
            console.error("auth bootstrap skipped: no access token after SIGNED_IN");
            return;
          }

          setSessionReady(true);
          try {
            await claimFirstAdmin();
            await linkPartnerProfile();
            await refresh();
          } catch (e) {
            console.error("auth bootstrap failed", e);
          }
        })();
      } else if (event === "TOKEN_REFRESHED" && s) {
        setSessionReady(true);
        refresh().catch(() => {});
      } else if (!s) {
        setIsRealAdmin(false);
        setIsPartner(false);
        setSessionReady(false);
        if (typeof window !== "undefined") {
          sessionStorage.removeItem(IMP_ID_KEY);
          sessionStorage.removeItem(IMP_NAME_KEY);
        }
        setImpersonatingId(null);
        setImpersonatingName(null);
      }
    });

    // On mount, getSession() is the authoritative source of truth.
    // Only after this resolves is the token guaranteed to be valid.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) refresh();
      setLoading(false);
      setSessionReady(true); // ← this is the only safe moment to enable queries
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    if (typeof window !== "undefined") {
      sessionStorage.removeItem(IMP_ID_KEY);
      sessionStorage.removeItem(IMP_NAME_KEY);
      sessionStorage.removeItem("mgt:loginTracked");
    }
    setSessionReady(false);
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
        sessionReady,
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
