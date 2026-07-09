/**
 * WARP-1094 — write-command registry (brief §11.2, §11.3, §5 rules 3–5).
 *
 * Nothing writes to Eaglesoft outside this registry. Each write is a named
 * command object: `{ name, description, targetTable, allowedColumns,
 * requiredParams, buildStatement, reversalPlan, verifyQuery }`. The LLM /
 * dashboard can only invoke a registered command by name with typed params
 * (invariant 4). Identifiers resolve through the schema map (invariant 3);
 * every value binds as `?`. Only allowlisted columns may be written
 * (invariant 5) and financial / clinical / claim tables are IMPOSSIBLE
 * targets — `assertTargetAllowed` throws and no such command is registered.
 *
 * This module is PURE: it builds statements and plans. It never executes
 * them — the staged outbox → confirm → apply → verify pipeline (brief §11.1)
 * and the (stubbed) driver do that. Writes are further gated by the write
 * opt-in, the confirmation step, and the drift kill-switch, none of which are
 * in scope for this DB-independent foundation.
 */
import { resolveTable, resolveColumn, type SchemaMap } from "./schema-map.js";
import type { BuiltStatement } from "./read-queries.js";

/**
 * Tables that may NEVER be a write target in v1 (invariant 5, brief §11.2):
 * ledger/account balances, financial transactions, insurance claims, and
 * clinical notes/exam/perio/tx-plan. These carry app-enforced invariants and
 * DB triggers; a raw write desyncs money or corrupts the chart.
 */
export const FORBIDDEN_WRITE_TABLES: readonly string[] = [
  "account",
  "serv_trans",
  "ledger",
  "transaction",
  "claim",
  "insurance_claim",
  "clinical_note",
  "exam",
  "perio",
  "tx_plan",
];

const norm = (s: string): string => s.trim().toLowerCase();
const FORBIDDEN_SET = new Set(FORBIDDEN_WRITE_TABLES.map(norm));

/** Thrown when a caller names a write command that is not registered. */
export class UnknownWriteCommandError extends Error {
  readonly code = "UNKNOWN_WRITE_COMMAND";
  constructor(name: string) {
    super(`unknown write command "${name}" — not in the write-command registry`);
    this.name = "UnknownWriteCommandError";
  }
}

/** Thrown when a param names a column outside the command's allowlist. */
export class DisallowedColumnError extends Error {
  readonly code = "DISALLOWED_COLUMN";
  constructor(column: string, command: string) {
    super(`column "${column}" is not on the allowlist for command "${command}"`);
    this.name = "DisallowedColumnError";
  }
}

/** Thrown when a command targets a forbidden (financial/clinical/claim) table. */
export class ForbiddenTargetError extends Error {
  readonly code = "FORBIDDEN_WRITE_TARGET";
  constructor(table: string) {
    super(
      `table "${table}" is a forbidden write target (financial/clinical/claim) — ` +
        `read-only in v1 (invariant 5)`,
    );
    this.name = "ForbiddenTargetError";
  }
}

/** Thrown when a required optimistic-guard/identity param is missing. */
export class MissingParamError extends Error {
  readonly code = "MISSING_REQUIRED_PARAM";
  constructor(param: string, command: string) {
    super(`required param "${param}" missing for command "${command}"`);
    this.name = "MissingParamError";
  }
}

/** Hard guard: throws if `table` is a forbidden write target. Called by every
 *  command builder and enforced again at registration. */
export function assertTargetAllowed(table: string): void {
  if (FORBIDDEN_SET.has(norm(table))) {
    throw new ForbiddenTargetError(table);
  }
}

/** A named, tested, parameterized write command (brief §11.3). */
export interface WriteCommand {
  name: string;
  description: string;
  /** Logical target table; must NOT be in FORBIDDEN_WRITE_TABLES. */
  targetTable: string;
  /** Logical columns this command may write. Enforced by `buildStatement`. */
  allowedColumns: string[];
  /** Params that must be present (identity + optimistic guard). */
  requiredParams: string[];
  /** Build the parameterized UPDATE/INSERT (throws on disallowed column or
   *  missing required param). */
  buildStatement(map: SchemaMap, params: Record<string, unknown>): BuiltStatement;
  /** Given the row's prior values, produce the undo payload (allowlisted
   *  columns only) used by the REVERSED path (brief §11.1 step 5). */
  reversalPlan(prevRow: Record<string, unknown>): Record<string, unknown>;
  /** Re-read the affected row so APPLY's VERIFY step can assert post-state
   *  (brief §11.1 step 4). Parameterized. */
  verifyQuery(map: SchemaMap, params: Record<string, unknown>): BuiltStatement;
}

