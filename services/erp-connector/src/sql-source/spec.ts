/**
 * WARP-2011 — declarative query descriptors for the generic SQL-source track.
 *
 * The operator must never write SQL — not a line, not stored, not validated,
 * not executed. What they author is a `SqlQuerySpec`: an object naming a table,
 * some columns, some closed-enum predicates and a mandatory row cap. This
 * module validates that descriptor at registration time and compiles it to a
 * parameterized statement through the same schema map the Eaglesoft read
 * registry already uses (invariant 3: identifiers bind ONLY through the map;
 * values are ALWAYS `?`).
 *
 * Why a compiler and not a validator. A validator would have to agree with
 * five real dialects about comments, dollar-quoting, batch separators and
 * string escapes — and it only has to be wrong once. A compiler has no SQL to
 * parse: the only strings that reach the output are constants written in this
 * file plus identifiers resolved through the map. There is no path from an
 * operator's or a model's input to the SQL text.
 *
 * The single exception is the row cap, which is interpolated because engines in
 * the `TOP n` family do not reliably accept a bound parameter there. It is
 * `Number.isInteger`-checked and range-checked on both the validate and the
 * compile path, and it is never caller text.
 *
 * This module is PURE — no I/O, no driver, no Prisma.
 */
import { escapeLike, type BuiltStatement } from "../read-queries.js";
import { resolveColumn, resolveTable, type SchemaMap } from "../schema-map.js";
import type { LimitStyle } from "./engines.js";

/* -------------------------------------------------------------------------- */
/* Descriptor types                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The CLOSED set of predicates. Each member's SQL fragment is a compile-time
 * constant in {@link compileQuerySpec}; there is no member whose text comes
 * from data. Extending this list is a deliberate code change, reviewed.
 */
export type SqlOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "prefix"
  | "between"
  | "in"
  | "is_null"
  | "is_not_null";

export const SQL_OPS: readonly SqlOp[] = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "prefix",
  "between",
  "in",
  "is_null",
  "is_not_null",
] as const;

/** Ops that bind no value at all — declaring a param for them is an error. */
const NULLARY_OPS: readonly SqlOp[] = ["is_null", "is_not_null"] as const;

/** Declared parameter types. Runtime values are checked against these. */
export type SqlParamType = "string" | "number" | "boolean" | "date";

export const SQL_PARAM_TYPES: readonly SqlParamType[] = [
  "string",
  "number",
  "boolean",
  "date",
] as const;

export interface SqlQueryParam {
  name: string;
  type: SqlParamType;
}

export interface SqlWhereClause {
  /** Logical column name; resolved through the schema map. */
  column: string;
  op: SqlOp;
  /** Declared parameter name. Absent for `is_null` / `is_not_null`. */
  param?: string;
  /**
   * REQUIRED for `in`, forbidden otherwise: the registration-time arity bound,
   * 1..{@link MAX_IN_ARITY}. Bounding arity in the descriptor is what makes
   * `in` reviewable before any value exists — an unbounded list is how a
   * "read one patient" query quietly becomes a bulk export.
   */
  maxItems?: number;
}

export interface SqlOrderBy {
  column: string;
  direction: "asc" | "desc";
}

export interface SqlQuerySpec {
  /** Logical table or VIEW name; resolved through the schema map. */
  object: string;
  columns: string[];
  where: SqlWhereClause[];
  orderBy?: SqlOrderBy[];
  /** Mandatory row cap, {@link MIN_LIMIT}..{@link MAX_LIMIT}. */
  limit: number;
  params: SqlQueryParam[];
}

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 500;
export const MAX_COLUMNS = 64;
export const MAX_IN_ARITY = 32;

/** A descriptor that cannot be registered. Raised at validation time. */
export class QuerySpecError extends Error {
  readonly code = "QUERY_SPEC_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "QuerySpecError";
  }
}

