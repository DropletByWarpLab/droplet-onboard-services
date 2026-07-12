/**
 * WARP-1294 — pure mappers: Patterson Web-API-2 JSON → the EXACT row shapes the
 * SQL track returns, so `runRead` is transport-agnostic above the connector.
 *
 * The canonical row keys are the SQL SELECT identifiers (snake_case), e.g. a
 * schedule row is `{ appt_id, appt_time, provider_id, operatory_id, status,
 * patient_id }`. The API's native field names are UNKNOWN until the "API Fields"
 * doc / `/help` is read, so every mapping is driven by `RouteSpec.fields`
 * (canonicalKey -> apiFieldPath) — this module never bakes a Patterson field
 * name. No I/O here; fully unit-testable.
 */
import { pluck } from "./api-auth.js";
import { type RouteSpec } from "./api-route-map.js";

/** Pull the list of API records out of a response per `route.listPath`.
 *  Returns `[]` for a null/absent path and wraps a lone object as a 1-element
 *  list so get-by-id endpoints and list endpoints share one mapper. */
export function extractRecords(payload: unknown, route: RouteSpec): Record<string, unknown>[] {
  const node = pluck(payload, route.listPath);
  if (node == null) return [];
  if (Array.isArray(node)) return node.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  if (typeof node === "object") return [node as Record<string, unknown>];
  return [];
}

/** Project one API record onto the canonical row keys via `route.fields`
 *  (canonicalKey -> apiFieldPath). A field the API omitted becomes `undefined`
 *  on the row, exactly as a NULL column would from SQL. */
export function projectRow(
  record: Record<string, unknown>,
  fields: Record<string, string>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [canonicalKey, apiPath] of Object.entries(fields)) {
    row[canonicalKey] = pluck(record, apiPath);
  }
  return row;
}

/** Map a whole response to canonical rows. Requires `route.fields` — a route
 *  discovered without a field map cannot be mapped and the caller must block. */
export function mapRows(payload: unknown, route: RouteSpec): Record<string, unknown>[] {
  if (!route.fields) {
    throw new Error(`route ${route.controller}.${route.method} has no discovered field map`);
  }
  const fields = route.fields;
  return extractRecords(payload, route).map((rec) => projectRow(rec, fields));
}

/** Stable sort by a comparable column (used to reproduce the SQL `ORDER BY`).
 *  Returns a new array; treats undefined as the smallest value. */
export function sortByKey<T extends Record<string, unknown>>(rows: T[], key: string): T[] {
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === undefined || av === null) return -1;
    if (bv === undefined || bv === null) return 1;
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

/**
 * Aggregate an Account-controller payload into the single AR-summary row the SQL
 * track produces: `{ account_count, total_balance }`. Aggregating client-side
 * (COUNT + SUM over the mapped balances) reproduces the SQL aggregate and keeps
 * the minimum-necessary contract — the connector returns the two numbers, never
 * the raw ledger rows. `route.fields` must map a `balance` key.
 */
export function aggregateArSummary(payload: unknown, route: RouteSpec): { account_count: number; total_balance: number } {
  const rows = mapRows(payload, route);
  let total = 0;
  for (const r of rows) {
    const n = Number(r.balance);
    if (Number.isFinite(n)) total += n;
  }
  return { account_count: rows.length, total_balance: total };
}
