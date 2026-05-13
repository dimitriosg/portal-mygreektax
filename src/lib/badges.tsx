import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  "To Assign": "bg-slate-200 text-slate-800 hover:bg-slate-200",
  Sent: "bg-blue-100 text-blue-800 hover:bg-blue-100",
  "In Progress": "bg-amber-100 text-amber-900 hover:bg-amber-100",
  Pending: "bg-orange-100 text-orange-900 hover:bg-orange-100",
  Delivered: "bg-indigo-100 text-indigo-800 hover:bg-indigo-100",
  Invoiced: "bg-purple-100 text-purple-800 hover:bg-purple-100",
  Paid: "bg-teal-100 text-teal-900 hover:bg-teal-100",
  Completed: "bg-green-100 text-green-800 hover:bg-green-100",
};

const TIER_STYLES: Record<string, string> = {
  Bronze: "bg-amber-100 text-amber-900 hover:bg-amber-100 border border-amber-300",
  Silver: "bg-slate-100 text-slate-800 hover:bg-slate-100 border border-slate-300",
  Gold: "bg-yellow-100 text-yellow-900 hover:bg-yellow-100 border border-yellow-300",
  Platinum: "bg-cyan-100 text-cyan-900 hover:bg-cyan-100 border border-cyan-300",
  Diamond: "bg-sky-100 text-sky-900 hover:bg-sky-100 border border-sky-300",
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
