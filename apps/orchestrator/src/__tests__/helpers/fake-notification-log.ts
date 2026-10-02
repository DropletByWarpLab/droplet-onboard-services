/**
 * WARP-2804 — an in-memory `prisma.notificationLog` that EVALUATES its
 * arguments, for the DB-less lanes.
 *
 * The ack contract lives in where-clauses: `username` (only the recipient),
 * `ackState` (first ack wins, `untracked` never counted), `createdAt <=
 * before` (ack-all never sweeps what arrived after the user looked) and the
 * keyset cursor. A stub that returns canned rows proves only that the code
 * CALLED Prisma; this one filters, orders, projects and updates, so dropping a
 * predicate changes what the test sees. The real-Postgres twin is
 * `notifications-ack.pg.test.ts`.
 *
 * Deliberately small: equality, `in`, `lt`/`lte`/`gt`/`gte`, `startsWith`,
 * `OR`/`AND`, `select`, `orderBy`, `take`. An operator it does not know throws,
 * so a query shape it cannot evaluate is a loud test failure, never a silent
 * match.
 */
import { vi } from "vitest";

export interface FakeNotificationRow {
  id: string;
  username: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  data: unknown;
  channels: string;
  deliveredAt: Date | null;
  error: string | null;
  pushOutcome: string | null;
  createdAt: Date;
  ackState: "unacked" | "acked" | "untracked";
  ackedAt: Date | null;
  ackMethod: string | null;
  ackSessionId: string | null;
  ackClient: string | null;
  ackSessionChecked: boolean;
}

type Where = Record<string, unknown>;

const OPERATORS = new Set(["in", "lt", "lte", "gt", "gte", "equals", "startsWith"]);

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  return (x as number | string) < (y as number | string) ? -1 : 1;
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
}

function matchValue(actual: unknown, cond: unknown): boolean {
  if (!isOperatorObject(cond)) return cond === null ? actual === null : cmp(actual, cond) === 0;
  for (const [op, v] of Object.entries(cond)) {
    if (!OPERATORS.has(op)) throw new Error(`fake-notification-log: unsupported operator ${op}`);
    if (op === "in" && !(v as unknown[]).some((x) => cmp(actual, x) === 0)) return false;
    if (op === "equals" && cmp(actual, v) !== 0) return false;
    if (op === "lt" && !(actual !== null && cmp(actual, v) < 0)) return false;
    if (op === "lte" && !(actual !== null && cmp(actual, v) <= 0)) return false;
    if (op === "gt" && !(actual !== null && cmp(actual, v) > 0)) return false;
    if (op === "gte" && !(actual !== null && cmp(actual, v) >= 0)) return false;
    if (op === "startsWith" && !(typeof actual === "string" && actual.startsWith(v as string))) return false;
  }
  return true;
}

export function matchesWhere(row: FakeNotificationRow, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === "OR") {
      if (!(cond as Where[]).some((w) => matchesWhere(row, w))) return false;
    } else if (k === "AND") {
      const all = Array.isArray(cond) ? (cond as Where[]) : [cond as Where];
      if (!all.every((w) => matchesWhere(row, w))) return false;
    } else if (!(k in row)) {
      throw new Error(`fake-notification-log: unknown column ${k}`);
    } else if (!matchValue((row as unknown as Record<string, unknown>)[k], cond)) {
      return false;
    }
  }
  return true;
}

function project(row: FakeNotificationRow, select?: Record<string, boolean>): Record<string, unknown> {
  const copy = { ...row } as Record<string, unknown>;
  if (!select) return copy;
  return Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, copy[k]]));
}

function sortRows(rows: FakeNotificationRow[], orderBy: unknown): FakeNotificationRow[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return rows.slice().sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0]!;
      const c = cmp((a as unknown as Record<string, unknown>)[k], (b as unknown as Record<string, unknown>)[k]);
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

export interface FakeNotificationLog {
  rows: FakeNotificationRow[];
  delegate: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  /** Seed a row directly (a row written before WARP-2804, someone else's row…). */
  seed(over: Partial<FakeNotificationRow> & Pick<FakeNotificationRow, "username">): FakeNotificationRow;
}

/** `createdAt` advances 1 ms per row from `start`, so insertion order is time order. */
export function makeFakeNotificationLog(start = new Date("2026-09-24T08:00:00.000Z")): FakeNotificationLog {
  const rows: FakeNotificationRow[] = [];
  let seq = 0;
  const nextCreatedAt = () => new Date(start.getTime() + rows.length);

  const fill = (over: Partial<FakeNotificationRow> & Pick<FakeNotificationRow, "username">): FakeNotificationRow => ({
    id: `log-${++seq}`,
    kind: "system",
    title: "t",
    body: null,
    url: null,
    data: null,
    channels: "",
    deliveredAt: null,
    error: null,
    pushOutcome: null,
    createdAt: nextCreatedAt(),
    ackState: "unacked",
    ackedAt: null,
    ackMethod: null,
    ackSessionId: null,
    ackClient: null,
    ackSessionChecked: false,
    ...over,
  });

  const delegate = {
    create: vi.fn(async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      const row = fill(clean as Partial<FakeNotificationRow> & Pick<FakeNotificationRow, "username">);
      rows.push(row);
      return project(row, select);
    }),
    findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = rows.find((r) => r.id === where.id);
      return row ? project(row, select) : null;
    }),
    findFirst: vi.fn(async ({ where, select, orderBy }: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown }) => {
      const row = sortRows(rows.filter((r) => matchesWhere(r, where)), orderBy)[0];
      return row ? project(row, select) : null;
    }),
    findMany: vi.fn(
      async ({ where, select, orderBy, take }: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown; take?: number } = {}) => {
        const hit = sortRows(rows.filter((r) => matchesWhere(r, where)), orderBy);
        return (take === undefined ? hit : hit.slice(0, take)).map((r) => project(r, select));
      },
    ),
    update: vi.fn(async ({ where, data, select }: { where: { id: string }; data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
      Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      return project(row, select);
    }),
    updateMany: vi.fn(async ({ where, data }: { where?: Where; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matchesWhere(r, where));
      for (const row of hit) Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      return { count: hit.length };
    }),
    count: vi.fn(async ({ where }: { where?: Where } = {}) => rows.filter((r) => matchesWhere(r, where)).length),
  };

  return {
    rows,
    delegate,
    seed(over) {
      const row = fill(over);
      rows.push(row);
      return row;
    },
  };
}
