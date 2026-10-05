// WARP-3522 — the filter bar's model: what a filter (the shared DSL) looks like
// as a search box plus a row of chips, and back; what each chip says in plain
// words; which fields the "Filter" menu offers. Pure — no React, no fetching —
// so the whole translation is testable without a DOM.
//
// The DSL is a tree (`and` / `or` of conditions). The bar edits the common
// shape of it: a top-level AND, each child one chip, the `text` condition
// shown as the search box instead of a chip. A filter that is not that shape —
// an `or` group a view saved through the API or the assistant — still loads,
// still applies, and shows as ONE read-only "Custom filter" chip that can be
// removed; the bar never rewrites what it cannot represent.

import {
  PM_FILTER_ME,
  PM_FILTER_NONE,
  PM_FILTER_TEXT_MAX,
  isPmFilterGroup,
  normalizePmFilter,
  relativeDateOffsetDays,
  type PmFilter,
  type PmFilterCondition,
  type PmFilterField,
} from "@droplet/shared-types";
import { PRIORITY } from "./config";
import type { Priority, StateGroup } from "./types";

export const EMPTY_FILTER: PmFilter = { and: [] };

// ── the filter as search text + chips ───────────────────────────────────────

export interface FilterParts {
  /** The `text contains` condition, shown as the search box. */
  text: string;
  /** Every other top-level child: one chip each. */
  chips: PmFilter[];
}

/** Take a filter apart into what the bar shows. */
export function splitFilter(filter: PmFilter): FilterParts {
  const n = normalizePmFilter(filter);
  const top: PmFilter[] = isPmFilterGroup(n) ? ("and" in n ? n.and : [n]) : [n];
  let text = "";
  const chips: PmFilter[] = [];
  for (const child of top) {
    if (!text && !isPmFilterGroup(child) && child.field === "text" && child.op === "contains") {
      text = String(child.value);
    } else {
      chips.push(child);
    }
  }
  return { text, chips };
}

/** Put the bar's two halves back together as a canonical filter. */
export function joinFilter(parts: FilterParts): PmFilter {
  const kids: PmFilter[] = [];
  const text = parts.text.trim().slice(0, PM_FILTER_TEXT_MAX).trim();
  if (text) kids.push({ field: "text", op: "contains", value: text });
  kids.push(...parts.chips);
  return normalizePmFilter({ and: kids });
}

/** Replace the chip at `index`, or append when `index` is -1. */
export function withChip(filter: PmFilter, index: number, chip: PmFilter): PmFilter {
  const parts = splitFilter(filter);
  const chips = [...parts.chips];
  if (index < 0 || index >= chips.length) chips.push(chip);
  else chips[index] = chip;
  return joinFilter({ ...parts, chips });
}

export function withoutChip(filter: PmFilter, index: number): PmFilter {
  const parts = splitFilter(filter);
  return joinFilter({ ...parts, chips: parts.chips.filter((_, i) => i !== index) });
}

export function withText(filter: PmFilter, text: string): PmFilter {
  return joinFilter({ ...splitFilter(filter), text });
}

// ── plain-language chips ────────────────────────────────────────────────────

export const STAGE_LABEL: Record<StateGroup, string> = {
  backlog: "Backlog",
  unstarted: "To do",
  started: "In progress",
  completed: "Done",
  cancelled: "Cancelled",
};

export const FIELD_LABEL: Record<PmFilterField, string> = {
  state: "State",
  stateGroup: "Stage",
  priority: "Priority",
  assignee: "Assignee",
  label: "Label",
  cycle: "Cycle",
  module: "Module",
  department: "Department",
  project: "Project",
  dueDate: "Due date",
  startDate: "Start date",
  createdAt: "Created",
  updatedAt: "Updated",
  createdBy: "Created by",
  text: "Search",
  parent: "Parent",
  isArchived: "Archived",
};

/** What the chips need to turn ids back into names. Every one may be missing
 *  (not loaded yet, or the row is gone) and has a plain fallback. */
export interface ChipLookups {
  stateName?: (id: string) => string | undefined;
  labelName?: (id: string) => string | undefined;
  personName?: (id: string) => string | undefined;
  departmentName?: (ref: string) => string | undefined;
  projectName?: (id: string) => string | undefined;
}

