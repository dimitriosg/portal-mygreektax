import { useEffect, type ReactNode } from "react";
import { useState } from "react";
import { ChevronRight, Maximize2, X } from "lucide-react";

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

  const showBody = popped || !collapsible || !collapsed;

  const head = (
    <div className="card-head">
      {collapsible && !popped && (
        <button
          className="disc"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        >
          <ChevronRight size={15} />
        </button>
      )}
      <h2>{title}</h2>
      {headerExtras}
      <div className="head-actions">
        <button
          className="icon-btn"
          onClick={() => setPopped((p) => !p)}
          title={popped ? "Close the window" : "Open in a focused window"}
          aria-label={popped ? "Close the window" : "Open in a focused window"}
        >
          {popped ? <X size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
    </div>
  );

  if (popped) {
    return (
      <>
        <section className="card" style={{ opacity: 0.6 }}>
          <div className="card-head">
            <h2>{title}</h2>
            <span className="head-actions stamp">Open in a window</span>
          </div>
        </section>

        <div
          className="mgt-case-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPopped(false);
          }}
        >
          <div className="mgt-case-sheet">
            <div className="sheet-head">
              <h2>{title}</h2>
              {headerExtras}
              <div className="head-actions">
                <button
                  className="icon-btn"
                  onClick={() => setPopped(false)}
                  title="Close"
                  aria-label="Close the window"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="sheet-body">{children}</div>
          </div>
        </div>
      </>
    );
  }

  return (
    <section className="card" data-open={showBody}>
      {head}
      {showBody && <div className="card-body">{children}</div>}
    </section>
  );
}
