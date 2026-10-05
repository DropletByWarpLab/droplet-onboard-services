"use client";

// WARP-3537 — the two controls that change how the list or the table is drawn: "Group
// by" (brief §3.3's `.pills`) and, for the table, the column picker. They edit the
// view's display options (`useTableDisplay`), which a saved view persists — not a
// setting of their own.
//
// The group-by options are the ones this layout and place can draw and name
// (`groupOptions`): no cycle or module (nothing lists them yet), no type (no column).
// The column picker offers the registry's columns for the scope; the title is always on.

import { useRef, useState, type JSX } from "react";
import {
  PM_TABLE_COLUMN_IDS,
  PM_TABLE_REQUIRED_COLUMN,
  tableColumnsFor,
  type PmGroupByField,
  type PmTableColumnId,
  type PmTableScope,
} from "@droplet/shared-types";
import { PmIcon } from "../icons";
import { COLUMN_DEFS } from "./columns";
import { FloatingMenu } from "./FloatingMenu";
import { groupOptions, type DisplayLayout } from "./grouping";

export interface DisplayControlsProps {
  layout: DisplayLayout;
  scope: PmTableScope;
  /** The group-by drawn now (the layout's default resolved). */
  groupBy: PmGroupByField | null;
  onGroupBy: (g: PmGroupByField | null) => void;
  /** The columns drawn now (table only). */
  columns: readonly PmTableColumnId[];
  onColumns: (ids: PmTableColumnId[]) => void;
  /** Are there any departments to group by. */
  departments: boolean;
}

export function DisplayControls(p: DisplayControlsProps): JSX.Element {
  const options = groupOptions(p.scope, p.layout, { departments: p.departments });
  return (
    <div className="pm-row" style={{ gap: 10, flexWrap: "wrap" }}>
      <div className="pm-pills" role="group" aria-label="Group by">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={p.groupBy === o.value ? "on" : ""}
            aria-pressed={p.groupBy === o.value}
            onClick={() => p.onGroupBy(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {p.layout === "table" && <ColumnPicker scope={p.scope} columns={p.columns} onColumns={p.onColumns} />}
    </div>
  );
}

function ColumnPicker({
  scope,
  columns,
  onColumns,
}: {
  scope: PmTableScope;
  columns: readonly PmTableColumnId[];
  onColumns: (ids: PmTableColumnId[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const offered = tableColumnsFor(scope);

  const toggle = (id: PmTableColumnId) => {
    if (id === PM_TABLE_REQUIRED_COLUMN) return;
    const on = new Set(columns);
    if (!on.delete(id)) on.add(id);
    // Canonical order, not click order: a column does not move because it was the last one ticked.
    onColumns(PM_TABLE_COLUMN_IDS.filter((c) => on.has(c)));
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="pm-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <PmIcon name="layers" size={14} />
        Columns
      </button>
      <FloatingMenu anchor={btn.current} open={open} onClose={() => setOpen(false)} label="Choose columns" role="dialog">
        <fieldset className="pm-pop-list" style={{ margin: 0 }}>
          <legend className="sr-only">Columns</legend>
          {offered.map((id) => (
            <label key={id} className="pm-pop-row">
              <input
                type="checkbox"
                checked={columns.includes(id)}
                disabled={id === PM_TABLE_REQUIRED_COLUMN}
                onChange={() => toggle(id)}
              />
              <span>{COLUMN_DEFS[id].label}</span>
            </label>
          ))}
        </fieldset>
        <div className="pm-pop-f">
          <button type="button" className="pm-btn ghost sm" onClick={() => onColumns([])}>
            Reset to default
          </button>
          <button type="button" className="pm-btn primary sm" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </FloatingMenu>
    </>
  );
}
