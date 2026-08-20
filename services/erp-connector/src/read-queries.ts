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

/**
 * Escape SQL `LIKE` metacharacters (`%`, `_`, and the escape char itself) in a
 * user-supplied search term so it can only match a literal prefix — never a
 * wildcard. Without this, a `find_patient` query of "%" would match every
 * patient row (a PHI minimum-necessary violation, brief §14). The value still
 * binds as `?`; this closes the wildcard-scoping hole, not an injection one.
 * Pairs with `... LIKE ? ESCAPE '\'`.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Translate the `erp_get_schedule_today` tool's `date` (YYYY-MM-DD) input into
 * the half-open `[from, to)` bounds the `get_schedule_today` query binds — the
 * single, tested seam between the tool's contract and the query's, so the two
 * halves can't silently disagree when the live path is wired (WARP-1095+).
 * Returns UTC day bounds; local-timezone day boundaries are a WARP-1095
 * refinement (brief §8.2). Throws on a malformed date rather than silently
 * producing an empty window.
 */
export function scheduleDayBounds(date: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`invalid schedule date "${date}" — expected YYYY-MM-DD`);
  }
  const from = `${date}T00:00:00.000Z`;
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + 1);
  return { from, to: next.toISOString() };
}

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
      `WHERE ${lastName} LIKE ? ESCAPE '\\' ` +
      `ORDER BY ${lastName}, ${firstName}`;
    // Prefix match. LIKE metacharacters in the term are escaped so a "%"/"_"
    // can't turn a name search into a full-table scan (PHI over-fetch); the
    // trailing `%` (the prefix wildcard) is appended after escaping and the
    // value still binds as `?` (never concatenated).
    return { sql, params: [`${escapeLike(String(params.query))}%`] };
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

const getPatient: ReadQuery = {
  name: "get_patient",
  description: "One patient's minimum-necessary summary, by id.",
  dependsOnTables: ["patient"],
  exampleParams: { patientId: "p-123" },
  build(map, params) {
    const patient = resolveTable(map, "patient");
    const patientId = resolveColumn(map, "patient", "patient_id");
    const firstName = resolveColumn(map, "patient", "first_name");
    const lastName = resolveColumn(map, "patient", "last_name");
    const sql =
      `SELECT ${patientId}, ${firstName}, ${lastName} ` +
      `FROM ${patient} ` +
      `WHERE ${patientId} = ?`;
    return { sql, params: [params.patientId] };
  },
};

const getRecallDue: ReadQuery = {
  name: "get_recall_due",
  description:
    "Patients overdue for recare/recall (minimum-necessary). The recall predicate + recall-table join are refined against the live schema in WARP-1096.",
  dependsOnTables: ["patient"],
  exampleParams: {},
  build(map) {
    const patient = resolveTable(map, "patient");
    const patientId = resolveColumn(map, "patient", "patient_id");
    const firstName = resolveColumn(map, "patient", "first_name");
    const lastName = resolveColumn(map, "patient", "last_name");
    const sql =
      `SELECT ${patientId}, ${firstName}, ${lastName} ` +
      `FROM ${patient} ` +
      `ORDER BY ${lastName}, ${firstName}`;
    return { sql, params: [] };
  },
};

// ── WARP-2107 — accounting reads ────────────────────────────────────────────
//
// These depend on datasets no practice-management track serves, which is the
// whole reason `Connector.servesDatasets` exists (see connector.ts): a track is
// asked only for datasets it has declared, and asking for one it has not is a
// typed refusal rather than a resolve failure deep in a build.
//
// The SQL here is written even though no shipping track executes it. The
// registry is the single definition of what a read MEANS, and a future
// accounting provider with a real database must inherit that definition rather
// than invent a second one.

const getOpenInvoices: ReadQuery = {
  name: "get_open_invoices",
  description: "Unpaid/partly-paid customer invoices — money owed TO the business — oldest due first.",
  dependsOnTables: ["invoice"],
  exampleParams: {},
  build(map) {
    const invoice = resolveTable(map, "invoice");
    const invoiceId = resolveColumn(map, "invoice", "invoice_id");
    const issuedAt = resolveColumn(map, "invoice", "issued_at");
    const dueAt = resolveColumn(map, "invoice", "due_at");
    const customerId = resolveColumn(map, "invoice", "customer_id");
    const amount = resolveColumn(map, "invoice", "amount");
    const balance = resolveColumn(map, "invoice", "balance");
    const status = resolveColumn(map, "invoice", "status");
    // "Open" is a non-zero balance, not a status string: status vocabularies
    // differ per product ("Open"/"Overdue"/"Partial"/"Sent"), and every one of
    // them agrees that money is outstanding when the balance is not zero.
    const sql =
      `SELECT ${invoiceId}, ${issuedAt}, ${dueAt}, ${customerId}, ${amount}, ${balance}, ${status} ` +
      `FROM ${invoice} ` +
      `WHERE ${balance} <> 0 ` +
      `ORDER BY ${dueAt}, ${invoiceId}`;
    return { sql, params: [] };
  },
};

const getOpenBills: ReadQuery = {
  name: "get_open_bills",
  description: "Unpaid/partly-paid vendor bills — money owed BY the business — oldest due first.",
  dependsOnTables: ["bill"],
  exampleParams: {},
  build(map) {
    const bill = resolveTable(map, "bill");
    const billId = resolveColumn(map, "bill", "bill_id");
    const issuedAt = resolveColumn(map, "bill", "issued_at");
    const dueAt = resolveColumn(map, "bill", "due_at");
    const vendorId = resolveColumn(map, "bill", "vendor_id");
    const amount = resolveColumn(map, "bill", "amount");
    const balance = resolveColumn(map, "bill", "balance");
    const status = resolveColumn(map, "bill", "status");
    const sql =
      `SELECT ${billId}, ${issuedAt}, ${dueAt}, ${vendorId}, ${amount}, ${balance}, ${status} ` +
      `FROM ${bill} ` +
      `WHERE ${balance} <> 0 ` +
      `ORDER BY ${dueAt}, ${billId}`;
    return { sql, params: [] };
  },
};

const getApSummary: ReadQuery = {
  name: "get_ap_summary",
  description: "Accounts-payable summary: total owed and vendor count, aggregated in SQL.",
  dependsOnTables: ["ap_summary"],
  exampleParams: {},
  build(map) {
    const table = resolveTable(map, "ap_summary");
    const vendorId = resolveColumn(map, "ap_summary", "vendor_id");
    const balance = resolveColumn(map, "ap_summary", "balance");
    // Mirrors get_ar_summary exactly, including aggregating in SQL rather than
    // shipping rows to Node (brief §10.1).
    const sql =
      `SELECT COUNT(${vendorId}) AS vendor_count, ` +
      `SUM(${balance}) AS total_balance ` +
      `FROM ${table}`;
    return { sql, params: [] };
  },
};

export const READ_QUERIES: readonly ReadQuery[] = [
  getScheduleToday,
  findPatient,
  getArSummary,
  getPatient,
  getRecallDue,
  getOpenInvoices,
  getOpenBills,
  getApSummary,
];

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
