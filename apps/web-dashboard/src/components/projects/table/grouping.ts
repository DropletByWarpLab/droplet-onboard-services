// WARP-3537 — grouping for the list and the table (brief §3.3).
//
// The server does the COUNTING: the query API's `groupBy` returns an exact count
// per group for the whole result, however many pages have loaded. The rows come
// back in the sort order, not clustered, so the page puts them under their group
// headers here. Pure — no React — so which groups there are, which items each
// holds, how they are ordered and what a collapsed one hides are all tests.
//
// What a group's `key` is deliberately matches the server's `PmQueryGroup.key`
// for the same field (a state id, a user id, a priority, a label id, the effective
// department id, a project id, a state group), so a header can read its exact
// count off the server's answer by key.

import { PM_PRIORITIES, PM_STATE_GROUPS, type PmGroupByField, type PmTableScope } from "@droplet/shared-types";
import { PRIORITY } from "../config";
import { STAGE_LABEL } from "../filter-model";
import type { PmQueryGroup, PmWorkItem } from "../types";

export type DisplayLayout = "list" | "table";

export interface ItemGroup {
  /** Stable across renders and distinct per field — the key a collapsed group is remembered by. */
  id: string;
  /** The server's group key for this field; `null` is "none". */
  key: string | null;
  name: string;
  /** A CSS colour for the dot: a state's own, a priority's token. Null when the field has none. */
  color: string | null;
  /** A quiet mono chip beside the name: a project's identifier. */
  chip: string | null;
  items: PmWorkItem[];
}

export interface GroupContext {
  personName: (id: string) => string;
  projectName?: (id: string) => string | undefined;
}

type Bucket = { key: string | null; name: string; color: string | null; chip: string | null; order: number; items: PmWorkItem[] };

const NONE_NAME: Partial<Record<PmGroupByField, string>> = {
  state: "No state",
  stateGroup: "No stage",
  assignee: "Unassigned",
  label: "No label",
  department: "No department",
};

/** Put each item under the group(s) it belongs to for `by`. An item with several assignees, or several
 *  labels, is under each of them (the server counts it that way too). Empty groups are not made. */
export function groupItems(items: PmWorkItem[], by: PmGroupByField, ctx: GroupContext): ItemGroup[] {
  const buckets = new Map<string, Bucket>();
  const put = (key: string | null, make: () => Omit<Bucket, "key" | "items">, item: PmWorkItem) => {
    const id = key ?? "\u0000none";
    let b = buckets.get(id);
    if (!b) {
      b = { key, ...make(), items: [] };
      buckets.set(id, b);
    }
    b.items.push(item);
  };
  const none = (): Omit<Bucket, "key" | "items"> => ({
    name: NONE_NAME[by] ?? "None",
    color: null,
    chip: null,
    order: Number.MAX_SAFE_INTEGER,
  });

  for (const it of items) {
    switch (by) {
      case "state":
        if (it.state) put(it.state.id, () => ({ name: it.state!.name, color: it.state!.color, chip: null, order: it.state!.sortOrder }), it);
        else put(null, none, it);
        break;
      case "stateGroup": {
        const g = it.state?.group ?? null;
        if (g) put(g, () => ({ name: STAGE_LABEL[g], color: null, chip: null, order: PM_STATE_GROUPS.indexOf(g) }), it);
        else put(null, none, it);
        break;
      }
      case "priority":
        put(it.priority, () => ({ name: PRIORITY[it.priority].label, color: PRIORITY[it.priority].color, chip: null, order: PM_PRIORITIES.indexOf(it.priority) }), it);
        break;
      case "assignee":
        if (it.assignees.length === 0) put(null, none, it);
        for (const a of it.assignees) put(a, () => ({ name: ctx.personName(a), color: null, chip: null, order: 0 }), it);
        break;
      case "label":
        if (it.labels.length === 0) put(null, none, it);
        for (const l of it.labels) put(l.id, () => ({ name: l.name, color: l.color, chip: null, order: 0 }), it);
        break;
      case "department":
        if (it.department) put(it.department.id, () => ({ name: it.department!.name, color: null, chip: null, order: 0 }), it);
        else put(null, none, it);
        break;
      case "project": {
        const identifier = it.key.slice(0, it.key.lastIndexOf("-"));
        put(it.projectId, () => ({ name: ctx.projectName?.(it.projectId) ?? identifier, color: null, chip: identifier, order: 0 }), it);
        break;
      }
      default:
        // `cycle` and `module` are in the shared vocabulary, but nothing on this branch can name one.
        put(null, () => ({ name: "All", color: null, chip: null, order: 0 }), it);
    }
  }

  const byName = by === "assignee" || by === "label" || by === "department" || by === "project";
  return [...buckets.values()]
    .sort((a, b) => a.order - b.order || (byName ? a.name.localeCompare(b.name) : 0))
    .map((b) => ({ id: `${by}:${b.key ?? "none"}`, key: b.key, name: b.name, color: b.color, chip: b.chip, items: b.items }));
}

