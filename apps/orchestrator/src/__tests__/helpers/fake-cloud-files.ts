/**
 * WARP-3538 — in-memory `CloudFileItem` and `CloudFileSource` delegates that
 * EVALUATE their arguments, for the DB-less lanes (the store, the search, the
 * Microsoft 365 landing handler, the sync engine's discovery, the routes).
 *
 * Everything these tables promise lives in their where-clauses: `userId` on
 * every statement, `provider`, the source, `sweepPending: true` on the sweep. A
 * stub that returned canned rows would prove only that the code CALLED Prisma;
 * this one filters, so a dropped predicate changes what the test sees — which is
 * the whole reason the store's tests can claim "never touches another person's
 * rows".
 *
 * It reuses `matchesWhere` from `fake-table.ts` for the filter language (equality
 * with null, `in`, `not`, `gte`/`lte`, `contains`, `OR`/`AND`), which THROWS on an
 * operator it does not know — a query this cannot evaluate is a loud failure, not
 * a silent match. What it adds is what the cloud-file code needs and that helper
 * lacks: `upsert` by a compound unique key, `findFirst`, `count`, `groupBy`
 * and `orderBy` with Prisma's `{ sort, nulls }` form.
 *
 * Deliberately small, and strict about arguments it does not model.
 */
import { vi } from "vitest";

import { matchesWhere, type Row } from "./fake-table.js";

type Where = Record<string, unknown>;

const ARGS = new Set(["where", "data", "create", "update", "orderBy", "take", "select", "by", "_count"]);

function checkArgs(args: Record<string, unknown>): void {
  for (const k of Object.keys(args)) if (!ARGS.has(k)) throw new Error(`fake-cloud-files: unsupported argument ${k}`);
}

function project(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

type OrderTerm = Record<string, "asc" | "desc" | { sort: "asc" | "desc"; nulls?: "first" | "last" }>;

function scalar(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

/** Prisma's ordering: ASC puts NULLs last and DESC first (Postgres' default) unless `nulls` says otherwise. */
function order(rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) return rows;
  const terms = (Array.isArray(orderBy) ? orderBy : [orderBy]) as OrderTerm[];
  return [...rows].sort((x, y) => {
    for (const term of terms) {
      const [[field, spec]] = Object.entries(term);
      const dir = typeof spec === "string" ? spec : spec.sort;
      const nulls = typeof spec === "string" ? (dir === "asc" ? "last" : "first") : (spec.nulls ?? (dir === "asc" ? "last" : "first"));
      const a = scalar(x[field]);
      const b = scalar(y[field]);
      if (a === b) continue;
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      if (aNull && bNull) continue;
      if (aNull || bNull) return (aNull ? 1 : -1) * (nulls === "first" ? -1 : 1);
      return ((a as number) < (b as number) ? -1 : 1) * (dir === "asc" ? 1 : -1);
    }
    return 0;
  });
}

/** One delegate over one array of rows. */
function table(rows: Row[], defaults: () => Row, uniqueKeys: readonly string[]) {
  let n = 0;
  /** `where: { userId_provider_sourceId: { … } }` — Prisma's compound-unique form. */
  const byUnique = (where: Where): Row | null => {
    const entries = Object.entries(where);
    const [[name, fields]] = entries;
    if (entries.length !== 1 || !uniqueKeys.includes(name!) || typeof fields !== "object" || fields === null) {
      throw new Error(`fake-cloud-files: unique lookup by ${Object.keys(where).join()}`);
    }
    return rows.find((r) => Object.entries(fields).every(([k, v]) => r[k] === v)) ?? null;
  };
  const full = (data: Row): Row => {
    const now = new Date();
    return { id: `row-${++n}`, createdAt: now, updatedAt: now, ...defaults(), ...data };
  };

  return {
    seed(row: Row): Row {
      const made = full(row);
      rows.push(made);
      return made;
    },
    delegate: {
      upsert: vi.fn(async (args: { where: Where; create: Row; update: Row }) => {
        checkArgs(args);
        const found = byUnique(args.where);
        if (found) {
          Object.assign(found, args.update, { updatedAt: new Date() });
          return { ...found };
        }
        const made = full(args.create);
        rows.push(made);
        return { ...made };
      }),
      findMany: vi.fn(async (args: { where?: Where; orderBy?: unknown; take?: number; select?: Record<string, boolean> } = {}) => {
        checkArgs(args);
        const hit = order(rows.filter((r) => matchesWhere(r, args.where)), args.orderBy);
        return (args.take === undefined ? hit : hit.slice(0, args.take)).map((r) => project(r, args.select));
      }),
      findFirst: vi.fn(async (args: { where?: Where; orderBy?: unknown; select?: Record<string, boolean> } = {}) => {
        checkArgs(args);
        const hit = order(rows.filter((r) => matchesWhere(r, args.where)), args.orderBy)[0];
        return hit ? project(hit, args.select) : null;
      }),
      count: vi.fn(async (args: { where?: Where } = {}) => {
        checkArgs(args);
        return rows.filter((r) => matchesWhere(r, args.where)).length;
      }),
      groupBy: vi.fn(async (args: { by: string[]; where?: Where; _count?: { _all: true } }) => {
        checkArgs(args);
        const groups = new Map<string, { key: Row; n: number }>();
        for (const r of rows.filter((x) => matchesWhere(x, args.where))) {
          const key = Object.fromEntries(args.by.map((f) => [f, r[f]]));
          const id = JSON.stringify(args.by.map((f) => r[f]));
          const g = groups.get(id) ?? { key, n: 0 };
          g.n += 1;
          groups.set(id, g);
        }
        return [...groups.values()].map((g) => ({ ...g.key, _count: { _all: g.n } }));
      }),
      updateMany: vi.fn(async (args: { where: Where; data: Row }) => {
        checkArgs(args);
        const hit = rows.filter((r) => matchesWhere(r, args.where));
        for (const r of hit) Object.assign(r, args.data, { updatedAt: new Date() });
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async (args: { where: Where }) => {
        checkArgs(args);
        const hit = rows.filter((r) => matchesWhere(r, args.where));
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { count: hit.length };
      }),
    },
  };
}

/** The two tables, ready to hand to anything that takes `CloudFileDb`. */
export function makeFakeCloudFileDb() {
  const items: Row[] = [];
  const sources: Row[] = [];
  const itemTable = table(
    items,
    () => ({ parentExternalId: null, webUrlEnc: null, lastModifiedByEnc: null, mimeType: null, sizeBytes: null, remoteCreatedAt: null, remoteModifiedAt: null, sweepPending: false }),
    ["userId_provider_sourceId_externalId"],
  );
  const sourceTable = table(
    sources,
    () => ({ siteId: null, siteNameEnc: null, webUrlEnc: null, followed: false }),
    ["userId_provider_sourceId"],
  );
  return {
    /** The live arrays — assertions read what the database would hold. */
    items,
    sources,
    seedItem: itemTable.seed,
    seedSource: sourceTable.seed,
    cloudFileItem: itemTable.delegate,
    cloudFileSource: sourceTable.delegate,
  };
}

export type FakeCloudFileDb = ReturnType<typeof makeFakeCloudFileDb>;
