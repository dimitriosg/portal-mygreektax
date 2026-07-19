import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useNavigate,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { Sun, Moon } from "lucide-react";

import appCss from "../styles.css?url";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { isOverdueEligibleStatus } from "@/lib/airtable-shared";
import { isPasswordRecoveryPending } from "@/lib/auth-recovery";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { createErrorReferenceId, debugError, isDebugEnabled } from "@/lib/debug";
import { listJobs } from "@/lib/jobs.functions";
import { listLeads } from "@/lib/leads.functions";

function isPastDueDate(value: string | undefined) {
  if (!value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsedDate = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (isNaN(parsedDate.getTime())) return false;
  const dueDate = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueDate < today;
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  const errorReferenceId = useMemo(() => createErrorReferenceId("root"), []);
  const showErrorDetails = isDebugEnabled();
  const errorDetails =
    error instanceof Error ? (error.stack ?? error.message) : getErrorMessage(error);
  debugError("[root-route-error]", {
    referenceId: errorReferenceId,
    name: error instanceof Error ? error.name : typeof error,
    message: getErrorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error ? error.cause : undefined,
    pathname: router.state.location.pathname,
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">Reference ID: {errorReferenceId}</p>
        {showErrorDetails && (
          <details className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-left text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Error details</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words">{errorDetails}</pre>
          </details>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "My Greek Tax — Partner Portal" },
      { name: "description", content: "Manage tax service jobs and track client progress." },
      { name: "author", content: "My Greek Tax" },
      { property: "og:title", content: "My Greek Tax — Partner Portal" },
      { property: "og:description", content: "Manage tax service jobs and track client progress." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "My Greek Tax — Partner Portal" },
      {
        name: "twitter:description",
        content: "Manage tax service jobs and track client progress.",
      },
      { property: "og:image", content: "/og-image.png" },
      { name: "twitter:image", content: "/og-image.png" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "apple-touch-icon", href: "/icon-maskable-512.png" },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;1,400;1,500&display=swap",
      },
    ],
    scripts: [
      // Static Plausible tag so the verifier can detect it in raw HTML.
      // The script itself ignores hostnames that don't match data-domain
      // (and localhost), so previews are automatically no-ops.
      {
        src: "https://plausible.io/js/pa-jHCy-4-ii1HrtB2pU_pbx.js",
        defer: true,
        "data-domain": "portal.mygreektax.eu",
      },
      {
        children:
          "window.plausible=window.plausible||function(){(window.plausible.q=window.plausible.q||[]).push(arguments)}",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

// Ticket C, Part 1 — a purely client-side connectivity indicator. Tells Jim
// at a glance *why* a write just rolled back with a toast (Ticket B already
// handles the failure safely; this just explains it). No server calls, no
// new dependency — navigator.onLine + the online/offline window events.
// Deliberately NOT an offline queue/merge system — see Ticket C scope note.
function OnlineStatusBadge() {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
        isOnline
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : "border-destructive/40 bg-destructive/10 text-destructive"
      }`}
      title={isOnline ? "Connected" : "Offline — edits will fail until your connection is back"}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${isOnline ? "bg-emerald-500" : "bg-destructive"}`}
      />
      {isOnline ? "Live" : "Offline"}
    </span>
  );
}

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
      <Toaster />
    </QueryClientProvider>
  );
}

