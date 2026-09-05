"use client";

// WARP-2545 — the Customers / Deals switch at the top of the CRM page.
//
// Built on the SAME `pm-pills` tablist as `ViewSwitcher` rather than a second
// tab mechanism: one keyboard contract, one set of focus styles, and the two
// switchers on this page cannot drift apart visually. Roving tabindex per the
// WAI-ARIA tabs pattern, so the group is one tab stop and arrow keys move
// within it.
//
// WARP-2558 (ADR-044) — the third tab, `projects`, is GONE, and with it the
// reason this switch existed on someone else's page. It made /projects the
// container AND one of the three things in the container, so the page had to
// negate six render branches against `onCrmTab` and rename its own header
// when the CRM module flipped. The CRM now has /customers; a tab that
// navigates to a different SECTION is a nav entry, not a tab. Adding a third
// entry here that is not a view of the same records reopens exactly that.

import { useRef, type JSX } from "react";

import { PmIcon } from "@/components/projects/icons";

export type CrmTab = "customers" | "deals";

const TABS: Array<[CrmTab, string, string]> = [
  ["customers", "Customers", "building"],
  ["deals", "Deals", "briefcase"],
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
