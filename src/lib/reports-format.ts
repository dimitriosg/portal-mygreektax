// Display formatting for /admin/reports.
//
// Separate from the chart components so the page and the charts share one
// definition, and so neither file exports a non-component alongside components.

// Every figure on the reports page is the value of work on the books, taken
// from jobs.client_fee and jobs.accountant_fee. None of it is money received,
// so nothing here is a cash formatter. Whole euros: the fees are whole euros
// and cents would imply a precision the source does not have.
export function formatEuro(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Takes a fraction, prints a percentage. The views return fractions. */
export function formatPct(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(1)}%`;
}
