/**
 * WARP-3522 (ADR-069 §8) — `compileFilter`: a filter in the shared DSL in, a
 * Prisma `where` for `PmWorkItem` out. The one compiler every consumer goes
 * through — the query API, saved views, and (WS-9, WS-18) automation
 * conditions — so a filter means the same rows wherever it is written.
 *
 * PURE. No database, no clock, no zone read: everything a filter's meaning
 * depends on arrives in {@link PmFilterContext} — "now", the viewer's IANA
 * zone, the viewer's id (for `me`) and the department scopes that
 * `resolve.ts` looked up beforehand. That is why this is a function a unit test
 * can pin without Prisma, and why the department rules (`pm-department.ts`) are
 * reused rather than re-derived: their output is data here, and their `where`
 * fragment is called, not copied.
 *
 * ── the rule that shapes most of this file ──────────────────────────────────
 *
 * SQL's three-valued logic. `NOT (x IN (...))` and `x NOT IN (...)` are NULL —
 * not true — when x is NULL, so a naive "is not" silently drops every row where
 * the column is empty, which is exactly the row a person filtering for "not in
 * Review" expects to still see. Every negation below is therefore spelled out
 * for its column: nullable scalars say `NULL OR NOT IN`, to-many relations say
 * `none: {…}` (a NOT EXISTS, which is true for an item with no links at all),
 * and the department rule gets its own null-safe negation. `compile.test.ts`
 * pins each shape and `pm-filter-query.pg.test.ts` proves the rows.
 *
 * Depth and size limits are `validatePmFilter`'s, and it is called here on
 * every input: the compiler never walks a tree it has not just judged.
 */
import type { Prisma } from "@prisma/client";
import {
  PM_FILTER_NONE,
  isPmFilterGroup,
  normalizePmFilter,
  parseWorkItemKey,
  validatePmFilter,
  PM_FILTER_ME,
  type PmFilter,
  type PmFilterCondition,
} from "@droplet/shared-types";
import { isValidIanaZone } from "../../../lib/zoned-time.js";
import { departmentWorkItemWhere } from "../pm-department.js";
import { dayEnd, dayStart, resolveDateToken, todayIn, type DateStorage } from "./dates.js";
import { PM_QUERY_ERRORS } from "./errors.js";

type Where = Prisma.PmWorkItemWhereInput;

export interface PmFilterContext {
  /** The moment `today` is measured at. Injected, so tests are deterministic. */
  now: Date;
  /** The viewer's IANA zone: what `today` is, and where a timestamp's day begins. */
  tz: string;
  /** Who `me` is. `null` for a principal that is not a person. */
  userId: string | null;
  /**
   * Department scopes, resolved ahead of time and keyed by the condition's value
   * exactly as written. A scope is the department's id plus its teams' (a
   * DEPARTMENT includes its TEAMs; a TEAM is only itself — `expandDepartmentScope`).
   * `null` is "owned by nobody". The word `none` never needs an entry.
   */
  departments: ReadonlyMap<string, readonly string[] | null>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const err = (code: string): Error => new Error(code);

/** One arm stays itself; several are combined. Never an empty array: an empty
 *  `OR` is false and an empty `AND` is true, and a caller that reaches here
 *  with no arms has a bug, not a filter. */
function combine(arms: Where[], kind: "AND" | "OR"): Where {
  if (arms.length === 1) return arms[0];
  return kind === "AND" ? { AND: arms } : { OR: arms };
}

/** Postgres' default LIKE escape is a backslash. Prisma's `contains` passes the
 *  string through verbatim, so without this "100%" matches "100 anything" and
 *  "a_b" matches "axb". */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

const isNoneWord = (v: string): boolean => v.toLowerCase() === PM_FILTER_NONE;

type SetKind = "in" | "notIn" | "empty" | "notEmpty";

/** The six set-style ops reduced to four meanings. `is` is a list of one. */
function setOp(c: PmFilterCondition): { kind: SetKind; values: string[] } {
  switch (c.op) {
    case "is":
      return { kind: "in", values: [c.value as string] };
    case "in":
      return { kind: "in", values: c.value as string[] };
    case "isNot":
      return { kind: "notIn", values: [c.value as string] };
    case "notIn":
      return { kind: "notIn", values: c.value as string[] };
    case "isEmpty":
      return { kind: "empty", values: [] };
    case "isNotEmpty":
      return { kind: "notEmpty", values: [] };
    default:
      throw err(PM_QUERY_ERRORS.INVALID_FILTER);
  }
}

class Env {
  private todayYmd: string | null = null;
  constructor(private readonly ctx: PmFilterContext) {}

  get tz(): string {
    return this.ctx.tz;
  }

