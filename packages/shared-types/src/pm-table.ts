/**
 * WARP-3537 (WS-6b) — the table layout's COLUMN VOCABULARY.
 *
 * A saved view persists `columns`: an ordered list of ids (`PmSavedView.columns`,
 * `pm-views.ts`). WS-6 validates the list's SHAPE only — "this checks shape and
 * not meaning" — and left the meaning to the slice that draws the table. This is
 * that meaning: which ids exist, which a scope can show, what a table opens with,
 * and how a saved list is read back by a build that may know more or fewer
 * columns than the one that saved it.
 *
 * Ids only. How a column is titled, how wide it is and how it renders is the
 * dashboard's (`components/projects/table/columns.tsx`), whose registry is tested
 * to cover exactly this list — one definition of "what columns are there", in the
 * one package the assistant, the API and the dashboard can all import.
 *
 * Not here yet, each one id away: `type` and `estimate` (WS-4), a `cf.<propertyId>`
 * column per custom property (WS-4 — the id grammar of a saved view already admits
 * the form, and {@link resolveTableColumns} drops what it does not know).
 */

export const PM_TABLE_COLUMN_IDS = [
  "key",
  "name",
  "project",
  "state",
  "priority",
  "assignees",
  "labels",
  "dueDate",
  "startDate",
  "createdAt",
  "updatedAt",
  "department",
  "comments",
  "subItems",
] as const;
export type PmTableColumnId = (typeof PM_TABLE_COLUMN_IDS)[number];

/** A table over one project, or over the whole workspace (`PmSavedView.projectId` null). */
export type PmTableScope = "project" | "workspace";

/** The one column a table never hides: a row you cannot name is not a row. */
export const PM_TABLE_REQUIRED_COLUMN: PmTableColumnId = "name";

/** What a table opens with when nothing says otherwise (`columns` null). */
export const PM_TABLE_DEFAULT_COLUMNS: Record<PmTableScope, readonly PmTableColumnId[]> = {
  project: ["key", "name", "state", "priority", "assignees", "labels", "dueDate", "updatedAt"],
  workspace: ["key", "name", "project", "state", "priority", "assignees", "dueDate", "updatedAt"],
};

export function isPmTableColumnId(id: unknown): id is PmTableColumnId {
  return typeof id === "string" && (PM_TABLE_COLUMN_IDS as readonly string[]).includes(id);
}

/** The columns a scope can offer. `project` is the workspace's alone: inside one
 *  project every row would repeat the same value. */
export function tableColumnsFor(scope: PmTableScope): PmTableColumnId[] {
  return PM_TABLE_COLUMN_IDS.filter((c) => scope === "workspace" || c !== "project");
}

/**
 * The columns a saved list MEANS in a scope.
 *
 *   • null / empty                → the scope's defaults.
 *   • an id this build lacks      → dropped. A view saved by a later build (a custom
 *                                   field, an estimate) must still open, not error.
 *   • a repeated id               → the first stays.
 *   • `project` in a project table → dropped.
 *   • no title                    → put back after the key (or first): the title
 *                                   column is not optional.
 *   • nothing known survives      → the defaults.
 *
 * The saved ORDER is kept; the table draws columns left to right in it.
 */
export function resolveTableColumns(
  columns: readonly string[] | null | undefined,
  scope: PmTableScope,
): PmTableColumnId[] {
  if (!columns || columns.length === 0) return [...PM_TABLE_DEFAULT_COLUMNS[scope]];
  const offered = new Set<string>(tableColumnsFor(scope));
  const out: PmTableColumnId[] = [];
  for (const c of columns) {
    if (isPmTableColumnId(c) && offered.has(c) && !out.includes(c)) out.push(c);
  }
  if (out.length === 0) return [...PM_TABLE_DEFAULT_COLUMNS[scope]];
  if (!out.includes(PM_TABLE_REQUIRED_COLUMN)) {
    const after = out.indexOf("key");
    out.splice(after >= 0 ? after + 1 : 0, 0, PM_TABLE_REQUIRED_COLUMN);
  }
  return out;
}
