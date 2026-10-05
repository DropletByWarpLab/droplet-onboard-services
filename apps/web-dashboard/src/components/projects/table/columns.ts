// WARP-3537 — the table's column registry: the dashboard's half of the column
// vocabulary. WHICH ids exist, which a scope offers and what a table opens with is
// shared-types' (`pm-table.ts`); this says what each one is called, how wide it is,
// whether its header can sort and whether its cells can be edited in place.
//
// Pure — no React — so the whole table layout (header, grid, picker) is derived
// from one definition and a test can hold it to the vocabulary.

import { PM_TABLE_COLUMN_IDS, type PmSortField, type PmTableColumnId } from "@droplet/shared-types";

export interface ColumnDef {
  id: PmTableColumnId;
  /** Header text — sentence case (brief §6). */
  label: string;
  /** One CSS grid track. No spaces inside it: the template is split on them in tests. */
  width: string;
  /** The server sort field a click on the header orders by, or null: the server cannot order by it. */
  sortField: PmSortField | null;
}

export const COLUMN_DEFS: Record<PmTableColumnId, ColumnDef> = {
  key: { id: "key", label: "Key", width: "92px", sortField: "key" },
  name: { id: "name", label: "Title", width: "minmax(240px,1fr)", sortField: "name" },
  project: { id: "project", label: "Project", width: "140px", sortField: null },
  state: { id: "state", label: "State", width: "140px", sortField: "state" },
  priority: { id: "priority", label: "Priority", width: "116px", sortField: "priority" },
  assignees: { id: "assignees", label: "Assignees", width: "112px", sortField: null },
  labels: { id: "labels", label: "Labels", width: "176px", sortField: null },
  dueDate: { id: "dueDate", label: "Due date", width: "108px", sortField: "dueDate" },
  startDate: { id: "startDate", label: "Start date", width: "108px", sortField: "startDate" },
  createdAt: { id: "createdAt", label: "Created", width: "108px", sortField: "createdAt" },
  updatedAt: { id: "updatedAt", label: "Updated", width: "108px", sortField: "updatedAt" },
  department: { id: "department", label: "Department", width: "152px", sortField: null },
  comments: { id: "comments", label: "Comments", width: "96px", sortField: null },
  subItems: { id: "subItems", label: "Sub-items", width: "96px", sortField: null },
};

// A table that did not cover the vocabulary would draw nothing for a saved column.
// Fail at import, not on a customer's screen.
for (const id of PM_TABLE_COLUMN_IDS) {
  if (!COLUMN_DEFS[id]) throw new Error(`table column "${id}" has no definition`);
}

export function sortFieldOf(id: PmTableColumnId): PmSortField | null {
  return COLUMN_DEFS[id].sortField;
}

/** The cells that can be edited where they stand (spec: state, priority, assignee and
 *  due date; the title too, brief §4.2). Everything else is read-only here. */
export const EDITABLE_COLUMNS: ReadonlySet<PmTableColumnId> = new Set<PmTableColumnId>([
  "name",
  "state",
  "priority",
  "assignees",
  "dueDate",
]);

export const SELECT_COLUMN_WIDTH = "40px";

/** The grid's `grid-template-columns`: the checkbox first when the person can select. */
export function gridTemplate(columns: readonly PmTableColumnId[], withSelect: boolean): string {
  const tracks = columns.map((c) => COLUMN_DEFS[c].width);
  return (withSelect ? [SELECT_COLUMN_WIDTH, ...tracks] : tracks).join(" ");
}

/** The narrowest the grid can be before it scrolls sideways: every fixed track, and the title at its minimum. */
export function gridMinWidth(columns: readonly PmTableColumnId[], withSelect: boolean): number {
  const px = (track: string) => Number(/(\d+)px/.exec(track)?.[1] ?? 0);
  return columns.reduce((sum, c) => sum + px(COLUMN_DEFS[c].width), withSelect ? px(SELECT_COLUMN_WIDTH) : 0);
}
