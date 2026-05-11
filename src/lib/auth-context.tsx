import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
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
  /** True only after auth has settled for the current state (signed in or signed out).
   *  Use this alongside `user` to guard protected queries so server functions
   *  never run during Supabase session recovery/bootstrap. */
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
const MAX_TOKEN_POLL_ATTEMPTS = 8;
const TOKEN_POLL_DELAY_MS = 200;

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

  const refresh = useCallback(async () => {
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
                if (res && typeof res === "object" && "disabled" in res && res.disabled === true) {
                  toast.error("Your access has been disabled. Please contact your administrator.");
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
  }, []);

  const bootstrapAuthenticatedSession = useCallback(
    async (nextSession: Session, { runPostLoginSetup }: { runPostLoginSetup: boolean }) => {
      setSessionReady(false);
      console.info("[auth] bootstrap:start", {
        userId: nextSession.user.id,
        runPostLoginSetup,
      });

      try {
        let token = nextSession.access_token;

        for (let attempt = 0; !token && attempt < MAX_TOKEN_POLL_ATTEMPTS; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_DELAY_MS));
          const { data } = await supabase.auth.getSession();
          token = data.session?.access_token;
        }

        if (!token) {
          console.error("[auth] bootstrap failed: no access token available");
          return;
        }

        if (runPostLoginSetup) {
          await claimFirstAdmin();
          await linkPartnerProfile();
        }

        await refresh();
        console.info("[auth] bootstrap:complete", {
          userId: nextSession.user.id,
        });
      } catch (e) {
        console.error("[auth] bootstrap failed", e);
        setIsRealAdmin(false);
        setIsPartner(false);
      } finally {
        setLoading(false);
        setSessionReady(true);
      }
    },
    [refresh],
  );

  useEffect(() => {
    // Subscribe to auth state changes.
    // Only run bootstrap (claimFirstAdmin, linkPartnerProfile) on SIGNED_IN —
    // NOT on INITIAL_SESSION which fires during _initialize before token is ready.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);

      if (event === "SIGNED_IN" && s) {
        void bootstrapAuthenticatedSession(s, { runPostLoginSetup: true });
      } else if (event === "TOKEN_REFRESHED" && s) {
        setSessionReady(true);
        refresh().catch((error) => {
          console.error("[auth] refresh after TOKEN_REFRESHED failed", error);
        });
      } else if (!s) {
        setIsRealAdmin(false);
        setIsPartner(false);
        setLoading(false);
        setSessionReady(true);
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
    void supabase.auth
      .getSession()
      .then(async ({ data }) => {
        setSession(data.session);
        if (data.session) {
          await bootstrapAuthenticatedSession(data.session, { runPostLoginSetup: false });
          return;
        }
        setLoading(false);
        setSessionReady(true);
      })
      .catch((error) => {
        console.error("[auth] getSession failed", error);
        setSession(null);
        setIsRealAdmin(false);
        setIsPartner(false);
        setLoading(false);
        setSessionReady(true);
      });

    return () => sub.subscription.unsubscribe();
  }, [bootstrapAuthenticatedSession, refresh]);

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
