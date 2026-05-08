// Lightweight client-side analytics helper for Plausible.
//
// The Plausible script is host-gated in __root.tsx so it only loads on the
// production domain. On previews / localhost, `window.plausible` is undefined
// and `track()` becomes a no-op — safe to call from anywhere.
//
// Privacy: never pass emails, names, IDs, or tokens. Use coarse categorical
// values only (tier, role, status, etc.).

type Props = Record<string, string | number | boolean | undefined | null>;

declare global {
  interface Window {
    plausible?: (
      eventName: string,
      options?: { props?: Record<string, string | number | boolean> }
    ) => void;
  }
}

export function track(event: string, props?: Props): void {
  if (typeof window === "undefined") return;
  const fn = window.plausible;
  if (typeof fn !== "function") return;
  let cleanProps: Record<string, string | number | boolean> | undefined;
  if (props) {
    cleanProps = {};
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      cleanProps[k] = v;
    }
  }
  try {
    fn(event, cleanProps ? { props: cleanProps } : undefined);
  } catch {
    // never let analytics break the app
  }
}