/** A runtime argument that does not satisfy a valid descriptor's contract. */
export class QueryParamError extends Error {
  readonly code = "QUERY_PARAM_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "QueryParamError";
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Registration-time validation, modelled on `export-drop/profiles.ts`
 * `assertValidProfile`: everything that can be known without a schema map or a
 * runtime value is rejected here, with a message naming the offending piece.
 *
 * This runs when an operator saves a query, so the error is shown while they
 * are still looking at the form — not on the first read months later.
 */
export function assertValidQuerySpec(spec: SqlQuerySpec): void {
  if (typeof spec.object !== "string" || spec.object.trim() === "") {
    throw new QuerySpecError("query spec must name an object (table or view)");
  }

  /* --- columns --- */
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    throw new QuerySpecError(`query spec on "${spec.object}" selects no columns`);
  }
  if (spec.columns.length > MAX_COLUMNS) {
    throw new QuerySpecError(
      `query spec on "${spec.object}" selects ${spec.columns.length} columns ` +
        `(max ${MAX_COLUMNS})`,
    );
  }
  const seenColumns = new Set<string>();
  for (const column of spec.columns) {
    if (typeof column !== "string" || column.trim() === "") {
      throw new QuerySpecError(`query spec on "${spec.object}" has an empty column name`);
    }
    if (seenColumns.has(norm(column))) {
      throw new QuerySpecError(
        `query spec on "${spec.object}" selects column "${column}" twice`,
      );
    }
    seenColumns.add(norm(column));
  }

  /* --- row cap --- */
  if (!Number.isInteger(spec.limit)) {
    throw new QuerySpecError(
      `query spec on "${spec.object}" must declare an integer limit ` +
        `(${MIN_LIMIT}..${MAX_LIMIT}); got ${String(spec.limit)}`,
    );
  }
  if (spec.limit < MIN_LIMIT || spec.limit > MAX_LIMIT) {
    throw new QuerySpecError(
      `query spec on "${spec.object}" has limit ${spec.limit}, outside ` +
        `${MIN_LIMIT}..${MAX_LIMIT}`,
    );
  }

  /* --- declared params --- */
  if (!Array.isArray(spec.params)) {
    throw new QuerySpecError(`query spec on "${spec.object}" has a non-array params list`);
  }
  const declared = new Map<string, SqlQueryParam>();
  for (const p of spec.params) {
    if (!p || typeof p.name !== "string" || !PARAM_NAME_RE.test(p.name)) {
      throw new QuerySpecError(
        `query spec on "${spec.object}" has invalid param name "${String(p?.name)}" — ` +
          `expected lower-case alphanumeric with underscores`,
      );
    }
    if (declared.has(p.name)) {
      throw new QuerySpecError(
        `query spec on "${spec.object}" declares param "${p.name}" twice`,
      );
    }
    if (!(SQL_PARAM_TYPES as readonly string[]).includes(p.type)) {
      throw new QuerySpecError(
        `query spec on "${spec.object}" param "${p.name}" has unknown type "${String(p.type)}"`,
      );
    }
    declared.set(p.name, p);
  }

  /* --- predicates --- */
  if (!Array.isArray(spec.where)) {
    throw new QuerySpecError(`query spec on "${spec.object}" has a non-array where list`);
  }
  const usedParams = new Set<string>();
  for (const clause of spec.where) {
    if (!clause || typeof clause.column !== "string" || clause.column.trim() === "") {
      throw new QuerySpecError(`query spec on "${spec.object}" has a where clause with no column`);
    }
    if (!(SQL_OPS as readonly string[]).includes(clause.op)) {
      throw new QuerySpecError(
        `query spec on "${spec.object}" uses unknown operator "${String(clause.op)}" ` +
          `on column "${clause.column}"`,
      );
    }

    const nullary = (NULLARY_OPS as readonly string[]).includes(clause.op);
    if (nullary) {
      if (clause.param !== undefined) {
        throw new QuerySpecError(
          `query spec on "${spec.object}" declares param "${clause.param}" for ` +
            `"${clause.op}" on "${clause.column}", which binds no value`,
        );
      }
    } else {
      if (typeof clause.param !== "string" || clause.param === "") {
        throw new QuerySpecError(
          `query spec on "${spec.object}" op "${clause.op}" on "${clause.column}" ` +
            `names no parameter`,
        );
      }
      if (!declared.has(clause.param)) {
        throw new QuerySpecError(
          `query spec on "${spec.object}" references undeclared param "${clause.param}"`,
        );
      }
      usedParams.add(clause.param);
    }

    if (clause.op === "in") {
      if (!Number.isInteger(clause.maxItems)) {
        throw new QuerySpecError(
          `query spec on "${spec.object}" "in" on "${clause.column}" must declare an ` +
            `integer maxItems (1..${MAX_IN_ARITY})`,
        );
      }
      const maxItems = clause.maxItems as number;
      if (maxItems < 1 || maxItems > MAX_IN_ARITY) {
        throw new QuerySpecError(
          `query spec on "${spec.object}" "in" on "${clause.column}" declares ` +
            `maxItems ${maxItems}, outside 1..${MAX_IN_ARITY}`,
        );
      }
    } else if (clause.maxItems !== undefined) {
      throw new QuerySpecError(
        `query spec on "${spec.object}" sets maxItems on "${clause.op}" — ` +
          `only "in" bounds arity`,
      );
    }

    // A LIKE-prefix on a non-string param would compare against a coerced
    // value the operator never intended; reject it where it is authored.
    if (clause.op === "prefix") {
      const declaredParam = declared.get(clause.param as string);
      if (declaredParam && declaredParam.type !== "string") {
        throw new QuerySpecError(
          `query spec on "${spec.object}" prefix-matches "${clause.column}" against ` +
            `param "${clause.param}" of type "${declaredParam.type}" — must be string`,
        );
      }
    }
  }

