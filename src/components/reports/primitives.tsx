import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/** A KPI tile. `note` renders as a warning, because a caveat on a number belongs beside it. */
export function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {note && (
          <div className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{note}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A note about what the figures above can and cannot see. Not decoration: the
 * lead funnel is reconstructed from an event log that starts partway through
 * the business's life, and a reader who does not know that will read a partial
 * funnel as a complete one.
 */
export function CoverageNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function EmptySection({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-6 text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}