/**
 * The single v1 write command: reschedule an existing appointment. Highest
 * value, lowest blast radius (brief §11.2). Writes only the four mutable
 * scheduling columns; the primary key and patient link are read-only. Uses an
 * optimistic guard on `last_modified` so we never clobber a front-desk edit
 * made a second earlier (brief §11.4) — a guard-miss aborts to DISCREPANCY.
 */
const rescheduleAppointment: WriteCommand = {
  name: "reschedule_appointment",
  description:
    "Reschedule an existing appointment (time / provider / operatory / status). " +
    "Optimistic-guarded on last_modified; never touches the PK or patient link.",
  targetTable: "appointment",
  allowedColumns: ["appt_time", "provider_id", "operatory_id", "status"],
  requiredParams: ["appt_id", "last_modified"],

  buildStatement(map, params) {
    assertTargetAllowed(this.targetTable);
    for (const req of this.requiredParams) {
      if (params[req] === undefined || params[req] === null) {
        throw new MissingParamError(req, this.name);
      }
    }

    // Columns to SET = every supplied param that is not an identity/guard
    // param. Each must be on the allowlist, or we refuse (invariant 5).
    const identity = new Set(this.requiredParams);
    const setColumns = Object.keys(params).filter((k) => !identity.has(k));
    if (setColumns.length === 0) {
      throw new MissingParamError("<at least one column to update>", this.name);
    }

    const table = resolveTable(map, this.targetTable);
    const setClauses: string[] = [];
    const setValues: unknown[] = [];
    for (const col of setColumns) {
      if (!this.allowedColumns.includes(col)) {
        throw new DisallowedColumnError(col, this.name);
      }
      setClauses.push(`${resolveColumn(map, this.targetTable, col)} = ?`);
      setValues.push(params[col]);
    }

    const apptId = resolveColumn(map, this.targetTable, "appt_id");
    const lastModified = resolveColumn(map, this.targetTable, "last_modified");
    const sql =
      `UPDATE ${table} ` +
      `SET ${setClauses.join(", ")} ` +
      // Optimistic concurrency guard (brief §11.4).
      `WHERE ${apptId} = ? AND ${lastModified} = ?`;
    return { sql, params: [...setValues, params.appt_id, params.last_modified] };
  },

  reversalPlan(prevRow) {
    // Undo = restore exactly the mutable columns to their prior values.
    const reversal: Record<string, unknown> = {};
    for (const col of this.allowedColumns) {
      if (col in prevRow) reversal[col] = prevRow[col];
    }
    return reversal;
  },

  verifyQuery(map, params) {
    assertTargetAllowed(this.targetTable);
    if (params.appt_id === undefined || params.appt_id === null) {
      throw new MissingParamError("appt_id", this.name);
    }
    const table = resolveTable(map, this.targetTable);
    const apptId = resolveColumn(map, this.targetTable, "appt_id");
    const apptTime = resolveColumn(map, this.targetTable, "appt_time");
    const providerId = resolveColumn(map, this.targetTable, "provider_id");
    const operatoryId = resolveColumn(map, this.targetTable, "operatory_id");
    const status = resolveColumn(map, this.targetTable, "status");
    const lastModified = resolveColumn(map, this.targetTable, "last_modified");
    const sql =
      `SELECT ${apptId}, ${apptTime}, ${providerId}, ${operatoryId}, ${status}, ${lastModified} ` +
      `FROM ${table} ` +
      `WHERE ${apptId} = ?`;
    return { sql, params: [params.appt_id] };
  },
};

// Registration-time guard: a forbidden target can never be registered.
const REGISTERED: WriteCommand[] = [rescheduleAppointment];
for (const c of REGISTERED) {
  assertTargetAllowed(c.targetTable);
}

export const WRITE_COMMANDS: readonly WriteCommand[] = REGISTERED;

const BY_NAME: ReadonlyMap<string, WriteCommand> = new Map(
  WRITE_COMMANDS.map((c) => [c.name, c]),
);

/** Look up a registered write command by name; throws on an unknown name. */
export function getWriteCommand(name: string): WriteCommand {
  const c = BY_NAME.get(name);
  if (!c) throw new UnknownWriteCommandError(name);
  return c;
}
