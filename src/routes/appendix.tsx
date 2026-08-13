import { createFileRoute, Link, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { getStoredImpersonationId } from "@/lib/impersonation";
import {
  getAppendix,
  APPENDIX_FORBIDDEN_MESSAGE,
  type AppendixRow,
} from "@/lib/appendix.functions";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The data loads in the route loader, not in the component after render. On a
// document request the loader runs during SSR, where getAppendix's auth
// middleware finds no session token on the request and throws 401; the catch
// below turns that into an HTTP redirect to /login before any query runs, so
// an unauthenticated visitor (including anyone hitting a public workers.dev
// preview URL) gets a 302, never a page shell. On client-side navigation the
// loader runs before render with the signed-in session token attached, and a
// signed-in caller who is neither admin nor active partner gets the 403 from
// the server function, rendered by the error component below.
//
// ?partner=<uuid> selects which card an admin is looking at. It is a hint, not
// an authorisation: get_partner_appendix ignores it for a partner and forces
// their own id, and the server function only honours ids that are in the
// caller's own active-partner list.
export const Route = createFileRoute("/appendix")({
  validateSearch: (search: Record<string, unknown>): { partner?: string } => {
    const partner = search.partner;
    // A malformed id is dropped rather than passed on, so a hand-edited URL
    // falls back to the default card instead of erroring.
    return typeof partner === "string" && UUID_PATTERN.test(partner) ? { partner } : {};
  },
  loaderDeps: ({ search }) => ({ partner: search.partner }),
  loader: async ({ deps }) => {
    // Impersonation lives in sessionStorage, not in the URL, so it is read here
    // rather than coming through loaderDeps. It is not a router dependency, so
    // the component invalidates the route when the auth context's value drifts
    // from the one this load used, which is what makes "Exit impersonation"
    // refresh the page instead of leaving a stale card on screen.
    const impersonatingAccountantId = getStoredImpersonationId() ?? undefined;
    try {
      return await getAppendix({
        data: {
          ...(deps.partner ? { partnerUserId: deps.partner } : {}),
          ...(impersonatingAccountantId ? { impersonatingAccountantId } : {}),
        },
      });
    } catch (error) {
      if (isUnauthorizedRequest(error)) throw redirect({ to: "/login", replace: true });
      throw error;
    }
  },
  component: AppendixPage,
  pendingComponent: AppendixPendingComponent,
  errorComponent: AppendixErrorComponent,
});

function isUnauthorizedRequest(error: unknown) {
  // Server pass: requireSupabaseAuth throws a 401 Response. Client pass:
  // attachSupabaseAuth throws its no-session/invalid-token errors, and the
  // middleware's 401 arrives as an error whose message is the response text.
  if (isAuthSessionError(error)) return true;
  return getErrorMessage(error).startsWith("Unauthorized:");
}

// The appendix reads as the signed agreement (Παράρτημα Α), so its sections are
// fixed contract headings, not the service_catalog categories. The catalog's
// categories are mapped onto them; anything unmapped lands in Α.5 so no agreed
// line can silently disappear from the document.
const SECTIONS = [
  { key: "A1", title: "Α.1 Ετήσιες Φορολογικές Δηλώσεις" },
  { key: "A2", title: "Α.2 Φορολογική Κατοικία" },
  { key: "A3", title: "Α.3 Μητρώο και Πρόσβαση" },
  { key: "A4", title: "Α.4 Επιχειρηματική Δραστηριότητα" },
  { key: "A5", title: "Α.5 Λοιπές Υπηρεσίες" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

const CATEGORY_TO_SECTION: Record<string, SectionKey> = {
  "B - Annual Tax Filings": "A1",
  "C - Tax Residency & Regimes": "A2",
  "A - Registration & Identity": "A3",
  "D - Freelancers": "A4",
};

// Greek decimal convention: comma for the decimal separator, dot for thousands,
// and the euro sign after the amount. The unit that follows comes from the view
// (price_unit_el), not from a label map here, so the wording stays with the data.
const amountFormatter = new Intl.NumberFormat("el-GR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function sectionForCategory(category: string | null): SectionKey {
  if (category && category in CATEGORY_TO_SECTION) return CATEGORY_TO_SECTION[category];
  return "A5";
}

function priceLabel(row: AppendixRow) {
  // A case_by_case line never shows a firm price, even when a figure is stored:
  // that figure is a starting point rather than an agreed rate, and the italic
  // note under the line carries the detail.
  if (row.wholesale_price === null || row.status === "case_by_case") {
    return "Κατά περίπτωση";
  }
  const amount = `${amountFormatter.format(row.wholesale_price)} €`;
  return row.price_unit_el ? `${amount} / ${row.price_unit_el}` : amount;
}

function AppendixLine({ row }: { row: AppendixRow }) {
  // Greek name leads. The English name and the service code sit underneath in
  // parentheses; when a line has no Greek name the English one is promoted to
  // the lead so the parenthetical never repeats what is already above it.
  const primaryName = row.service_name_el ?? row.service_name ?? row.service_code ?? "Υπηρεσία";
  const secondary = [row.service_name_el ? row.service_name : null, row.service_code]
    .filter((part): part is string => !!part)
    .join(" / ");

  // has_line false means the catalogue lists the service but this partner has
  // no agreed line for it. The service still appears, so the card reads as the
  // full list of services, but there is no price, SLA or note to show.
  if (!row.has_line) {
    return (
      <div className="py-3">
        <p className="text-sm font-semibold text-foreground">{primaryName}</p>
        {secondary && <p className="mt-0.5 text-xs text-muted-foreground">({secondary})</p>}
        <p className="mt-1 text-sm text-muted-foreground">Δεν έχει συμφωνηθεί</p>
      </div>
    );
  }

  return (
    <div className="py-3">
      <p className="text-sm font-semibold text-foreground">{primaryName}</p>
      {secondary && <p className="mt-0.5 text-xs text-muted-foreground">({secondary})</p>}
      <p className="mt-1 text-sm text-foreground">{priceLabel(row)}</p>
      {row.sla_days && (
        <p className="mt-0.5 text-xs text-muted-foreground">Εκτιμώμενος Χρόνος: {row.sla_days}</p>
      )}
      {row.notes && <p className="mt-0.5 text-xs italic text-muted-foreground">{row.notes}</p>}
    </div>
  );
}

function PartnerAppendixDocument({
  rows,
  partnerName,
}: {
  rows: AppendixRow[];
  partnerName: string | null;
}) {
  // Unagreed services (has_line false) carry no status, so they stay in their
  // category alongside the agreed lines rather than in the pending block, which
  // is reserved for lines that exist but are not yet confirmed.
  const agreedRows = rows.filter((row) => row.status !== "pending");
  const pendingRows = rows.filter((row) => row.status === "pending");

  const sections = SECTIONS.map((section) => ({
    ...section,
    rows: agreedRows.filter((row) => sectionForCategory(row.category) === section.key),
  })).filter((section) => section.rows.length > 0);

  return (
    <article className="rounded-xl border border-border bg-card px-6 py-8 shadow-sm sm:px-10">
      <header className="border-b border-border pb-6 text-center">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Ιδιωτικό Συμφωνητικό Συνεργασίας
        </p>
        <h2 className="mt-2 font-serif text-2xl font-semibold tracking-tight text-foreground">
          Παράρτημα Α: Τιμοκατάλογος Υπηρεσιών
        </h2>
        {partnerName && <p className="mt-2 text-sm text-muted-foreground">{partnerName}</p>}
      </header>

      {sections.length === 0 && pendingRows.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Δεν υπάρχουν ακόμη συμφωνημένες γραμμές τιμοκαταλόγου.
        </p>
      )}

      {sections.map((section) => (
        <section key={section.key} className="pt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground">
            {section.title}
          </h3>
          <div className="mt-1 divide-y divide-border/60">
            {section.rows.map((row, index) => (
              <AppendixLine
                key={`${row.partner_user_id}-${row.service_code ?? "no-code"}-${index}`}
                row={row}
              />
            ))}
          </div>
        </section>
      ))}

      {pendingRows.length > 0 && (
        <section className="mt-8 rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 dark:border-amber-700 dark:bg-amber-950/40">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
            Γραμμές προς επιβεβαίωση
          </h3>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            Οι παρακάτω τιμές δεν έχουν ακόμη συμφωνηθεί και δεν αποτελούν μέρος της ισχύουσας
            συμφωνίας.
          </p>
          <div className="mt-2 divide-y divide-amber-200 dark:divide-amber-800">
            {pendingRows.map((row, index) => (
              <AppendixLine
                key={`${row.partner_user_id}-${row.service_code ?? "no-code"}-${index}`}
                row={row}
              />
            ))}
          </div>
        </section>
      )}

      <footer className="mt-8 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">
          Οι τιμές αφορούν αποκλειστικά τη συνεργασία συνεργάτη και MyGreekTax και δεν
          κοινοποιούνται σε τρίτους. Όπου αναγράφεται «Κατά περίπτωση», η αμοιβή συμφωνείται πριν
          από την ανάθεση της εργασίας.
        </p>
      </footer>
    </article>
  );
}

function AppendixPendingComponent() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="rounded-xl border bg-card px-10 py-8">
        <div className="mx-auto h-4 w-1/3 animate-shimmer rounded bg-muted" />
        <div className="mt-6 space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-3 w-full animate-shimmer rounded bg-muted/50" />
          ))}
        </div>
      </div>
    </div>
  );
}

function AppendixErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  const isForbidden = getErrorMessage(error) === APPENDIX_FORBIDDEN_MESSAGE;

  if (isForbidden) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Card>
          <CardContent className="py-6">
            <h1 className="text-xl font-semibold tracking-tight">Δεν έχετε πρόσβαση</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Το Παράρτημα Α είναι διαθέσιμο μόνο σε ενεργούς συνεργάτες και στη διαχείριση. Αν
              πιστεύετε ότι πρόκειται για λάθος, επικοινωνήστε με τον διαχειριστή.
            </p>
            <Button asChild className="mt-4" variant="outline">
              <Link to="/dashboard">Επιστροφή στον πίνακα εργασιών</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Card>
        <CardContent className="py-6">
          <h1 className="text-xl font-semibold tracking-tight">
            Το Παράρτημα Α δεν είναι διαθέσιμο
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Δεν ήταν δυνατή η φόρτωση του τιμοκαταλόγου. Δοκιμάστε ξανά.
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              router.invalidate();
              reset();
            }}
          >
            Δοκιμή ξανά
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function AppendixPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const { impersonatingId } = useAuth();

  // Starting or exiting impersonation changes what this page should show, but
  // it happens outside the router (the banner in the root layout), so nothing
  // would otherwise re-run the loader. Reload when the two disagree.
  const loadedImpersonationId = data.impersonatedAccountantId ?? null;
  useEffect(() => {
    if ((impersonatingId ?? null) !== loadedImpersonationId) {
      router.invalidate();
    }
  }, [impersonatingId, loadedImpersonationId, router]);

  // One card at a time. A partner has no choice to make, so the selector is
  // admin only; changing it re-runs the loader with the new id, so the swap
  // happens on the server and no other partner's figures reach the browser.
  const showSelector = data.isAdmin && data.partners.length > 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {data.isAdmin && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Προβολή διαχείρισης
            </p>
            <p className="mt-1 text-sm text-foreground">
              Παράρτημα του συνεργάτη:{" "}
              <span className="font-medium">{data.partnerName ?? "Χωρίς όνομα"}</span>
            </p>
          </div>
          {showSelector && (
            <div className="relative">
              <label htmlFor="appendix-partner" className="sr-only">
                Επιλογή συνεργάτη
              </label>
              <select
                id="appendix-partner"
                value={data.selectedPartnerId ?? ""}
                onChange={(event) =>
                  navigate({
                    to: "/appendix",
                    search: { partner: event.target.value },
                    replace: true,
                  })
                }
                className="h-9 min-w-56 appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm"
              >
                {data.partners.map((partner) => (
                  <option key={partner.userId} value={partner.userId}>
                    {partner.fullName ?? partner.userId}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          )}
        </div>
      )}
      {data.isAdmin && data.partners.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Δεν υπάρχουν ενεργοί συνεργάτες.
          </CardContent>
        </Card>
      ) : (
        <PartnerAppendixDocument rows={data.rows} partnerName={data.partnerName} />
      )}
    </div>
  );
}
