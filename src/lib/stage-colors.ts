// Pill colour classes per pipeline stage, shared by the case workspace
// (/drafts) and the case page so a stage reads the same colour everywhere.
// These supply background, text, and border-colour utilities; pair them with a
// `border` width utility at the call site.

const STAGE_BADGE_CLASSES: Record<string, string> = {
  Potential: "bg-blue-50 text-blue-700 border-blue-200",
  Quoted: "bg-amber-50 text-amber-700 border-amber-200",
  Active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Parked: "bg-slate-100 text-slate-600 border-slate-200",
  Complete: "bg-violet-50 text-violet-700 border-violet-200",
  Lost: "bg-red-50 text-red-700 border-red-200",
};

const STAGE_BADGE_FALLBACK = "bg-slate-100 text-slate-600 border-slate-200";

export function stageBadgeClass(stage: string | null | undefined): string {
  return (stage && STAGE_BADGE_CLASSES[stage]) || STAGE_BADGE_FALLBACK;
}
