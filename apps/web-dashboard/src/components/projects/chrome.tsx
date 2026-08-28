"use client";

// In-page chrome for project views: view switcher, saved-view chips, search.

import { PmIcon } from "./icons";

import type { JSX } from "react";

export type ProjectView = "board" | "list" | "cycles" | "modules";
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
    ["cycles", "Cycles", "target"],
    ["modules", "Modules", "layers"],
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

export function SavedViews({
  active,
  onPick,
  counts,
}: {
  active: SavedView;
  onPick: (v: SavedView) => void;
  counts: Record<SavedView, number>;
}): JSX.Element {
  const views: Array<[SavedView, string]> = [
    ["all", "All"],
    ["mine", "My items"],
    ["active", "Active"],
    ["overdue", "Overdue"],
    ["noassignee", "No assignee"],
  ];
  return (
    <div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}>
      {views.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={"pm-chip" + (active === id ? " on" : "")}
          aria-current={active === id ? "true" : undefined}
          onClick={() => onPick(id)}
        >
          {label}
          <span className="n">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}

export function FilterBar({ q, onQ }: { q: string; onQ: (v: string) => void }): JSX.Element {
  return (
    <div className="pm-row" style={{ gap: 10, flexWrap: "wrap" }}>
      <div className="pm-search" style={{ minWidth: 240 }}>
        <PmIcon name="search" size={14} />
        <input
          placeholder="Search work items"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          aria-label="Search work items"
        />
      </div>
      <span className="pm-row" style={{ gap: 7, marginLeft: 6, fontSize: 12.5, color: "var(--text-3)" }}>
        Group by <strong style={{ color: "var(--text-2)", fontWeight: 600 }}>state</strong>
      </span>
    </div>
  );
}
