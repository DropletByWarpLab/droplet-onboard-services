/**
 * WARP-3522 — saved views: the vocabulary a view persists (layout, sort,
 * group-by, columns), the five built-in views the board always offered, and the
 * wire shape of a view.
 *
 * The built-ins live HERE, expressed in the filter DSL, and not in the
 * dashboard: they used to be a `switch` in `app/projects/page.tsx` that only the
 * browser could evaluate, so no API consumer — and not the assistant — could ask
 * for "my items" or "overdue". As DSL they are one more filter every consumer
 * compiles through the same code. They are not rows: no migration seeds them,
 * they cannot be renamed or deleted, and their ids are the five slugs the page
 * already used (`all`, `mine`, `active`, `overdue`, `noassignee`), which no row
 * id (a uuid) can collide with.
 */
import type { PmFilter } from "./pm-filter";

export const PM_VIEW_SCOPES = ["PERSONAL", "SHARED"] as const;
export type PmViewScope = (typeof PM_VIEW_SCOPES)[number];

export const PM_VIEW_LAYOUTS = ["BOARD", "LIST", "TABLE", "CALENDAR", "TIMELINE"] as const;
export type PmViewLayout = (typeof PM_VIEW_LAYOUTS)[number];

/** Characters in a view's name (brief §3.9: "a short name"). */
export const PM_VIEW_NAME_MAX = 60;
/** Brief §3.9: "cap at a sensible small number (e.g. 12)". Enforced server-side:
 *  per owner for personal views, per project for shared ones. */
export const PM_VIEW_LIMIT = 12;

// ── sort ────────────────────────────────────────────────────────────────────

/**
 * What a list can be ordered by. `priority` orders by the enum's declared order
 * (urgent → none ascending), `state` by the state's column position, `key` by
 * project identifier then number.
 */
export const PM_SORT_FIELDS = [
  "sortOrder",
  "key",
  "name",
  "state",
  "priority",
  "dueDate",
  "startDate",
  "createdAt",
  "updatedAt",
] as const;
export type PmSortField = (typeof PM_SORT_FIELDS)[number];
export const PM_SORT_MAX_KEYS = 3;

export interface PmSortSpec {
  field: PmSortField;
  dir: "asc" | "desc";
}

export type PmSortValidation = { ok: true; sort: PmSortSpec[] } | { ok: false; error: string };

export function validatePmSort(input: unknown): PmSortValidation {
  if (!Array.isArray(input) || input.length === 0 || input.length > PM_SORT_MAX_KEYS) {
    return { ok: false, error: "sort_invalid" };
  }
  const out: PmSortSpec[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "sort_invalid" };
    }
    const keys = Object.keys(entry);
    const { field, dir } = entry as { field?: unknown; dir?: unknown };
    if (
      keys.length !== 2 ||
      typeof field !== "string" ||
      !(PM_SORT_FIELDS as readonly string[]).includes(field) ||
      (dir !== "asc" && dir !== "desc")
    ) {
      return { ok: false, error: "sort_invalid" };
    }
    if (out.some((s) => s.field === field)) return { ok: false, error: "sort_invalid" };
    out.push({ field: field as PmSortField, dir });
  }
  return { ok: true, sort: out };
}

// ── group by ────────────────────────────────────────────────────────────────

/** Brief WS-6b: "by state, assignee, priority, label, type, cycle, module or
 *  department" — `type` joins when WS-4 lands; `project` is what a cross-project
 *  view groups by; `stateGroup` is what it groups by instead of `state`, because
 *  states are per project. */
export const PM_GROUP_BY_FIELDS = [
  "state",
  "stateGroup",
  "assignee",
  "priority",
  "label",
  "cycle",
  "module",
  "department",
  "project",
] as const;
export type PmGroupByField = (typeof PM_GROUP_BY_FIELDS)[number];

export type PmGroupByValidation = { ok: true; groupBy: PmGroupByField } | { ok: false; error: string };

export function validatePmGroupBy(input: unknown): PmGroupByValidation {
  if (typeof input === "string" && (PM_GROUP_BY_FIELDS as readonly string[]).includes(input)) {
    return { ok: true, groupBy: input as PmGroupByField };
  }
  return { ok: false, error: "group_by_invalid" };
}

// ── columns ─────────────────────────────────────────────────────────────────

/** The table layout (WS-6b) owns the column vocabulary; a saved view only
 *  carries an ordered list of ids, so this checks shape and not meaning. */
export const PM_COLUMNS_MAX = 20;
const COLUMN_ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

export type PmColumnsValidation = { ok: true; columns: string[] } | { ok: false; error: string };

export function validatePmColumns(input: unknown): PmColumnsValidation {
  if (!Array.isArray(input) || input.length === 0 || input.length > PM_COLUMNS_MAX) {
    return { ok: false, error: "columns_invalid" };
  }
  const out: string[] = [];
  for (const c of input) {
    if (typeof c !== "string" || !COLUMN_ID_RE.test(c) || out.includes(c)) {
      return { ok: false, error: "columns_invalid" };
    }
    out.push(c);
  }
  return { ok: true, columns: out };
}

// ── built-in views ──────────────────────────────────────────────────────────

export interface PmBuiltinView {
  readonly id: string;
  readonly name: string;
  readonly filter: PmFilter;
}

/**
 * The views the board has always offered, as DSL. Semantics carried over from
 * the client-side `applySavedView`:
 *
 *   • mine       — I am an assignee.
 *   • active     — the state is in a non-terminal group. An item with NO state
 *                  is not "active" (the old code read `state?.group ?? ""`).
 *   • overdue    — open (anything but completed / cancelled — an item with no
 *                  state counts as open) and due BEFORE TODAY. "Today" is the
 *                  viewer's calendar day: the old test was `dueDate < now`,
 *                  which made an item due today overdue from 00:00 UTC, and a
 *                  date is a calendar date (WS-1's date-only rule).
 *   • noassignee — nobody is assigned.
 */
export const PM_BUILTIN_VIEWS: readonly PmBuiltinView[] = [
  { id: "all", name: "All", filter: { and: [] } },
  { id: "mine", name: "My items", filter: { and: [{ field: "assignee", op: "is", value: "me" }] } },
  {
    id: "active",
    name: "Active",
    filter: { and: [{ field: "stateGroup", op: "in", value: ["backlog", "unstarted", "started"] }] },
  },
  {
    id: "overdue",
    name: "Overdue",
    filter: {
      and: [
        { field: "dueDate", op: "before", value: "today" },
        { field: "stateGroup", op: "notIn", value: ["completed", "cancelled"] },
      ],
    },
  },
  { id: "noassignee", name: "No assignee", filter: { and: [{ field: "assignee", op: "isEmpty" }] } },
];

export function isPmBuiltinViewId(id: string): boolean {
  return PM_BUILTIN_VIEWS.some((v) => v.id === id);
}

// ── wire shape ──────────────────────────────────────────────────────────────

/** A saved view as the API returns it — a row, or one of the built-ins. */
export interface PmSavedViewDto {
  id: string;
  /** `null` for a cross-project view and for the built-ins. */
  projectId: string | null;
  /** `null` for a built-in. */
  ownerId: string | null;
  scope: PmViewScope | "BUILTIN";
  name: string;
  /** The layout to open the view in; `null` for a built-in (it leaves the layout alone). */
  layout: PmViewLayout | null;
  filter: PmFilter;
  groupBy: PmGroupByField | null;
  sortBy: PmSortSpec[] | null;
  columns: string[] | null;
  sortOrder: number;
  /** May the CALLER rename, update and delete it. Always `false` for a built-in. */
  canEdit: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}
