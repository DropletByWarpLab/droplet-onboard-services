"use client";

import { useEffect, useState, type JSX } from "react";
import { PmIcon } from "../../icons";
import { useWorkItemSearch } from "../../useEditing";
import type { PmWorkItem } from "../../types";

/**
 * Search-and-pick for one work item, used by the parent field and the relations
 * panel. Matches by title or by key (`INBOX-12`) through the workspace search
 * the assistant uses; results are plain buttons, so Tab / Enter / Space work
 * without a custom listbox. `filter` removes candidates the caller already knows
 * are invalid (the item itself, items in another project for a parent); the API
 * stays the authority and refuses anything that slips through.
 *
 * Escape closes just this picker (`onCancel`) and stops there, so it never
 * closes the drawer around it.
 */
export function ItemSearchPicker({
  label,
  hint,
  filter,
  onPick,
  onCancel,
}: {
  label: string;
  hint?: string;
  filter?: (item: PmWorkItem) => boolean;
  onPick: (item: PmWorkItem) => void;
  onCancel: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState("");
  // Debounce: one search per pause in typing, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSettled(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { results, isLoading } = useWorkItemSearch(settled);
  const shown = (results ?? []).filter((r) => (filter ? filter(r) : true));
  const searching = settled.trim() !== "";

  return (
    <div
      className="pm-picker"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        className="pm-input sm"
        type="search"
        placeholder="Search by title or key"
        aria-label={label}
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pm-picker-list" role="group" aria-label="Matching work items" aria-busy={isLoading}>
        {!searching ? (
          <div className="pm-picker-note">Type a title or a key like INBOX-12.</div>
        ) : isLoading && results === undefined ? (
          <div className="pm-picker-note">Searching…</div>
        ) : shown.length === 0 ? (
          <div className="pm-picker-note">No work items match that search.</div>
        ) : (
          shown.map((r) => (
            <button key={r.id} type="button" className="pm-picker-item" onClick={() => onPick(r)}>
              <span className="pm-mono" style={{ fontSize: 11, color: "var(--text-4)", flex: "none" }}>
                {r.key}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
              </span>
            </button>
          ))
        )}
      </div>
      {hint && <div className="pm-picker-note">{hint}</div>}
      <div>
        <button type="button" className="pm-btn ghost sm" onClick={onCancel}>
          <PmIcon name="x" size={12} />
          Cancel
        </button>
      </div>
    </div>
  );
}
