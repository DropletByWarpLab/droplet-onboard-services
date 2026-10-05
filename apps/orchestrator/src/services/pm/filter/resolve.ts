/**
 * WARP-3522 — the asynchronous half of a filter's meaning, done BEFORE
 * `compileFilter` so the compiler can stay pure.
 *
 * Two jobs:
 *
 *  1. STALE REFERENCES (brief §3.9). A filter names rows by id — a state, a
 *     label, an assignee. If one has since been deleted, an `in` over it
 *     matches nothing, and a saved view that opens to an empty board for a
 *     reason nobody can see is the worst outcome available. So every id the
 *     filter names is checked, the ones that are gone are dropped from the
 *     filter, and each drop is REPORTED (`stale`) so the dashboard can say
 *     "One filter was removed because it no longer exists." The view loads;
 *     nothing throws.
 *
 *  2. DEPARTMENTS. A department value is an id, a slug or a NAME (the
 *     assistant cannot look one up — see `resolveDepartmentFilter`), and a
 *     DEPARTMENT stands for itself plus its TEAMs (`expandDepartmentScope`).
 *     Both are database reads, so they happen here and arrive in the compiler
 *     as data. Both functions are reused, not re-derived: the board, the
 *     assistant's `?department=` and this DSL must never disagree about what
 *     "Clinical" contains.
 *
 * Existence is checked ONE QUERY PER KIND, however many conditions name it, and
 * a kind a filter does not mention costs nothing. Ids are untrusted (they came
 * from a URL or a saved view) and only ever travel as bound parameters.
 *
 * A department that does not exist is stale like any other missing row — here,
 * unlike `GET …?department=`, which 404s so the assistant learns the name was
 * wrong. A saved view must still load; the `stale` entry is what carries the
 * same fact to a caller that wants to treat it as an error.
 */
import type { PrismaClient } from "@prisma/client";
import {
  PM_FILTER_ME,
  PM_FILTER_NONE,
  isPmFilterGroup,
  normalizePmFilter,
  pmFilterConditions,
  type PmFilter,
  type PmFilterCondition,
  type PmFilterField,
} from "@droplet/shared-types";
import { expandDepartmentScope, resolveDepartmentFilter } from "../pm-department.js";

export interface PmStaleRef {
  field: PmFilterField;
  value: string;
}

export interface ResolvedFilter {
  /** The filter with every reference that no longer exists removed. */
  filter: PmFilter;
  /** Department scopes for `compileFilter`, keyed by the value as written. */
  departments: Map<string, readonly string[] | null>;
  /** One entry per removed value, in the order the filter names them. */
  stale: PmStaleRef[];
}

/** The fields whose values are ids of a row that can be deleted, and how to
 *  ask which of a batch still exist. `department` is handled separately. */
type IdField = "state" | "label" | "cycle" | "module" | "parent" | "project" | "assignee" | "createdBy";

const ID_FIELDS: readonly IdField[] = [
  "state",
  "label",
  "cycle",
  "module",
  "parent",
  "project",
  "assignee",
  "createdBy",
];

/** Words a field accepts INSTEAD of an id — never looked up. */
const TOKENS = new Set<string>([PM_FILTER_ME, PM_FILTER_NONE]);

async function existingIds(db: PrismaClient, field: IdField, ids: string[]): Promise<Set<string>> {
  const where = { id: { in: ids } };
  const select = { id: true } as const;
  let rows: Array<{ id: string }>;
  switch (field) {
    case "state":
      rows = await db.pmState.findMany({ where, select });
      break;
    case "label":
      rows = await db.pmLabel.findMany({ where, select });
      break;
    case "cycle":
      rows = await db.pmCycle.findMany({ where, select });
      break;
    case "module":
      rows = await db.pmModule.findMany({ where, select });
      break;
    case "parent":
      rows = await db.pmWorkItem.findMany({ where, select });
      break;
    case "project":
      rows = await db.pmProject.findMany({ where, select });
      break;
    case "assignee":
    case "createdBy":
      rows = await db.user.findMany({ where, select });
      break;
  }
  return new Set(rows.map((r) => r.id));
}

