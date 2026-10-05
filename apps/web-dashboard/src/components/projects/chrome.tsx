"use client";

// In-page chrome for project views: the view switcher. The filter bar and the
// saved-view chips live in FilterBar.tsx and ViewChips.tsx (WARP-3522).

import { PmIcon } from "./icons";

import type { JSX } from "react";

export type ProjectView = "board" | "list" | "table" | "calendar" | "timeline" | "cycles" | "modules" | "insights" | "time";
export type SavedView = "all" | "mine" | "active" | "overdue" | "noassignee";

export function ViewSwitcher({
  view,
  onView,
}: {
  view: ProjectView;
  onView: (v: ProjectView) => void;
}): JSX.Element {
  const tabs: Array<[ProjectView, string, string]> = [
    ["board", "Board", "board"],
    ["list", "List", "list"],
    ["table", "Table", "table"],
    ["calendar", "Calendar", "cal"],
    ["timeline", "Timeline", "gantt"],
    ["cycles", "Cycles", "target"],
    ["modules", "Modules", "layers"],
    ["insights", "Insights", "chart"],
    ["time", "Time", "clock"],
  ];
  return (
    <div className="pm-pills" role="tablist" aria-label="View">
      {tabs.map(([id, label, icon]) => (
        <button
          key={id}
          className={view === id ? "on" : ""}
          role="tab"
          aria-selected={view === id}
          type="button"
          onClick={() => onView(id)}
        >
          <PmIcon name={icon} size={13} sw={view === id ? 2 : 1.6} />
          {label}
        </button>
      ))}
    </div>
  );
}
