import { useEffect, type ReactNode } from "react";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// A case-page section that can be read in place or opened in a focused window.
//
// The children render exactly once, either inline or inside the overlay, never
// both. That keeps a single source of truth: notes added while popped out are
// the same rows when it closes. The trade is a remount on open, which is fine
// for anything backed by the database and reloads itself, and costs local
// component state (a scope selector, a scroll position) for anything that is
// not.
//
// Escape and a backdrop click both close. The page behind dims rather than
// disappearing, so it stays clear that this is the same case, not a new screen.

interface Props {
  title: string;
  children: ReactNode;
  /** Rendered in the header, left of the controls. Badges, counts, buttons. */
  headerExtras?: ReactNode;
  /** Start collapsed. Defaults to true, matching the rest of the case page. */
  defaultCollapsed?: boolean;
  /** Hide the collapse control for sections that manage their own view state. */
  collapsible?: boolean;
}

export function PopOutSection({
  title,
  children,
  headerExtras,
  defaultCollapsed = true,
  collapsible = true,
}: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [popped, setPopped] = useState(false);

  useEffect(() => {
    if (!popped) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopped(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [popped]);

  const header = (
    <div className="flex items-center gap-2 flex-wrap">
      <h2 className="text-sm font-medium text-slate-500 uppercase tracking-wide">{title}</h2>
      {headerExtras}
      <span className="ml-auto flex items-center gap-1.5">
        {collapsible && !popped && (
          <Button
            variant="outline"
            onClick={() => setCollapsed((c) => !c)}
            className="h-7 px-2.5 text-xs"
          >
            {collapsed ? "Show" : "Collapse"}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => setPopped((p) => !p)}
          className="h-7 px-2 text-xs"
          title={popped ? "Close the window" : "Open in a focused window"}
          aria-label={popped ? "Close the window" : "Open in a focused window"}
        >
          {popped ? "Close" : "Expand"}
        </Button>
      </span>
    </div>
  );

  const showBody = popped || !collapsible || !collapsed;

  if (popped) {
    return (
      <>
        <Card className="border-slate-200 border-dashed">
          <CardContent className="py-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
                {title}
              </h2>
              <span className="ml-auto text-xs text-slate-400">Open in a window</span>
            </div>
          </CardContent>
        </Card>

        <div
          className="fixed inset-0 bg-black/40 flex items-start justify-center p-4 sm:p-10 z-50 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPopped(false);
          }}
        >
          <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full">
            <div className="px-5 py-3 border-b border-slate-200">{header}</div>
            <div className="p-5">{children}</div>
          </div>
        </div>
      </>
    );
  }

  return (
    <Card className="border-slate-200">
      <CardContent className="py-4 space-y-3">
        {header}
        {showBody && children}
        {!showBody && <p className="text-xs text-slate-400 italic">{title} collapsed.</p>}
      </CardContent>
    </Card>
  );
}
