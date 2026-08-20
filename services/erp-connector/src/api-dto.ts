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
/**
 * Sum a column of money and return it as a currency figure.
 *
 * WARP-2107. Accumulating IEEE-754 doubles is exact for a handful of values and
 * visibly wrong for a ledger: six real balances sum to `17018.979999999996`,
 * and that is what a dashboard renders and what the assistant reads aloud.
 * Rounding to cents at the END (never per addition, which would compound the
 * rounding instead of removing it) gives the figure a person would get.
 *
 * Cents, not arbitrary precision: every currency this reads is decimal to two
 * places, and a total this size is nowhere near the point where a double loses
 * integer precision.
 */
export function roundCents(value: number): number {
  // +0 normalises -0, so a zero total never serializes as "-0".
  return Math.round((value + Number.EPSILON) * 100) / 100 + 0;
}

/** Sum the finite values of `column` across `rows`, as a currency figure. */
export function sumMoney(
  rows: readonly Record<string, unknown>[],
  column = "balance",
): number {
  let total = 0;
  for (const r of rows) {
    const n = Number(r[column]);
    if (Number.isFinite(n)) total += n;
  }
  return roundCents(total);
}

/**
 * Sum a money column AND report how many rows could not be read.
 *
 * WARP-2107, after a pre-PR review found the two halves contradicting each
 * other: the list reads deliberately KEEP a document whose balance will not
 * parse ("money we cannot account for must stay visible"), while the summary
 * silently skipped it. The same bill was therefore listed as open money owed
 * and contributed nothing to what the business was told it owed — and the total
 * carried no signal that anything was missing.
 *
 * A total that is short is not fixable by the reader unless they know it is
 * short. So `unaccounted_count` travels WITH the number, always, and is 0 in
 * the normal case rather than being omitted — an absent field would be one more
 * thing inferred from absence.
 *
 * Note `get_ar_summary` has the same latent issue on shipped code and is NOT
 * changed here: its row shape is a published contract across three tracks, and
 * changing it belongs in its own ticket rather than riding along with this one.
 */
export function sumMoneyWithGaps(
  rows: readonly Record<string, unknown>[],
  column = "balance",
): { total: number; unaccounted: number } {
  let total = 0;
  let unaccounted = 0;
  for (const r of rows) {
    const n = Number(r[column]);
    if (Number.isFinite(n)) total += n;
    else unaccounted += 1;
  }
  return { total: roundCents(total), unaccounted };
}

export function aggregateArSummary(payload: unknown, route: RouteSpec): { account_count: number; total_balance: number } {
  const rows = mapRows(payload, route);
  return { account_count: rows.length, total_balance: sumMoney(rows) };
}
