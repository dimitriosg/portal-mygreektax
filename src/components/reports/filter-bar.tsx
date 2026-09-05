import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, formatDate } from "@/lib/utils";
import { hasActiveFilters, type ReportFilters } from "@/lib/reports-aggregate";

// The one filter bar for every tab. Date range applies everywhere; the
// chip row is contextual, because "status" means a job status on Pipeline and a
// lead stage on Funnel and Sources. Showing both at once would ask which of two
// different things a chip called "Active" refers to.

type FacetMode = "jobs" | "leads" | "none";

/** ISO yyyy-mm-dd in local time. toISOString would shift the day west of UTC. */
function isoDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function parseDay(value?: string): Date | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

export function ReportsFilterBar({
  filters,
  onChange,
  mode,
  facetOptions,
}: {
  filters: ReportFilters;
  onChange: (next: ReportFilters) => void;
  mode: FacetMode;
  facetOptions: string[];
}) {
  const range: DateRange | undefined =
    filters.from || filters.to
      ? { from: parseDay(filters.from), to: parseDay(filters.to) }
      : undefined;

  const selected = (mode === "jobs" ? filters.status : filters.stage) ?? [];

  function setRange(next: DateRange | undefined) {
    onChange({
      ...filters,
      from: next?.from ? isoDay(next.from) : undefined,
      to: next?.to ? isoDay(next.to) : undefined,
    });
  }

  function preset(months: number | null) {
    if (months === null) {
      onChange({ ...filters, from: undefined, to: undefined });
      return;
    }
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - months);
    onChange({ ...filters, from: isoDay(from), to: isoDay(to) });
  }

  function toggleFacet(value: string) {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(
      mode === "jobs"
        ? { ...filters, status: next.length ? next : undefined }
        : { ...filters, stage: next.length ? next : undefined },
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn("justify-start font-normal", !range?.from && "text-muted-foreground")}
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {range?.from
                ? range.to
                  ? `${formatDate(range.from)} – ${formatDate(range.to)}`
                  : formatDate(range.from)
                : "All dates"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={range}
              onSelect={setRange}
              numberOfMonths={2}
              initialFocus
              className={cn("p-3 pointer-events-auto")}
            />
          </PopoverContent>
        </Popover>

        <Button variant="ghost" size="sm" onClick={() => preset(1)}>
          Last month
        </Button>
        <Button variant="ghost" size="sm" onClick={() => preset(3)}>
          Last 3 months
        </Button>
        <Button variant="ghost" size="sm" onClick={() => preset(null)}>
          All time
        </Button>

        {hasActiveFilters(filters) && (
          <Button variant="outline" size="sm" onClick={() => onChange({})} className="ml-auto">
            Clear filters
          </Button>
        )}
      </div>

      {mode !== "none" && facetOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {mode === "jobs" ? "Job status" : "Lead stage"}
          </span>
          {facetOptions.map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => toggleFacet(option)}
                aria-pressed={active}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  active
                    ? "border-foreground/30 bg-muted font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/50",
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
      )}

      {hasActiveFilters(filters) && (
        <p className="text-xs text-muted-foreground">
          Filters active — every figure below is for the filtered set only.
        </p>
      )}
    </div>
  );
}
