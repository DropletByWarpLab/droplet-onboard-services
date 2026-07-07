/**
 * WARP-1094 — read-query registry (brief §10.1, §10.3, §5 rules 3 & 4).
 *
 * The ONLY way data leaves Eaglesoft: a fixed set of named, parameterized
 * queries. Each query declares the tables/columns it touches by LOGICAL name;
 * `buildReadStatement` resolves those to physical identifiers through the
 * introspected schema map (invariant 3) and emits SQL with `?` placeholders
 * for every value (never string-concatenated). The LLM/dashboard names a
 * registered query — it never emits SQL (invariant 4). An unknown name throws.
 *
 * This module is PURE: it builds statements, it does not execute them. The
 * driver is stubbed until the SAP SQL Anywhere client + a copy of
 * PattersonPM.db exist (see connector.ts).
 */
import { resolveTable, resolveColumn, type SchemaMap } from "./schema-map.js";

/** Thrown when a caller names a read query that is not registered. */
export class UnknownReadQueryError extends Error {
  readonly code = "UNKNOWN_READ_QUERY";
  constructor(name: string) {
    super(`unknown read query "${name}" — not in the read-query registry`);
    this.name = "UnknownReadQueryError";
  }
}

/** A built, ready-to-execute parameterized statement. */
export interface BuiltStatement {
  sql: string;
  params: unknown[];
}

/** A named read query. `build` resolves identifiers through the schema map
 *  and binds every value as `?`. `exampleParams` documents the shape and is
 *  used by the unit suite to prove parameterization without a database. */
export interface ReadQuery {
  name: string;
  description: string;
  /** Logical tables this query depends on (for drift/coverage checks). */
  dependsOnTables: string[];
  exampleParams: Record<string, unknown>;
  build(map: SchemaMap, params: Record<string, unknown>): BuiltStatement;
}

const getScheduleToday: ReadQuery = {
  name: "get_schedule_today",
  description: "Today's appointments in a [from, to) time window, ordered by time.",
  dependsOnTables: ["appointment"],
  exampleParams: { from: "2026-07-07T00:00:00Z", to: "2026-07-08T00:00:00Z" },
  build(map, params) {
    const appt = resolveTable(map, "appointment");
    const apptId = resolveColumn(map, "appointment", "appt_id");
    const apptTime = resolveColumn(map, "appointment", "appt_time");
    const providerId = resolveColumn(map, "appointment", "provider_id");
    const operatoryId = resolveColumn(map, "appointment", "operatory_id");
    const status = resolveColumn(map, "appointment", "status");
    const patientId = resolveColumn(map, "appointment", "patient_id");
    const sql =
      `SELECT ${apptId}, ${apptTime}, ${providerId}, ${operatoryId}, ${status}, ${patientId} ` +
      `FROM ${appt} ` +
      `WHERE ${apptTime} >= ? AND ${apptTime} < ? ` +
      `ORDER BY ${apptTime}`;
    return { sql, params: [params.from, params.to] };
  },
};

const findPatient: ReadQuery = {
  name: "find_patient",
  description: "Search patients by last-name prefix (keyset-friendly), minimum-necessary fields.",
  dependsOnTables: ["patient"],
  exampleParams: { query: "smith" },
  build(map, params) {
    const patient = resolveTable(map, "patient");
    const patientId = resolveColumn(map, "patient", "patient_id");
    const firstName = resolveColumn(map, "patient", "first_name");
    const lastName = resolveColumn(map, "patient", "last_name");
    const sql =
      `SELECT ${patientId}, ${firstName}, ${lastName} ` +
      `FROM ${patient} ` +
      `WHERE ${lastName} LIKE ? ` +
      `ORDER BY ${lastName}, ${firstName}`;
    // Prefix match — the `%` is appended in Node, the value still binds as `?`.
    return { sql, params: [`${String(params.query)}%`] };
  },
};

const getArSummary: ReadQuery = {
  name: "get_ar_summary",
  description: "Accounts-receivable summary: total balance and count, aggregated in SQL.",
  dependsOnTables: ["account"],
  exampleParams: {},
  build(map) {
    const account = resolveTable(map, "account");
    const balance = resolveColumn(map, "account", "balance");
    const accountId = resolveColumn(map, "account", "account_id");
    // Aggregate in SQL (brief §10.1) — never pull raw ledger rows to Node.
    const sql =
      `SELECT COUNT(${accountId}) AS account_count, ` +
      `SUM(${balance}) AS total_balance ` +
      `FROM ${account}`;
    return { sql, params: [] };
  },
};

export const READ_QUERIES: readonly ReadQuery[] = [getScheduleToday, findPatient, getArSummary];

const BY_NAME: ReadonlyMap<string, ReadQuery> = new Map(READ_QUERIES.map((q) => [q.name, q]));

/** Look up a registered read query by name; throws on an unknown name. */
export function getReadQuery(name: string): ReadQuery {
  const q = BY_NAME.get(name);
  if (!q) throw new UnknownReadQueryError(name);
  return q;
}

/** Build the parameterized statement for a named read query. Identifiers
 *  resolve through the schema map (throws on drift/unmapped); values bind
 *  as `?`. Never executes — that is the (stubbed) driver's job. */
export function buildReadStatement(
  map: SchemaMap,
  name: string,
  params: Record<string, unknown>,
): BuiltStatement {
  return getReadQuery(name).build(map, params);
}