function AppShell() {
  const {
    user,
    isAdmin,
    isRealAdmin,
    isPartner,
    accessStatus,
    signOut,
    loading,
    sessionReady,
    impersonatingId,
    impersonatingName,
    stopImpersonation,
  } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const fetchJobs = useServerFn(listJobs);
  const lastProcessedOverdueJobsErrorRef = useRef<unknown>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(() => isPasswordRecoveryPending());

  useEffect(() => {
    setIsHydrated(true);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => setIsDark(mediaQuery.matches);
    syncTheme();

    mediaQuery.addEventListener("change", syncTheme);
    return () => mediaQuery.removeEventListener("change", syncTheme);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [isDark]);
  const isPublicClientPage = pathname.startsWith("/track/");
  const overdueJobsQuery = useQuery({
    queryKey: ["jobs", user?.id, ""],
    queryFn: () => fetchJobs({ data: {} }),
    enabled:
      !loading &&
      !!user &&
      sessionReady &&
      accessStatus === "resolved" &&
      !isRealAdmin &&
      isPartner,
    throwOnError: false,
  });
  useEffect(() => {
    if (!overdueJobsQuery.error) {
      lastProcessedOverdueJobsErrorRef.current = null;
      return;
    }
    if (lastProcessedOverdueJobsErrorRef.current === overdueJobsQuery.error) return;
    lastProcessedOverdueJobsErrorRef.current = overdueJobsQuery.error;

    debugError("[app-shell] overdue jobs query error", {
      message: getErrorMessage(overdueJobsQuery.error),
      error: overdueJobsQuery.error,
      userId: user?.id ?? null,
      sessionReady,
      pathname,
    });

    if (isAuthSessionError(overdueJobsQuery.error)) {
      navigate({ to: "/login", replace: true });
    }
  }, [navigate, overdueJobsQuery.error, pathname, sessionReady, user?.id]);
  const overdueJobs = useMemo(
    () => (Array.isArray(overdueJobsQuery.data?.jobs) ? overdueJobsQuery.data.jobs : []),
    [overdueJobsQuery.data?.jobs],
  );
  const overdueJobsCount = useMemo(
    () =>
      overdueJobs.filter(
        (job) =>
          isOverdueEligibleStatus(job.fields.Status) && isPastDueDate(job.fields["SLA Deadline"]),
      ).length,
    [overdueJobs],
  );

  // Pipeline nav badge (Ticket B4): new Potential leads with no Next Action
  // Date set yet — the "check Airtable to see what just came in" replacement.
  // Shares the exact same query key as /leads' own useQuery, so this query
  // and the Pipeline page's query are the same cache entry: navigating to
  // /leads doesn't refetch, and any optimistic edit made there (Stage,
  // Next Action, Next Action Date) updates this badge immediately too.
  const fetchLeadsForBadge = useServerFn(listLeads);
  const potentialLeadsQuery = useQuery({
    queryKey: ["leads", "admin"],
    queryFn: () => fetchLeadsForBadge(),
    enabled: !loading && !!user && sessionReady && accessStatus === "resolved" && isAdmin,
    throwOnError: false,
  });
  const newLeadsNeedingActionCount = useMemo(() => {
    const leads = Array.isArray(potentialLeadsQuery.data?.leads)
      ? potentialLeadsQuery.data.leads
      : [];
    return leads.filter(
      (lead) => lead.fields.Stage === "Potential" && !lead.fields["Next Action Date"],
    ).length;
  }, [potentialLeadsQuery.data?.leads]);
  useEffect(() => {
    if (!user || !sessionReady) {
      setRecoveryPending(false);
      return;
    }

    setRecoveryPending(isPasswordRecoveryPending());
  }, [pathname, sessionReady, user]);

  useEffect(() => {
    if (!user || !sessionReady) return;
    if (!recoveryPending || pathname === "/reset-password") return;
    navigate({ to: "/reset-password", replace: true });
  }, [navigate, pathname, recoveryPending, sessionReady, user]);

  const showAuthenticatedNav = isHydrated && !loading && !!user;
  const showImpersonationBanner = isHydrated && !!impersonatingId;
  if (isPublicClientPage) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
      </div>
    );
  }
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {showImpersonationBanner && (
        <div className="bg-amber-100 text-amber-900 border-b border-amber-300 text-sm">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span>
              Impersonating partner: <strong>{impersonatingName ?? impersonatingId}</strong> — you
              have partner-only permissions.
            </span>
            <button
              onClick={stopImpersonation}
              className="rounded-md border border-amber-400 bg-amber-50 px-3 py-1 text-xs font-medium hover:bg-amber-200"
            >
              Exit impersonation
            </button>
          </div>
        </div>
      )}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link
            to="/"
            className="font-serif text-lg font-semibold tracking-tight"
            style={{ color: "var(--brand)" }}
          >
            My Greek Tax
          </Link>
          <nav className="flex flex-wrap items-center gap-3 sm:gap-4 text-sm">
            {showAuthenticatedNav ? (
              <>
                <OnlineStatusBadge />
                <Link to="/dashboard" activeProps={{ className: "font-semibold" }}>
                  <span className="inline-flex items-center gap-2">
                    <span>Dashboard</span>
                    {accessStatus === "resolved" &&
                      !isRealAdmin &&
                      isPartner &&
                      overdueJobsCount > 0 && (
                        <span className="rounded-full bg-destructive text-white text-xs h-5 w-5 flex items-center justify-center">
                          {overdueJobsCount}
                        </span>
                      )}
                  </span>
                </Link>
                {isAdmin && (
                  <Link to="/admin" activeProps={{ className: "font-semibold" }}>
                    Admin
                  </Link>
                )}
                {isAdmin && (
                  <Link to="/leads" activeProps={{ className: "font-semibold" }}>
                    <span className="inline-flex items-center gap-2">
                      <span>Pipeline</span>
                      {newLeadsNeedingActionCount > 0 && (
                        <span
                          className="rounded-full bg-destructive text-white text-xs h-5 w-5 flex items-center justify-center"
                          title={`${newLeadsNeedingActionCount} new lead(s) with no next action set`}
                        >
                          {newLeadsNeedingActionCount}
                        </span>
                      )}
                    </span>
                  </Link>
                )}
                /////
                // <-- ADDING 'DRAFT CASES'
                {isAdmin && (
                  <Link to="/drafts" activeProps={{ className: "font-semibold" }}>
                    Cases
                  </Link>
                )}
                // <-- FINISH adding.

                /////
                {isRealAdmin && impersonatingId && (
                  <button
                    onClick={stopImpersonation}
                    className="text-amber-700 hover:text-amber-900"
                  >
                    Back to admin
                  </button>
                )}
                <button onClick={signOut} className="text-muted-foreground hover:text-foreground">
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" activeProps={{ className: "font-semibold" }}>
                Sign in
              </Link>
            )}
            <button
              onClick={() => setIsDark((v) => !v)}
              aria-label="Toggle dark mode"
              className="text-muted-foreground hover:text-foreground"
            >
              {isHydrated ? (
                isDark ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )
              ) : null}
            </button>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
