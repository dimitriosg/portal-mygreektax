import { useSyncExternalStore } from "react";

// Light and dark, and who decides.
//
// Two audiences use this app and they want opposite defaults. Jim and the
// partners live in it all day and should get whatever their operating system
// is set to. Clients arrive once, from an email link, usually on a phone, to
// look at a payment request. A payment page that opens dark because their
// phone happens to be in night mode does not read as our brand at the exact
// moment it needs to, so the public client pages start light.
//
// An explicit choice outranks both and is remembered, because an option that
// resets on the next page load is not really an option. Before this existed
// the header toggle was per-render state and forgot itself on every reload.

export type ThemeChoice = "light" | "dark";

const STORAGE_KEY = "mgt-theme";

// Light rather than dark, so the server-rendered markup and the first client
// paint agree for the common case. A dark-mode admin gets one frame of light
// before the effect corrects it, which is the same trade the previous
// implementation made.
let current: ThemeChoice = "light";

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

// Storage can throw outright, not just come back empty: Safari in private
// mode, and any browser set to block site data. A theme preference is never
// worth breaking a payment page over, so every access is guarded.
function readStored(): ThemeChoice | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function writeStored(choice: ThemeChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Preference lost for this browser. The page still works.
  }
}

function applyToDocument(choice: ThemeChoice) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", choice === "dark");
}

export function getTheme(): ThemeChoice {
  return current;
}

export function setTheme(choice: ThemeChoice, options?: { remember?: boolean }) {
  if (options?.remember !== false) writeStored(choice);
  if (current === choice) {
    // Still reassert the class: initTheme calls this before the document has
    // necessarily caught up with the module's default.
    applyToDocument(choice);
    return;
  }
  current = choice;
  applyToDocument(choice);
  notify();
}

/**
 * Settle the theme for the page the client is actually on. Returns a cleanup
 * function, so callers can hand it straight back from useEffect.
 *
 * `preferLight` is for the public client pages. It only decides what happens
 * when the visitor has expressed no preference of their own.
 */
export function initTheme({ preferLight }: { preferLight: boolean }): () => void {
  const stored = readStored();
  if (stored) {
    setTheme(stored, { remember: false });
    return () => {};
  }

  if (preferLight) {
    setTheme("light", { remember: false });
    return () => {};
  }

  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const sync = () => setTheme(query.matches ? "dark" : "light", { remember: false });
  sync();

  // Keep following the device until the visitor picks for themselves. Once
  // they do, readStored above short-circuits this on the next navigation.
  query.addEventListener("change", sync);
  return () => query.removeEventListener("change", sync);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): ThemeChoice {
  // The server snapshot is deliberately the constant "light" rather than
  // `current`, which is module state a previous request could have moved.
  return useSyncExternalStore(subscribe, getTheme, () => "light" as const);
}