  /** `me` → the requester. Anything else is returned as written. */
  me(v: string): string {
    if (v !== PM_FILTER_ME) return v;
    if (!this.ctx.userId) throw err(PM_QUERY_ERRORS.ME_UNAVAILABLE);
    return this.ctx.userId;
  }

  /** A date token as a calendar date, `today` measured in the viewer's zone. */
  day(token: string): string {
    if (this.todayYmd === null) this.todayYmd = todayIn(this.ctx.now, this.ctx.tz);
    return resolveDateToken(token, this.todayYmd);
  }

  /** A department value's scope, or `undefined` when nothing resolved it. */
  scope(v: string): readonly string[] | null | undefined {
    return this.ctx.departments.get(v);
  }
}

// ── per-column compilers ────────────────────────────────────────────────────

type NullableColumn = "stateId" | "cycleId" | "parentId" | "createdById";

function nullableScalar(col: NullableColumn, c: PmFilterCondition, map: (v: string) => string): Where {
  const s = setOp(c);
  const values = s.values.map(map);
  switch (s.kind) {
    case "in":
      return { [col]: { in: values } };
    case "notIn":
      return { OR: [{ [col]: null }, { [col]: { notIn: values } }] };
    case "empty":
      return { [col]: null };
    case "notEmpty":
      return { [col]: { not: null } };
  }
}

type RequiredColumn = "priority" | "projectId";

function requiredScalar(col: RequiredColumn, c: PmFilterCondition): Where {
  const s = setOp(c);
  return s.kind === "in" ? { [col]: { in: s.values } } : { [col]: { notIn: s.values } };
}

function stateGroup(c: PmFilterCondition): Where {
  const s = setOp(c);
  const groups = s.values as Prisma.EnumPmStateGroupFilter["in"];
  if (s.kind === "in") return { state: { is: { group: { in: groups } } } };
  // "Not in Done" includes the item that has no state at all.
  return { OR: [{ stateId: null }, { state: { is: { group: { notIn: groups } } } }] };
}

function joinSet(rel: "labels" | "modules", col: "labelId" | "moduleId", c: PmFilterCondition): Where {
  const s = setOp(c);
  switch (s.kind) {
    case "in":
      return { [rel]: { some: { [col]: { in: s.values } } } };
    case "notIn":
      return { [rel]: { none: { [col]: { in: s.values } } } };
    case "empty":
      return { [rel]: { none: {} } };
    case "notEmpty":
      return { [rel]: { some: {} } };
  }
}

function assignee(c: PmFilterCondition, env: Env): Where {
  const s = setOp(c);
  if (s.kind === "empty") return { assignees: { none: {} } };
  if (s.kind === "notEmpty") return { assignees: { some: {} } };
  const wantsNobody = s.values.includes(PM_FILTER_NONE);
  const ids = s.values.filter((v) => v !== PM_FILTER_NONE).map((v) => env.me(v));
  const arms: Where[] = [];
  if (s.kind === "in") {
    if (ids.length > 0) arms.push({ assignees: { some: { userId: { in: ids } } } });
    if (wantsNobody) arms.push({ assignees: { none: {} } });
    return combine(arms, "OR");
  }
  // notIn: nobody in the set is assigned — and, when `none` is in the set,
  // somebody IS (an unassigned item is "none", which was excluded).
  if (ids.length > 0) arms.push({ assignees: { none: { userId: { in: ids } } } });
  if (wantsNobody) arms.push({ assignees: { some: {} } });
  return combine(arms, "AND");
}

/** An item is owned by a department if its own is set, else its project's. */
const hasDepartment = (): Where => ({
  OR: [{ departmentId: { not: null } }, { project: { is: { departmentId: { not: null } } } }],
});

/** The null-safe negation of `departmentWorkItemWhere(ids)`: an effective
 *  department that is NOT in the set — and an item with no department at all
 *  qualifies. `NOT (departmentWorkItemWhere(ids))` would lose it. */
const departmentNotIn = (ids: readonly string[]): Where => ({
  OR: [
    { departmentId: { notIn: [...ids] } },
    {
      departmentId: null,
      project: { is: { OR: [{ departmentId: null }, { departmentId: { notIn: [...ids] } }] } },
    },
  ],
});

function department(c: PmFilterCondition, env: Env): Where {
  const s = setOp(c);
  if (s.kind === "empty") return departmentWorkItemWhere(null);
  if (s.kind === "notEmpty") return hasDepartment();

  let wantsNobody = false;
  const ids: string[] = [];
  for (const v of s.values) {
    if (isNoneWord(v)) {
      wantsNobody = true;
      continue;
    }
    const scope = env.scope(v);
    if (scope === undefined) throw err(PM_QUERY_ERRORS.DEPARTMENT_UNRESOLVED);
    if (scope === null) {
      wantsNobody = true;
      continue;
    }
    for (const id of scope) if (!ids.includes(id)) ids.push(id);
  }

  const arms: Where[] = [];
  if (s.kind === "in") {
    if (ids.length > 0) arms.push(departmentWorkItemWhere(ids));
    if (wantsNobody) arms.push(departmentWorkItemWhere(null));
    return combine(arms, "OR");
  }
  if (ids.length > 0) arms.push(departmentNotIn(ids));
  if (wantsNobody) arms.push(hasDepartment());
  return combine(arms, "AND");
}

const DATE_COLUMNS: Record<"dueDate" | "startDate" | "createdAt" | "updatedAt", DateStorage> = {
  dueDate: "date",
  startDate: "date",
  createdAt: "timestamp",
  updatedAt: "timestamp",
};

function dateCondition(col: keyof typeof DATE_COLUMNS, c: PmFilterCondition, env: Env): Where {
  const storage = DATE_COLUMNS[col];
  const start = (token: string) => dayStart(env.day(token), storage, env.tz);
  const end = (token: string) => dayEnd(env.day(token), storage, env.tz);
  switch (c.op) {
    case "isEmpty":
      return { [col]: null };
    case "isNotEmpty":
      return { [col]: { not: null } };
    case "is":
      return { [col]: { gte: start(c.value as string), lt: end(c.value as string) } };
    case "before":
      return { [col]: { lt: start(c.value as string) } };
    case "after":
      return { [col]: { gte: end(c.value as string) } };
    case "between": {
      const [from, to] = c.value as string[];
      return { [col]: { gte: start(from), lt: end(to) } };
    }
    default:
      throw err(PM_QUERY_ERRORS.INVALID_FILTER);
  }
}

function text(c: PmFilterCondition): Where {
  const needle = c.value as string;
  const pattern = escapeLike(needle);
  const arms: Where[] = [
    { name: { contains: pattern, mode: "insensitive" } },
    { descriptionText: { contains: pattern, mode: "insensitive" } },
  ];
  // The search box has always found "INBOX-42" by its key (the client-side
  // filter matched `key`), and a key is not a column: it is the project's
  // identifier and the item's number.
  const key = parseWorkItemKey(needle);
  if (key) {
    arms.push({
      sequenceId: key.sequenceId,
      project: { is: { identifier: { equals: key.identifier, mode: "insensitive" } } },
    });
  }
  return { OR: arms };
}

function condition(c: PmFilterCondition, env: Env): Where {
  switch (c.field) {
    case "state":
      return nullableScalar("stateId", c, (v) => v);
    case "cycle":
      return nullableScalar("cycleId", c, (v) => v);
    case "parent":
      return nullableScalar("parentId", c, (v) => v);
    case "createdBy":
      return nullableScalar("createdById", c, (v) => env.me(v));
    case "priority":
      return requiredScalar("priority", c);
    case "project":
      return requiredScalar("projectId", c);
    case "stateGroup":
      return stateGroup(c);
    case "assignee":
      return assignee(c, env);
    case "label":
      return joinSet("labels", "labelId", c);
    case "module":
      return joinSet("modules", "moduleId", c);
    case "department":
      return department(c, env);
    case "dueDate":
    case "startDate":
    case "createdAt":
    case "updatedAt":
      return dateCondition(c.field, c, env);
    case "text":
      return text(c);
    case "isArchived":
      return { isArchived: c.value as boolean };
  }
}

function node(n: PmFilter, env: Env): Where {
  if (isPmFilterGroup(n)) {
    if ("and" in n) {
      const kids = n.and.map((k) => node(k, env));
      return kids.length === 0 ? {} : combine(kids, "AND");
    }
    return combine(n.or.map((k) => node(k, env)), "OR");
  }
  return condition(n, env);
}

/**
 * Compile a filter. Throws `invalid_filter` for anything the shared validator
 * refuses, `invalid_timezone` for a zone the runtime cannot resolve,
 * `me_unavailable` for `me` without a person, and `department_unresolved` for a
 * department nobody resolved (see `resolve.ts`).
 */
export function compileFilter(filter: PmFilter, ctx: PmFilterContext): Where {
  const valid = validatePmFilter(filter);
  if (!valid.ok) throw err(PM_QUERY_ERRORS.INVALID_FILTER);
  if (!isValidIanaZone(ctx.tz)) throw err(PM_QUERY_ERRORS.INVALID_TIMEZONE);
  try {
    return node(normalizePmFilter(valid.filter), new Env(ctx));
  } catch (e) {
    // A date the calendar arithmetic cannot represent (9999-12-31 + 1 day).
    if (e instanceof RangeError) throw err(PM_QUERY_ERRORS.INVALID_FILTER);
    throw e;
  }
}
