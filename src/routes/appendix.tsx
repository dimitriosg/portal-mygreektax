import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import {
  getAppendix,
  APPENDIX_FORBIDDEN_MESSAGE,
  type AppendixRow,
} from "@/lib/appendix.functions";
import { formatDate } from "@/lib/utils";

export const Route = createFileRoute("/appendix")({
  component: AppendixPage,
});

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

const PRICE_UNIT_LABELS: Record<string, string> = {
  per_job: "ανά εργασία",
  per_month: "ανά μήνα",
  per_year: "ανά έτος",
  per_person: "ανά άτομο",
  per_line: "ανά γραμμή",
  per_extra_year: "ανά επιπλέον έτος",
  per_treaty: "ανά σύμβαση (ΣΑΔΦ)",
};

const euroFormatter = new Intl.NumberFormat("el-GR", {
  style: "currency",
  currency: "EUR",
});

function sectionForCategory(category: string | null): SectionKey {
  if (category && category in CATEGORY_TO_SECTION) return CATEGORY_TO_SECTION[category];
  return "A5";
}

function priceLabel(row: AppendixRow) {
  if (row.wholesale_price === null || row.status === "case_by_case") {
    return "Κατά περίπτωση";
  }
  const unit = row.price_unit ? (PRICE_UNIT_LABELS[row.price_unit] ?? row.price_unit) : null;
  const amount = euroFormatter.format(row.wholesale_price);
  return unit ? `${amount} ${unit}` : amount;
}

function AppendixLine({ row }: { row: AppendixRow }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm text-foreground">
          {row.service_name ?? row.service_code ?? "Υπηρεσία"}
          {row.service_code && (
            <span className="ml-2 text-xs text-muted-foreground">{row.service_code}</span>
          )}
        </p>
        {row.notes && <p className="mt-0.5 text-xs text-muted-foreground">{row.notes}</p>}
      </div>
      <div className="shrink-0 text-left sm:text-right">
        <p className="text-sm font-medium text-foreground">{priceLabel(row)}</p>
        {row.sla_days && <p className="text-xs text-muted-foreground">SLA: {row.sla_days}</p>}
      </div>
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
  const agreedRows = rows.filter((row) => row.status !== "pending");
  const pendingRows = rows.filter((row) => row.status === "pending");
  const effectiveFrom = useMemo(() => {
    const dates = agreedRows
      .map((row) => row.effective_from)
      .filter((value): value is string => !!value)
      .sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
  }, [agreedRows]);

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
        {effectiveFrom && (
          <p className="mt-1 text-xs text-muted-foreground">
            Σε ισχύ από {formatDate(effectiveFrom)}
          </p>
        )}
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
            {section.rows.map((row) => (
              <AppendixLine key={`${row.partner_user_id}-${row.service_code}`} row={row} />
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
            {pendingRows.map((row) => (
              <AppendixLine key={`${row.partner_user_id}-${row.service_code}`} row={row} />
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

function AppendixPage() {
  const { user, loading, sessionReady, accessStatus } = useAuth();
  const navigate = useNavigate();
  const fetchAppendix = useServerFn(getAppendix);

  useEffect(() => {
    if (loading) return;
    if (!user) navigate({ to: "/login", replace: true });
  }, [loading, user, navigate]);

  const query = useQuery({
    queryKey: ["appendix", user?.id],
    queryFn: () => fetchAppendix(),
    enabled: !loading && !!user && sessionReady && accessStatus === "resolved",
    throwOnError: false,
    retry: (failureCount, error) =>
      getErrorMessage(error) !== APPENDIX_FORBIDDEN_MESSAGE && failureCount < 2,
  });

  useEffect(() => {
    if (query.error && isAuthSessionError(query.error)) {
      navigate({ to: "/login", replace: true });
    }
  }, [query.error, navigate]);

  const isForbidden =
    (!!query.error && getErrorMessage(query.error) === APPENDIX_FORBIDDEN_MESSAGE) ||
    accessStatus === "unauthorized";

  const partnerDocuments = useMemo(() => {
    const rows = query.data?.rows ?? [];
    const names = query.data?.partnerNames ?? {};
    const byPartner = new Map<string, AppendixRow[]>();
    for (const row of rows) {
      if (!row.partner_user_id) continue;
      const existing = byPartner.get(row.partner_user_id);
      if (existing) existing.push(row);
      else byPartner.set(row.partner_user_id, [row]);
    }
    return [...byPartner.entries()]
      .map(([partnerUserId, partnerRows]) => ({
        partnerUserId,
        partnerName: names[partnerUserId] ?? null,
        rows: partnerRows,
      }))
      .sort((a, b) => (a.partnerName ?? "").localeCompare(b.partnerName ?? "", "el"));
  }, [query.data]);

  if (loading || (!!user && !sessionReady)) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 text-sm text-muted-foreground">
        Φόρτωση του Παραρτήματος Α…
      </div>
    );
  }

  if (!user) return null;

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
          </CardContent>
        </Card>
      </div>
    );
  }

  if (query.error && !isAuthSessionError(query.error)) {
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
            <Button className="mt-4" onClick={() => query.refetch()}>
              Δοκιμή ξανά
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (query.isLoading || !query.data) {
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

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {query.data.isAdmin && (
        <p className="mb-4 text-sm text-muted-foreground">
          Προβολή διαχείρισης: εμφανίζονται τα παραρτήματα όλων των συνεργατών.
        </p>
      )}
      {partnerDocuments.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Δεν υπάρχουν ακόμη γραμμές τιμοκαταλόγου.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {partnerDocuments.map((document) => (
            <PartnerAppendixDocument
              key={document.partnerUserId}
              rows={document.rows}
              partnerName={document.partnerName}
            />
          ))}
        </div>
      )}
    </div>
  );
}
