import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { linkPartnerProfile, getMyContext } from "@/lib/auth.functions";
import { clearPasswordRecoveryPending } from "@/lib/auth-recovery";
import { getErrorMessage } from "@/lib/auth-errors";
import { recordPartnerLogin } from "@/lib/activity.functions";
import { track } from "@/lib/analytics";
import { debugError, debugLog } from "@/lib/debug";
import { toast } from "sonner";

type AccessType = "admin" | "partner" | "unauthorized";
type AccessStatus = "resolved" | "unauthorized" | "verification_failed";
const ACCESS_VERIFICATION_ERROR_MESSAGE =
  "Could not verify portal access. Please contact the administrator.";
type AuthAccessContext = {
  isAdmin: boolean;
  isPartner: boolean;
  accessType: AccessType;
  accessStatus: AccessStatus;
  accessError: string | null;
};

type Ctx = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** True only when the current signed-in session has fully completed bootstrap.
   *  Use this alongside `user` to guard protected queries so server functions
   *  never run during Supabase session recovery/bootstrap. */
  sessionReady: boolean;
  isAdmin: boolean;
  isRealAdmin: boolean;
  isPartner: boolean;
  accessType: AccessType | null;
  accessStatus: AccessStatus | "idle";
  accessError: string | null;
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

/** Runtime guard for server access payloads before auth state is updated from network data. */
function isAccessType(value: unknown): value is AccessType {
  return value === "admin" || value === "partner" || value === "unauthorized";
}

/** Runtime guard for access verification outcomes returned by getMyContext(). */
function isAccessStatus(value: unknown): value is AccessStatus {
  return value === "resolved" || value === "unauthorized" || value === "verification_failed";
}

function isAuthAccessContext(value: unknown): value is AuthAccessContext {
  if (!value || typeof value !== "object") return false;

  const context = value as Record<string, unknown>;
  return (
    typeof context.isAdmin === "boolean" &&
    typeof context.isPartner === "boolean" &&
    isAccessType(context.accessType) &&
    isAccessStatus(context.accessStatus) &&
    (typeof context.accessError === "string" || context.accessError === null)
  );
}

/** Deduplicate bootstrap work per authenticated session, even when the same user signs in again later. */
function getSessionBootstrapKey(session: Session) {
  return `${session.user.id}:${session.access_token}`;
}