/** A date token in words: `today`, `7 days ago`, `in 2 weeks`, or the ISO date. */
export function describeDateToken(token: string): string {
  if (token === "today" || token === "yesterday" || token === "tomorrow") return token;
  const days = relativeDateOffsetDays(token);
  if (days === null) return token;
  const abs = Math.abs(days);
  const span = abs % 7 === 0 && abs >= 14 ? `${abs / 7} weeks` : abs === 1 ? "1 day" : `${abs} days`;
  return days < 0 ? `${span} ago` : `in ${span}`;
}

function describeValue(field: PmFilterField, value: string, lk: ChipLookups): string {
  switch (field) {
    case "assignee":
      if (value === PM_FILTER_ME) return "me";
      if (value === PM_FILTER_NONE) return "nobody";
      return lk.personName?.(value) ?? "a former member";
    case "createdBy":
      return value === PM_FILTER_ME ? "me" : (lk.personName?.(value) ?? "a former member");
    case "state":
      return lk.stateName?.(value) ?? "a state";
    case "label":
      return lk.labelName?.(value) ?? "a label";
    case "department":
      return value.toLowerCase() === PM_FILTER_NONE ? "no department" : (lk.departmentName?.(value) ?? value);
    case "project":
      return lk.projectName?.(value) ?? "a project";
    case "cycle":
      return "a cycle";
    case "module":
      return "a module";
    case "parent":
      return "an item";
    case "stateGroup":
      return STAGE_LABEL[value as StateGroup] ?? value;
    case "priority":
      return PRIORITY[value as Priority]?.label ?? value;
    case "dueDate":
    case "startDate":
    case "createdAt":
    case "updatedAt":
      return describeDateToken(value);
    default:
      return value;
  }
}

/**
 * A chip in words: "Due date before today", "Assignee is me", "Label is Bug or
 * Docs", "Stage is none of Done, Cancelled". A group is "Custom filter".
 */
export function describeChip(chip: PmFilter, lk: ChipLookups = {}): string {
  if (isPmFilterGroup(chip)) return "Custom filter";
  const c: PmFilterCondition = chip;
  const label = FIELD_LABEL[c.field];
  const values = Array.isArray(c.value) ? c.value : typeof c.value === "string" ? [c.value] : [];
  const named = values.map((v) => describeValue(c.field, v, lk));
  switch (c.op) {
    case "isEmpty":
      return `${label} is empty`;
    case "isNotEmpty":
      return `${label} is set`;
    case "is":
      if (c.field === "isArchived") return c.value === true ? "Archived items only" : "Not archived";
      return `${label} is ${named[0]}`;
    case "isNot":
      return `${label} is not ${named[0]}`;
    case "in":
      return `${label} is ${named.join(" or ")}`;
    case "notIn":
      return `${label} is none of ${named.join(", ")}`;
    case "before":
      return `${label} before ${named[0]}`;
    case "after":
      return `${label} after ${named[0]}`;
    case "between":
      return `${label} between ${named[0]} and ${named[1]}`;
    case "contains":
      return `${label} contains ${named[0]}`;
  }
}

// ── which fields the "Filter" menu offers ───────────────────────────────────

/** How a field is edited: pick values from a list; pick a date or a range;
 *  "has one / has none"; a single switch. */
export type FieldEditor = "multi" | "date" | "presence" | "toggle";

export interface FieldUi {
  field: PmFilterField;
  label: string;
  editor: FieldEditor;
}

export type FilterScope = "project" | "workspace";

/**
 * The fields the menu offers. `text` is the search box, not a menu entry.
 * Everything else the DSL can say is here, with two honest limits: `cycle`,
 * `module` and `parent` offer only "has one / has none" — there is no list of
 * cycles or modules to pick from until WS-5 gives them routes, and picking a
 * parent is a different control. A workspace-wide view has no single project,
 * so it offers no `state` or `label` (both are per project) — `stage` and
 * `project` stand in for them.
 */
