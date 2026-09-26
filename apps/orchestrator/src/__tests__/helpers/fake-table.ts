/**
 * WARP-3101 — an in-memory Prisma model delegate that EVALUATES its arguments,
 * for the DB-less lanes (CalendarEvent, Reminder).
 *
 * The ownership contract of the calendar and reminder routes lives in their
 * where-clauses (`userId`, the overlap window, `completedAt: null`, the
 * `{ id, userId }` scoped write). A stub that returns canned rows proves only
 * that the code CALLED Prisma; this one filters, orders and updates, so a
 * dropped predicate or a wrong key changes what the test sees.
 *
 * Deliberately small: equality (null included), `not`, `in`, `lt`/`lte`/`gt`/
 * `gte`, `contains` (+ `mode: "insensitive"`), `OR`/`AND`, `orderBy` (ASC puts
 * NULLs last, DESC first — Postgres' default), `take`, and a flat `select`. An
 * operator or argument it does not know throws, so a query shape it cannot
 * evaluate is a loud test failure, never a silent match.
 */
import { vi } from "vitest";

export type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const OPERATORS = new Set(["not", "in", "lt", "lte", "gt", "gte", "equals", "contains", "mode"]);
const ARGS = new Set(["where", "data", "orderBy", "take", "select"]);

function scalar(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
}

function matchValue(actual: unknown, cond: unknown): boolean {
  if (!isOperatorObject(cond)) return cond === null ? actual === null || actual === undefined : scalar(actual) === scalar(cond);
  const insensitive = cond.mode === "insensitive";
  for (const [op, v] of Object.entries(cond)) {
    if (!OPERATORS.has(op)) throw new Error(`fake-table: unsupported operator ${op}`);
    if (op === "mode") {
      if (v !== "insensitive" && v !== "default") throw new Error(`fake-table: unsupported mode ${String(v)}`);
      continue;
    }
    if (op === "not" && matchValue(actual, v)) return false;
    if (op === "equals" && !matchValue(actual, v)) return false;
    if (op === "in" && !(v as unknown[]).some((x) => scalar(actual) === scalar(x))) return false;
    if (op === "contains") {
      if (typeof actual !== "string") return false;
      const [a, n] = insensitive ? [actual.toLowerCase(), String(v).toLowerCase()] : [actual, String(v)];
      if (!a.includes(n)) return false;
    }
    if (["lt", "lte", "gt", "gte"].includes(op)) {
      if (actual === null || actual === undefined) return false;
      const a = scalar(actual) as number;
      const b = scalar(v) as number;
      if (op === "lt" && !(a < b)) return false;
      if (op === "lte" && !(a <= b)) return false;
      if (op === "gt" && !(a > b)) return false;
      if (op === "gte" && !(a >= b)) return false;
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Where[]).some((w) => matchesWhere(row, w))) return false;
    } else if (key === "AND") {
      if (!(cond as Where[]).every((w) => matchesWhere(row, w))) return false;
    } else if (!matchValue(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function order(rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((x, y) => {
    for (const k of keys) {
      const [[field, dir]] = Object.entries(k);
      const a = scalar(x[field]);
      const b = scalar(y[field]);
      if (a === b) continue;
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      if (aNull && bNull) continue;
      // Postgres: ASC → NULLS LAST, DESC → NULLS FIRST.
      if (aNull || bNull) return (aNull ? 1 : -1) * (dir === "asc" ? 1 : -1);
      return ((a as number) < (b as number) ? -1 : 1) * (dir === "asc" ? 1 : -1);
    }
    return 0;
  });
}

function project(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

function checkArgs(args: Record<string, unknown>): void {
  for (const k of Object.keys(args)) if (!ARGS.has(k)) throw new Error(`fake-table: unsupported argument ${k}`);
}

/**
 * @param defaults the column defaults a create fills in (Prisma `@default`s),
 *                 applied under the caller's `data`.
 */
export function makeFakeTable(defaults: () => Row) {
  const rows: Row[] = [];
  let n = 0;
  const byId = (where: Where) => {
    if (Object.keys(where).join() !== "id") throw new Error(`fake-table: unique lookup by ${Object.keys(where).join()}`);
    return rows.find((r) => r.id === where.id) ?? null;
  };

  const delegate = {
    create: vi.fn(async (args: { data: Row; select?: Record<string, boolean> }) => {
      checkArgs(args);
      const now = new Date();
      const row = { id: `row-${++n}`, createdAt: now, updatedAt: now, ...defaults(), ...args.data };
      rows.push(row);
      return project(row, args.select);
    }),
    findMany: vi.fn(
      async (args: { where?: Where; orderBy?: unknown; take?: number; select?: Record<string, boolean> } = {}) => {
        checkArgs(args);
        const hit = order(rows.filter((r) => matchesWhere(r, args.where)), args.orderBy);
        return (args.take === undefined ? hit : hit.slice(0, args.take)).map((r) => project(r, args.select));
      },
    ),
    findUnique: vi.fn(async (args: { where: Where; select?: Record<string, boolean> }) => {
      checkArgs(args);
      const row = byId(args.where);
      return row ? project(row, args.select) : null;
    }),
    findUniqueOrThrow: vi.fn(async (args: { where: Where; select?: Record<string, boolean> }) => {
      checkArgs(args);
      const row = byId(args.where);
      if (!row) throw new Error("fake-table: no row");
      return project(row, args.select);
    }),
    update: vi.fn(async (args: { where: Where; data: Row; select?: Record<string, boolean> }) => {
      checkArgs(args);
      const row = byId(args.where);
      if (!row) throw new Error("fake-table: record to update not found");
      Object.assign(row, args.data, { updatedAt: new Date() });
      return project(row, args.select);
    }),
    updateMany: vi.fn(async (args: { where: Where; data: Row }) => {
      checkArgs(args);
      const hit = rows.filter((r) => matchesWhere(r, args.where));
      for (const r of hit) Object.assign(r, args.data, { updatedAt: new Date() });
      return { count: hit.length };
    }),
    delete: vi.fn(async (args: { where: Where }) => {
      checkArgs(args);
      const row = byId(args.where);
      if (!row) throw new Error("fake-table: record to delete not found");
      rows.splice(rows.indexOf(row), 1);
      return row;
    }),
    deleteMany: vi.fn(async (args: { where: Where }) => {
      checkArgs(args);
      const hit = rows.filter((r) => matchesWhere(r, args.where));
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return { count: hit.length };
    }),
  };

  return {
    delegate,
    rows,
    /** A row as if written before the test (defaults applied under `row`). */
    seed(row: Row): Row {
      const now = new Date();
      const full = { id: `seed-${++n}`, createdAt: now, updatedAt: now, ...defaults(), ...row };
      rows.push(full);
      return full;
    },
  };
}

export type FakeTable = ReturnType<typeof makeFakeTable>;