  for (const name of declared.keys()) {
    if (!usedParams.has(name)) {
      throw new QuerySpecError(
        `query spec on "${spec.object}" declares param "${name}" but never uses it`,
      );
    }
  }

  /* --- ordering --- */
  if (spec.orderBy !== undefined) {
    if (!Array.isArray(spec.orderBy)) {
      throw new QuerySpecError(`query spec on "${spec.object}" has a non-array orderBy`);
    }
    for (const ob of spec.orderBy) {
      if (!ob || typeof ob.column !== "string" || ob.column.trim() === "") {
        throw new QuerySpecError(`query spec on "${spec.object}" has an orderBy with no column`);
      }
      if (ob.direction !== "asc" && ob.direction !== "desc") {
        throw new QuerySpecError(
          `query spec on "${spec.object}" orderBy "${ob.column}" has direction ` +
            `"${String(ob.direction)}" — expected "asc" or "desc"`,
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime value binding                                                      */
/* -------------------------------------------------------------------------- */

/** Coerce-free type check. A value that does not match its declared type is a
 *  hard stop, not a silent `String(v)`. */
function bindScalar(paramName: string, type: SqlParamType, value: unknown): unknown {
  switch (type) {
    case "string":
      if (typeof value !== "string") {
        throw new QueryParamError(`param "${paramName}" must be a string`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new QueryParamError(`param "${paramName}" must be a finite number`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new QueryParamError(`param "${paramName}" must be a boolean`);
      }
      return value;
    case "date":
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          throw new QueryParamError(`param "${paramName}" is an invalid Date`);
        }
        return value.toISOString();
      }
      if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
        return value;
      }
      throw new QueryParamError(`param "${paramName}" must be a Date or an ISO-8601 string`);
  }
}

function requireValue(
  params: Record<string, unknown>,
  name: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(params, name) || params[name] === undefined) {
    throw new QueryParamError(`missing value for param "${name}"`);
  }
  return params[name];
}

/* -------------------------------------------------------------------------- */
/* Compilation                                                                */
/* -------------------------------------------------------------------------- */

export interface CompileOptions {
  /** Defaults to `limit` (PostgreSQL / MySQL / MariaDB). Pass the engine
   *  profile's `limitStyle` for SQL Server and SQL Anywhere. */
  limitStyle?: LimitStyle;
}

/**
 * Compile a validated descriptor into a parameterized statement.
 *
 * Every value — including LIKE-prefix terms and IN lists — binds as `?`. The
 * only interpolated token is the range-checked integer row cap. Identifiers
 * resolve through the map and throw `SchemaResolutionError` when absent; an
 * unresolved identifier is never string-concatenated.
 */
export function compileQuerySpec(
  map: SchemaMap,
  spec: SqlQuerySpec,
  params: Record<string, unknown> = {},
  opts: CompileOptions = {},
): BuiltStatement {
  // Re-validated on the compile path too: a descriptor can reach here from
  // storage, and a row edited outside the registration path must not compile.
  assertValidQuerySpec(spec);

  const limitStyle = opts.limitStyle ?? "limit";
  const declaredTypes = new Map(spec.params.map((p) => [p.name, p.type]));

  const object = resolveTable(map, spec.object);
  const columns = spec.columns.map((c) => resolveColumn(map, spec.object, c));

  const predicates: string[] = [];
  const bound: unknown[] = [];

  for (const clause of spec.where) {
    const column = resolveColumn(map, spec.object, clause.column);
    // `clause.param` is present for every non-nullary op — assertValidQuerySpec
    // has already refused the alternative.
    const paramName = clause.param as string;
    const type = declaredTypes.get(paramName) as SqlParamType;

    switch (clause.op) {
      case "eq":
        predicates.push(`${column} = ?`);
        bound.push(bindScalar(paramName, type, requireValue(params, paramName)));
        break;
      case "neq":
        predicates.push(`${column} <> ?`);
        bound.push(bindScalar(paramName, type, requireValue(params, paramName)));
        break;
      case "lt":
        predicates.push(`${column} < ?`);
        bound.push(bindScalar(paramName, type, requireValue(params, paramName)));
        break;
      case "lte":
        predicates.push(`${column} <= ?`);
        bound.push(bindScalar(paramName, type, requireValue(params, paramName)));
        break;
      case "gt":
        predicates.push(`${column} > ?`);
        bound.push(bindScalar(paramName, type, requireValue(params, paramName)));
        break;
      case "gte":
        predicates.push(`${column} >= ?`);
        bound.push(bindScalar(paramName, type, requireValue(params, paramName)));
        break;
      case "prefix": {
        // Same idiom as the Eaglesoft `find_patient` query: metacharacters are
        // escaped so a "%" cannot turn a prefix search into a full scan, the
        // trailing wildcard is appended AFTER escaping, and the whole term
        // still binds as `?`.
        const raw = bindScalar(paramName, type, requireValue(params, paramName)) as string;
        predicates.push(`${column} LIKE ? ESCAPE '\\'`);
        bound.push(`${escapeLike(raw)}%`);
        break;
      }
      case "between": {
        const value = requireValue(params, paramName);
        if (!Array.isArray(value) || value.length !== 2) {
          throw new QueryParamError(
            `param "${paramName}" for "between" must be a two-element array`,
          );
        }
        predicates.push(`${column} BETWEEN ? AND ?`);
        bound.push(bindScalar(paramName, type, value[0]));
        bound.push(bindScalar(paramName, type, value[1]));
        break;
      }
      case "in": {
        const value = requireValue(params, paramName);
        if (!Array.isArray(value) || value.length === 0) {
          throw new QueryParamError(`param "${paramName}" for "in" must be a non-empty array`);
        }
        const maxItems = clause.maxItems as number;
        if (value.length > maxItems) {
          throw new QueryParamError(
            `param "${paramName}" for "in" has ${value.length} values, over the ` +
              `declared maxItems ${maxItems}`,
          );
        }
        // Exactly N placeholders — the list length is structural, never a value.
        predicates.push(`${column} IN (${value.map(() => "?").join(", ")})`);
        for (const item of value) bound.push(bindScalar(paramName, type, item));
        break;
      }
      case "is_null":
        predicates.push(`${column} IS NULL`);
        break;
      case "is_not_null":
        predicates.push(`${column} IS NOT NULL`);
        break;
    }
  }

  const orderBy = (spec.orderBy ?? []).map(
    (ob) => `${resolveColumn(map, spec.object, ob.column)} ${ob.direction === "desc" ? "DESC" : "ASC"}`,
  );

  // The cap is the one interpolated token. It has been Number.isInteger- and
  // range-checked by assertValidQuerySpec above; re-derive it from the checked
  // value rather than from anything the caller passed at compile time.
  const cap = spec.limit;

  const select = limitStyle === "top" ? `SELECT TOP ${cap} ` : "SELECT ";
  let sql = `${select}${columns.join(", ")} FROM ${object}`;
  if (predicates.length > 0) sql += ` WHERE ${predicates.join(" AND ")}`;
  if (orderBy.length > 0) sql += ` ORDER BY ${orderBy.join(", ")}`;
  if (limitStyle === "limit") sql += ` LIMIT ${cap}`;

  return { sql, params: bound };
}