function isIdField(f: PmFilterField): f is IdField {
  return (ID_FIELDS as readonly string[]).includes(f);
}

function valuesOf(c: PmFilterCondition): string[] {
  if (c.value === undefined || typeof c.value === "boolean") return [];
  return Array.isArray(c.value) ? c.value : [c.value];
}

/**
 * Check every reference a filter makes, drop the ones that are gone, and expand
 * the department scopes. Input must be a VALID filter (`validatePmFilter`'s
 * output); a tree that is not one is the caller's bug.
 */
export async function resolveFilterRefs(db: PrismaClient, filter: PmFilter): Promise<ResolvedFilter> {
  // 1. Gather what is named, per kind.
  const named = new Map<IdField, Set<string>>();
  const departmentRefs = new Set<string>();
  for (const c of pmFilterConditions(filter)) {
    if (c.field === "department") {
      for (const v of valuesOf(c)) if (v.toLowerCase() !== PM_FILTER_NONE) departmentRefs.add(v);
    } else if (isIdField(c.field)) {
      for (const v of valuesOf(c)) {
        if (TOKENS.has(v)) continue;
        const set = named.get(c.field) ?? new Set<string>();
        set.add(v);
        named.set(c.field, set);
      }
    }
  }

  // 2. Ask which exist: one query per kind.
  const alive = new Map<IdField, Set<string>>();
  await Promise.all(
    [...named].map(async ([field, ids]) => {
      alive.set(field, await existingIds(db, field, [...ids]));
    }),
  );

  // 3. Departments. Sequential: a filter names one or two, and each lookup is a
  //    primary-key or unique-column read.
  const departments = new Map<string, readonly string[] | null>();
  const deadDepartments = new Set<string>();
  for (const ref of departmentRefs) {
    try {
      const id = await resolveDepartmentFilter(db, ref);
      if (id === undefined || id === null) {
        // Unreachable for a non-"none" ref (the resolver returns a string or
        // throws); treated as "no such department" rather than trusted.
        deadDepartments.add(ref);
      } else {
        departments.set(ref, await expandDepartmentScope(db, id));
      }
    } catch (err) {
      if (err instanceof Error && err.message === "department_not_found") deadDepartments.add(ref);
      else throw err;
    }
  }

  // 4. Rebuild the tree without what is gone.
  const stale: PmStaleRef[] = [];
  const isLive = (c: PmFilterCondition, v: string): boolean => {
    if (c.field === "department") return v.toLowerCase() === PM_FILTER_NONE || !deadDepartments.has(v);
    if (!isIdField(c.field)) return true;
    if (TOKENS.has(v)) return true;
    return alive.get(c.field)?.has(v) ?? false;
  };

  const prune = (n: PmFilter): PmFilter | null => {
    if (isPmFilterGroup(n)) {
      const kind: "and" | "or" = "and" in n ? "and" : "or";
      const kids = kind === "and" ? (n as { and: PmFilter[] }).and : (n as { or: PmFilter[] }).or;
      const kept = kids.map(prune).filter((k): k is PmFilter => k !== null);
      // A group that lost everything is REMOVED, not kept empty: an empty `or`
      // is "false" and would turn a stale arm into an empty board.
      if (kept.length === 0) return kids.length === 0 ? n : null;
      return kind === "and" ? { and: kept } : { or: kept };
    }
    const values = valuesOf(n);
    if (values.length === 0) return n;
    const live = values.filter((v) => isLive(n, v));
    for (const v of values) if (!live.includes(v)) stale.push({ field: n.field, value: v });
    if (live.length === values.length) return n;
    if (live.length === 0) return null;
    return { ...n, value: live };
  };

  // Untouched when nothing was removed; canonical (one-child groups unwrapped)
  // when something was, so the effective filter the caller hands back to the
  // browser is the shape its chips are built from.
  const pruned = prune(filter); // fills `stale` as it goes
  const effective = stale.length === 0 ? filter : normalizePmFilter(pruned ?? { and: [] });
  return { filter: effective, departments, stale };
}