function getSafeVerificationErrorMessage(error: unknown) {
  const message = getErrorMessage(error);

  if (
    message.startsWith("Unauthorized:") ||
    message.startsWith("Missing Supabase environment variable") ||
    message === "Invalid Supabase session token. Please sign out and sign in again."
  ) {
    return message;
  }

  return ACCESS_VERIFICATION_ERROR_MESSAGE;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // sessionReady becomes true only after getSession() resolves on mount.
  // onAuthStateChange fires earlier (during Supabase's _initialize) and
  // must NOT be used to gate query execution.
  const [sessionReady, setSessionReady] = useState(false);
  const [isRealAdmin, setIsRealAdmin] = useState(false);
  const [isPartner, setIsPartner] = useState(false);
  const [accessType, setAccessType] = useState<AccessType | null>(null);
  const [accessStatus, setAccessStatus] = useState<AccessStatus | "idle">("idle");
  const [accessError, setAccessError] = useState<string | null>(null);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const [impersonatingName, setImpersonatingName] = useState<string | null>(null);
  const bootstrapPromisesRef = useRef(new Map<string, Promise<void>>());
  const completedBootstrapKeyRef = useRef<string | null>(null);
  const initialSessionResolvedRef = useRef(false);
  const pendingSignInSessionRef = useRef<Session | null>(null);

  /** Fail closed whenever role verification cannot be trusted so admin/partner flags never become undefined. */
  const applyVerificationFailedState = useCallback((message?: string) => {
    setIsRealAdmin(false);
    setIsPartner(false);
    setAccessType("unauthorized");
    setAccessStatus("verification_failed");
    setAccessError(message ?? ACCESS_VERIFICATION_ERROR_MESSAGE);
  }, []);

  const resetAccessState = useCallback(() => {
    setIsRealAdmin(false);
    setIsPartner(false);
    setAccessType(null);
    setAccessStatus("idle");
    setAccessError(null);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setImpersonatingId(sessionStorage.getItem(IMP_ID_KEY));
    setImpersonatingName(sessionStorage.getItem(IMP_NAME_KEY));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await getMyContext();
      if (!isAuthAccessContext(result)) {
        debugError("[auth] refresh failed: invalid access context", {
          hasContext: result != null,
          resultType: typeof result,
        });
        applyVerificationFailedState();
        return;
      }

      const ctx = result;
      setIsRealAdmin(ctx.isAdmin);
      setIsPartner(ctx.isPartner);
      setAccessType(ctx.accessType);
      setAccessStatus(ctx.accessStatus);
      setAccessError(ctx.accessError);
      try {
        if (ctx.accessStatus !== "verification_failed" && typeof window !== "undefined") {
          const flag = "mgt:loginTracked";
          if (!sessionStorage.getItem(flag)) {
            sessionStorage.setItem(flag, "1");
            track("partner_login", {
              role: ctx.accessType,
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
    } catch (error) {
      debugError("[auth] refresh failed", error);
      applyVerificationFailedState(getSafeVerificationErrorMessage(error));
    }
  }, [applyVerificationFailedState]);

  const bootstrapAuthenticatedSession = useCallback(
    async (nextSession: Session, { runPostLoginSetup }: { runPostLoginSetup: boolean }) => {
      const sessionKey = getSessionBootstrapKey(nextSession);
      const inFlightBootstrap = bootstrapPromisesRef.current.get(sessionKey);
      if (inFlightBootstrap) {
        debugLog("[auth] bootstrap:deduped", {
          userId: nextSession.user.id,
          runPostLoginSetup,
        });
        await inFlightBootstrap;
        return;
      }

      if (completedBootstrapKeyRef.current === sessionKey) {
        debugLog("[auth] bootstrap:skipped completed session", {
          userId: nextSession.user.id,
          runPostLoginSetup,
        });
        return;
      }

      const bootstrapPromise = (async () => {
        setSessionReady(false);
        debugLog("[auth] bootstrap:start", {
          userId: nextSession.user.id,
          runPostLoginSetup,
        });

        try {
          setAccessStatus("idle");
          setAccessError(null);
          let token: string | null | undefined = nextSession.access_token;

          for (let attempt = 0; !token && attempt < MAX_TOKEN_POLL_ATTEMPTS; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_DELAY_MS));
            const { data } = await supabase.auth.getSession();
            token = data.session?.access_token;
          }

          if (!token) {
            debugError("[auth] bootstrap failed: no access token available");
            applyVerificationFailedState();
            setSessionReady(true);
            return;
          }

          if (runPostLoginSetup) {
            try {
              await linkPartnerProfile();
            } catch (error) {
              debugError("[auth] linkPartnerProfile failed", {
                userId: nextSession.user.id,
                error,
              });
            }
          }

          await refresh();
          setSessionReady(true);
          completedBootstrapKeyRef.current = sessionKey;
          debugLog("[auth] bootstrap:complete", {
            userId: nextSession.user.id,
          });
        } catch (e) {
          debugError("[auth] bootstrap failed", e);
          applyVerificationFailedState(getSafeVerificationErrorMessage(e));
          setSessionReady(true);
        } finally {
          bootstrapPromisesRef.current.delete(sessionKey);
          setLoading(false);
        }
      })();

      bootstrapPromisesRef.current.set(sessionKey, bootstrapPromise);
      await bootstrapPromise;
    },
    [applyVerificationFailedState, refresh],
  );

  useEffect(() => {
    // Subscribe to auth state changes.
    // Only run post-login partner linking on SIGNED_IN — not on INITIAL_SESSION,
    // which fires during _initialize before the token is ready.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);

      if (event === "SIGNED_IN" && s) {
        if (!initialSessionResolvedRef.current) {
          pendingSignInSessionRef.current = s;
          debugLog("[auth] defer SIGNED_IN bootstrap until initial session resolves", {
            userId: s.user.id,
          });
          return;
        }
        void bootstrapAuthenticatedSession(s, { runPostLoginSetup: true });
      } else if (event === "TOKEN_REFRESHED" && s) {
        setSessionReady(true);
        refresh().catch((error) => {
          debugError("[auth] refresh after TOKEN_REFRESHED failed", error);
        });
      } else if (!s) {
        completedBootstrapKeyRef.current = null;
        bootstrapPromisesRef.current.clear();
        pendingSignInSessionRef.current = null;
        resetAccessState();
        setLoading(false);
        setSessionReady(false);
        if (typeof window !== "undefined") {
          clearPasswordRecoveryPending();
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
        initialSessionResolvedRef.current = true;
        const pendingSignInSession = pendingSignInSessionRef.current;
        pendingSignInSessionRef.current = null;
        setSession(data.session);
        if (data.session) {
          const shouldRunPostLoginSetup =
            !!pendingSignInSession &&
            getSessionBootstrapKey(pendingSignInSession) === getSessionBootstrapKey(data.session);

          await bootstrapAuthenticatedSession(data.session, {
            runPostLoginSetup: shouldRunPostLoginSetup,
          });

          if (pendingSignInSession && !shouldRunPostLoginSetup) {
            setSession(pendingSignInSession);
            await bootstrapAuthenticatedSession(pendingSignInSession, { runPostLoginSetup: true });
          }
          return;
        }
        if (pendingSignInSession) {
          setSession(pendingSignInSession);
          await bootstrapAuthenticatedSession(pendingSignInSession, { runPostLoginSetup: true });
          return;
        }
        setLoading(false);
        setSessionReady(data.session !== null);
      })
      .catch((error) => {
        debugError("[auth] getSession failed", error);
        initialSessionResolvedRef.current = true;
        pendingSignInSessionRef.current = null;
        setSession(null);
        resetAccessState();
        setLoading(false);
        setSessionReady(false);
      });

    return () => sub.subscription.unsubscribe();
  }, [bootstrapAuthenticatedSession, refresh, resetAccessState]);

  const signOut = async () => {
    if (typeof window !== "undefined") {
      clearPasswordRecoveryPending();
      sessionStorage.removeItem(IMP_ID_KEY);
      sessionStorage.removeItem(IMP_NAME_KEY);
      sessionStorage.removeItem("mgt:loginTracked");
    }
    completedBootstrapKeyRef.current = null;
    bootstrapPromisesRef.current.clear();
    pendingSignInSessionRef.current = null;
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
        accessType,
        accessStatus,
        accessError,
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