// ── what a control offers, and what `null` means ────────────────────────────

export interface GroupOption {
  value: PmGroupByField | null;
  label: string;
}

const FIELD_LABEL: Partial<Record<PmGroupByField, string>> = {
  state: "State",
  stateGroup: "Stage",
  assignee: "Assignee",
  priority: "Priority",
  label: "Label",
  department: "Department",
  project: "Project",
};

function offered(scope: PmTableScope, opts: { departments: boolean }): PmGroupByField[] {
  // `state` and `label` are per project: across projects they would be one group per project's "Todo".
  const fields: PmGroupByField[] =
    scope === "project" ? ["state", "assignee", "priority", "label"] : ["project", "stateGroup", "assignee", "priority"];
  if (opts.departments) fields.push("department");
  return fields;
}

/** The group-by choices for a layout. A list is grouped by default, so it offers no "None"; a table is flat by default, so it does. */
export function groupOptions(scope: PmTableScope, layout: DisplayLayout, opts: { departments: boolean }): GroupOption[] {
  const fields = offered(scope, opts).map((value) => ({ value, label: FIELD_LABEL[value]! }));
  return layout === "table" ? [{ value: null, label: "None" }, ...fields] : fields;
}

/** What `null` means for a layout: a project's list groups by state, a workspace's by project, a table by nothing. */
export function defaultGroupBy(scope: PmTableScope, layout: DisplayLayout): PmGroupByField | null {
  if (layout === "table") return null;
  return scope === "project" ? "state" : "project";
}

/** The group-by to draw: the saved one if this layout offers it, else the layout's default. */
export function effectiveGroupBy(saved: PmGroupByField | null, scope: PmTableScope, layout: DisplayLayout): PmGroupByField | null {
  if (saved === null) return defaultGroupBy(scope, layout);
  // Department is offered only when the box has any; a saved one still draws.
  const ok = [...offered(scope, { departments: true })].includes(saved);
  return ok ? saved : defaultGroupBy(scope, layout);
}

/** A group's EXACT size, off the server's answer — undefined when it has not said (not asked, or not here yet). */
export function serverCount(groups: PmQueryGroup[] | undefined, key: string | null): number | undefined {
  return groups?.find((g) => g.key === key)?.count;
}

// ── the flat row model ──────────────────────────────────────────────────────

export type FlatRow =
  | { kind: "group"; group: ItemGroup; collapsed: boolean }
  | { kind: "item"; item: PmWorkItem; groupId: string | null };

/** A header then its rows, group after group — what the table virtualises over and what a shift-range walks.
 *  A collapsed group keeps its header and loses its rows. With no groups: just the (ungrouped) rows. */
export function flattenGroups(
  groups: ItemGroup[] | null,
  collapsed: ReadonlySet<string>,
  ungrouped: PmWorkItem[] = [],
): FlatRow[] {
  if (groups === null) return ungrouped.map((item) => ({ kind: "item" as const, item, groupId: null }));
  const out: FlatRow[] = [];
  for (const group of groups) {
    const isCollapsed = collapsed.has(group.id);
    out.push({ kind: "group", group, collapsed: isCollapsed });
    if (!isCollapsed) for (const item of group.items) out.push({ kind: "item", item, groupId: group.id });
  }
  return out;
}
