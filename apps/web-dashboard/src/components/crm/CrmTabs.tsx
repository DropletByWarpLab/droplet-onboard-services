"use client";

// WARP-2545 — the Customers / Deals / Projects switch at the top of the
// (renamed) CRM page.
//
// Built on the SAME `pm-pills` tablist as `ViewSwitcher` rather than a second
// tab mechanism: one keyboard contract, one set of focus styles, and the two
// switchers on this page cannot drift apart visually. Roving tabindex per the
// WAI-ARIA tabs pattern, so the group is one tab stop and arrow keys move
// within it.

import { useRef, type JSX } from "react";

import { PmIcon } from "@/components/projects/icons";

export type CrmTab = "customers" | "deals" | "projects";

const TABS: Array<[CrmTab, string, string]> = [
  ["customers", "Customers", "building"],
  ["deals", "Deals", "briefcase"],
  ["projects", "Projects", "board"],
];

export function CrmTabs({
  tab,
  onTab,
}: {
  tab: CrmTab;
  onTab: (t: CrmTab) => void;
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) {
      if (e.key === "Home") {
        e.preventDefault();
        refs.current[0]?.focus();
        onTab(TABS[0][0]);
      } else if (e.key === "End") {
        e.preventDefault();
        refs.current[TABS.length - 1]?.focus();
        onTab(TABS[TABS.length - 1][0]);
      }
      return;
    }
    e.preventDefault();
    // Wraps, which is what the tabs pattern specifies — stopping at the end
    // makes a three-item group feel broken.
    const next = (index + delta + TABS.length) % TABS.length;
    refs.current[next]?.focus();
    onTab(TABS[next][0]);
  }

  return (
    <div className="pm-pills" role="tablist" aria-label="CRM section">
      {TABS.map(([id, label, icon], i) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={tab === id ? "on" : ""}
          role="tab"
          aria-selected={tab === id}
          // Roving tabindex: only the selected tab is in the tab order, so the
          // whole group is one stop rather than three.
          tabIndex={tab === id ? 0 : -1}
          type="button"
          onClick={() => onTab(id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <PmIcon name={icon} size={13} sw={tab === id ? 2 : 1.6} />
          {label}
        </button>
      ))}
    </div>
  );
}
