import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a date as dd/mm/yyyy. Accepts ISO strings, Date, arrays (lookup fields), or null/undefined. */
export function formatDate(value: string | Date | string[] | null | undefined): string {
  if (value == null) return "—";
  let raw: string | Date;
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    raw = value[0];
  } else {
    raw = value;
  }
  if (!raw) return "—";
  const d = raw instanceof Date ? raw : new Date(raw);
  if (isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Format a datetime as dd/mm/yyyy HH:mm. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}