export function availableFields(scope: FilterScope, opts: { departments: boolean }): FieldUi[] {
  const fields: FieldUi[] = [];
  if (scope === "project") fields.push({ field: "state", label: FIELD_LABEL.state, editor: "multi" });
  fields.push({ field: "stateGroup", label: FIELD_LABEL.stateGroup, editor: "multi" });
  fields.push({ field: "priority", label: FIELD_LABEL.priority, editor: "multi" });
  fields.push({ field: "assignee", label: FIELD_LABEL.assignee, editor: "multi" });
  if (scope === "project") fields.push({ field: "label", label: FIELD_LABEL.label, editor: "multi" });
  if (scope === "workspace") fields.push({ field: "project", label: FIELD_LABEL.project, editor: "multi" });
  if (opts.departments) fields.push({ field: "department", label: FIELD_LABEL.department, editor: "multi" });
  fields.push(
    { field: "dueDate", label: FIELD_LABEL.dueDate, editor: "date" },
    { field: "startDate", label: FIELD_LABEL.startDate, editor: "date" },
    { field: "createdAt", label: FIELD_LABEL.createdAt, editor: "date" },
    { field: "updatedAt", label: FIELD_LABEL.updatedAt, editor: "date" },
    { field: "createdBy", label: FIELD_LABEL.createdBy, editor: "multi" },
    { field: "parent", label: "Sub-items", editor: "presence" },
    { field: "cycle", label: FIELD_LABEL.cycle, editor: "presence" },
    { field: "module", label: FIELD_LABEL.module, editor: "presence" },
    { field: "isArchived", label: "Archived items", editor: "toggle" },
  );
  return fields;
}

/** The wording of the two presence choices, per field. */
export const PRESENCE_LABEL: Partial<Record<PmFilterField, { has: string; hasNot: string }>> = {
  parent: { has: "Sub-items only", hasNot: "Top-level items only" },
  cycle: { has: "In a cycle", hasNot: "Not in a cycle" },
  module: { has: "In a module", hasNot: "Not in a module" },
};

/** The condition a presence choice stands for. */
export function presenceChip(field: PmFilterField, has: boolean): PmFilter {
  return { field, op: has ? "isNotEmpty" : "isEmpty" } as PmFilter;
}

// ── date presets ────────────────────────────────────────────────────────────

export interface DatePreset {
  id: string;
  label: string;
  /** A function of the field, so a preset can be offered for any date field. */
  chip: (field: PmFilterField) => PmFilter;
}

const cond = (field: PmFilterField, op: PmFilterCondition["op"], value?: string | string[]): PmFilter =>
  (value === undefined ? { field, op } : { field, op, value }) as PmFilter;

/** Brief §3.9: "relative dates offered as presets". Every one is a relative
 *  token the server resolves in the viewer's zone — never a date computed here. */
export const DATE_PRESETS: readonly DatePreset[] = [
  { id: "today", label: "Today", chip: (f) => cond(f, "is", "today") },
  { id: "yesterday", label: "Yesterday", chip: (f) => cond(f, "is", "yesterday") },
  { id: "tomorrow", label: "Tomorrow", chip: (f) => cond(f, "is", "tomorrow") },
  { id: "before-today", label: "Before today", chip: (f) => cond(f, "before", "today") },
  { id: "after-today", label: "After today", chip: (f) => cond(f, "after", "today") },
  { id: "last-7", label: "Last 7 days", chip: (f) => cond(f, "between", ["-7d", "today"]) },
  { id: "next-7", label: "Next 7 days", chip: (f) => cond(f, "between", ["today", "+7d"]) },
  { id: "last-30", label: "Last 30 days", chip: (f) => cond(f, "between", ["-30d", "today"]) },
  { id: "next-30", label: "Next 30 days", chip: (f) => cond(f, "between", ["today", "+30d"]) },
];

/** Fields whose column can be empty, so "no date" / "has a date" make sense. */
export const NULLABLE_DATE_FIELDS: ReadonlySet<PmFilterField> = new Set<PmFilterField>(["dueDate", "startDate"]);

// ── multi-value choices ─────────────────────────────────────────────────────

export interface Choice {
  value: string;
  label: string;
}

export type MultiMode = "any" | "none";

/** The condition for a set of chosen values: `is` / `isNot` for one value,
 *  `in` / `notIn` for several — so a shared link reads `assignee.is:me`. */
export function multiChip(field: PmFilterField, mode: MultiMode, values: string[]): PmFilter {
  const one = values.length === 1;
  const op = mode === "any" ? (one ? "is" : "in") : one ? "isNot" : "notIn";
  return cond(field, op, one ? values[0] : values);
}

/** Read a multi-value condition back as (mode, values), or null if it is not one. */
export function readMulti(chip: PmFilter): { mode: MultiMode; values: string[] } | null {
  if (isPmFilterGroup(chip)) return null;
  const values = Array.isArray(chip.value) ? chip.value : typeof chip.value === "string" ? [chip.value] : null;
  if (!values) return null;
  if (chip.op === "is" || chip.op === "in") return { mode: "any", values };
  if (chip.op === "isNot" || chip.op === "notIn") return { mode: "none", values };
  return null;
}
