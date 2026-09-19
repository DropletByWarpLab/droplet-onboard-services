/**
 * WARP-2842 — the `where` matcher for the in-memory `IntegrationConnection`
 * stubs behind `connect()`'s optimistic verdict write.
 *
 * `landVerdict` (integrations.service.ts) lands a cloud / REST verdict through
 * `updateMany` keyed on the row id, the sealed credential AND the non-secret
 * `providerConfig` the connector was built from. A stub that matched on `id`
 * alone would make that guard invisible; one that compared every key with
 * `===` would reject the Json filter on sight (`{ equals: {...} }` is never
 * `===` a stored object) and turn every landed verdict into a "superseded"
 * drop. So this mirrors what Prisma + Postgres do, operator by operator:
 *
 * - a scalar (or `null`) is strict equality; `undefined` is NO condition, as
 *   Prisma reads it — which is why the service writes `?? null` on its side;
 * - `{ equals: <json> }` is jsonb equality — value-based and key-order-blind
 *   (`'{"a":1,"b":2}'::jsonb = '{"b":2,"a":1}'::jsonb` is true);
 * - `{ equals: Prisma.DbNull | JsonNull | AnyNull }` matches a stored `null`.
 *   The stubs keep ONE null (a plain `null`), which is also all Prisma lets a
 *   reader see — DB NULL and JSON null both read back as `null` — so the
 *   three sentinels collapse to the same test here, as `AnyNull` does in SQL.
 *
 * EVERY key in `where` must match, as Prisma does it. Anything this does not
 * understand throws, so a new operator in the service reds the suite instead
 * of silently matching nothing (the agent-run mock's rule).
 */
import { Prisma } from "@prisma/client";

type Row = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** jsonb equality: structural, with object key order ignored. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => jsonEqual(a[k], b[k]));
  }
  return false;
}

function isNullSentinel(v: unknown): boolean {
  return v === Prisma.DbNull || v === Prisma.JsonNull || v === Prisma.AnyNull;
}

/** Does `row` satisfy every key of `where`? */
export function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    const stored = row[k] ?? null;
    if (isPlainObject(cond)) {
      const ops = Object.keys(cond);
      if (ops.length === 1 && ops[0] === "equals") {
        const want = cond.equals;
        if (isNullSentinel(want)) return stored === null;
        return jsonEqual(stored, want);
      }
      throw new Error(
        `integration-connection-where: unsupported filter on "${k}": ${JSON.stringify(cond)}`,
      );
    }
    return stored === cond;
  });
}
