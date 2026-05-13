import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  "To Assign":
    "border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-100",
  Pending:
    "border-orange-300 bg-orange-100 text-orange-900 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-950/60 dark:text-orange-100",
  Paid: "border-teal-300 bg-teal-100 text-teal-900 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-100",
  "In Progress":
    "border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100",
  Delivered:
    "border-indigo-300 bg-indigo-100 text-indigo-800 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-100",
  Invoiced:
    "border-purple-300 bg-purple-100 text-purple-800 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950/60 dark:text-purple-100",
  Completed:
    "border-green-300 bg-green-100 text-green-800 hover:bg-green-100 dark:border-green-800 dark:bg-green-950/60 dark:text-green-100",
  "Cancelled / NMF":
    "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/10 dark:border-destructive/40 dark:bg-destructive/15 dark:text-destructive",
};

const TIER_STYLES: Record<string, string> = {
  Bronze: "bg-amber-100 text-amber-900 hover:bg-amber-100 border border-amber-300",
  Silver: "bg-slate-100 text-slate-800 hover:bg-slate-100 border border-slate-300",
  Gold: "bg-yellow-100 text-yellow-900 hover:bg-yellow-100 border border-yellow-300",
  Platinum: "bg-cyan-100 text-cyan-900 hover:bg-cyan-100 border border-cyan-300",
  Diamond: "bg-sky-100 text-sky-900 hover:bg-sky-100 border border-sky-300",
};

const NEXT_ACTION_STYLES: Record<string, string> = {
  Admin:
    "border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-100",
  Partner:
    "border-cyan-300 bg-cyan-100 text-cyan-900 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-100",
  Client:
    "border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100",
  AADE: "border-indigo-300 bg-indigo-100 text-indigo-800 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-100",
  None: "border-slate-300 bg-slate-200 text-slate-800 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-100",
};

export function StatusBadge({ status, className }: { status?: string | null; className?: string }) {
  const key = status ?? "—";
  const style =
    (status && STATUS_STYLES[status]) || "bg-muted text-muted-foreground hover:bg-muted";
  return <Badge className={cn("font-medium", style, className)}>{key}</Badge>;
}

export function TierBadge({ tier, className }: { tier?: string | null; className?: string }) {
  if (!tier) return <span className="text-muted-foreground">—</span>;
  const style = TIER_STYLES[tier] || "bg-muted text-foreground hover:bg-muted border border-border";
  return <Badge className={cn("font-medium", style, className)}>{tier}</Badge>;
}

export function NextActionBadge({
  value,
  className,
}: {
  value?: string | null;
  className?: string;
}) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const style =
    NEXT_ACTION_STYLES[value] || "border-border bg-muted text-muted-foreground hover:bg-muted";
  return <Badge className={cn("font-medium", style, className)}>{value}</Badge>;
}
