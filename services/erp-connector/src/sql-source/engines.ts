/**
 * WARP-2011 — per-engine profiles for the generic SQL-source track.
 *
 * The Eaglesoft track knows exactly one engine (SQL Anywhere) and can hardcode
 * its catalog views, its quoting and its LIMIT syntax. The generic track cannot:
 * an operator points it at whatever database already runs on their LAN. This
 * module is the ONE place those per-engine differences are written down, as an
 * explicit table rather than as conditionals scattered through the compiler.
 *
 * Two rules the table encodes that are easy to get wrong:
 *
 *   1. **Quoting is not universal.** MySQL/MariaDB in the default `sql_mode`
 *      read `"x"` as a string LITERAL. SQL Server accepts `[x]`. Only ANSI
 *      engines take `"x"` as an identifier.
 *   2. **Case is not universal.** PostgreSQL, MySQL/MariaDB on Linux, and SQL
 *      Server under a case-sensitive collation all treat a quoted mixed-case
 *      identifier as distinct from its lower-cased form, so the physical name
 *      introspection reported must be preserved verbatim. SQL Anywhere is
 *      case-insensitive and keeps the historical `fold-lower`.
 *
 * The catalog queries deliberately do NOT filter on table type, so VIEWS are
 * enumerated alongside base tables. That is the answer to "I need a join": the
 * operator creates a VIEW in their own database and grants SELECT on it, and
 * the compiler stays join-free.
 *
 * This module is PURE — string constants and a lookup table, no I/O.
 */
import { catalogQueriesFor, type CatalogQuerySet } from "../introspection.js";
import { PRODUCT_VERSION_SQL } from "../version-detect.js";
import type { IdentifierCase, QuoteStyle } from "../schema-map.js";

/** The engines the generic SQL-source track can be pointed at. */
export type SqlEngine = "postgres" | "mysql" | "mariadb" | "sqlserver" | "sqlanywhere";

/** All members, for exhaustive iteration in tests and validation. */
export const SQL_ENGINES: readonly SqlEngine[] = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
  "sqlanywhere",
] as const;

/**
 * How a row cap is expressed. `limit` is the trailing `LIMIT n`; `top` is the
 * leading `SELECT TOP n`. Engines in the `top` family do not reliably accept a
 * bound parameter there, which is why the cap is the one integer the compiler
 * interpolates — and why it is range-checked rather than taken as caller text.
 */
export type LimitStyle = "limit" | "top";

/** Everything the compiler and the connector need to know about an engine. */
export interface EngineProfile {
  engine: SqlEngine;
  /** Table/column introspection pair. Contract: return `table_name` + `owner`
   *  and `column_name` + `type`, binding the table name as `?`. */
  catalog: CatalogQuerySet;
  /** A cheap read that proves the connection works and identifies the server. */
  versionSql: string;
  quoteStyle: QuoteStyle;
  identifierCase: IdentifierCase;
  defaultPort: number;
  limitStyle: LimitStyle;
  /** Owner attributed when the catalog reports none. `""` means the engine has
   *  no owner distinct from the database, so names are emitted unqualified. */
  defaultOwner: string;
}

/* -------------------------------------------------------------------------- */
/* Catalog SQL                                                                */
/* -------------------------------------------------------------------------- */

/**
 * PostgreSQL. `information_schema` reports the identifier as STORED, so a
 * column created `"FirstName"` comes back `FirstName` and must be quoted back
 * verbatim. The two system schemas are excluded; everything else the bind user
 * can see — including views — is enumerated.
 */
export const PG_LIST_TABLES_SQL = `SELECT table_name, table_schema AS owner
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`;

export const PG_LIST_COLUMNS_SQL = `SELECT column_name, data_type AS type
FROM information_schema.columns
WHERE table_name = ?
ORDER BY ordinal_position`;

/**
 * MySQL / MariaDB. Scoped to `DATABASE()` — the session's database — because
 * `information_schema` otherwise spans every schema on the server. No double
 * quotes appear anywhere in these statements: in the default `sql_mode` they
 * would be string literals.
 */
export const MYSQL_LIST_TABLES_SQL = `SELECT table_name, table_schema AS owner
FROM information_schema.tables
WHERE table_schema = DATABASE()`;

export const MYSQL_LIST_COLUMNS_SQL = `SELECT column_name, data_type AS type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ?
ORDER BY ordinal_position`;

/**
 * SQL Server. `INFORMATION_SCHEMA` columns are upper-case, so they are aliased
 * down to the contract's lower-case names rather than relying on the caller's
 * case-insensitive row reader.
 */
export const MSSQL_LIST_TABLES_SQL = `SELECT TABLE_NAME AS table_name, TABLE_SCHEMA AS owner
FROM INFORMATION_SCHEMA.TABLES`;

export const MSSQL_LIST_COLUMNS_SQL = `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS type
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = ?
ORDER BY ORDINAL_POSITION`;

/* -------------------------------------------------------------------------- */
/* The profile table                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The single source of truth for per-engine behaviour.
 *
 * `sqlanywhere` reuses `catalogQueriesFor("modern")` unchanged and keeps
 * `ansi` / `fold-lower`, so routing an Eaglesoft connection through this table
 * produces byte-identical SQL to the pre-WARP-2011 path.
 */
export const ENGINE_PROFILES: Readonly<Record<SqlEngine, EngineProfile>> = Object.freeze({
  postgres: {
    engine: "postgres",
    catalog: { listTables: PG_LIST_TABLES_SQL, listColumns: PG_LIST_COLUMNS_SQL },
    versionSql: "SELECT version()",
    quoteStyle: "ansi",
    identifierCase: "preserve",
    defaultPort: 5432,
    limitStyle: "limit",
    defaultOwner: "public",
  },
  mysql: {
    engine: "mysql",
    catalog: { listTables: MYSQL_LIST_TABLES_SQL, listColumns: MYSQL_LIST_COLUMNS_SQL },
    versionSql: "SELECT VERSION()",
    quoteStyle: "backtick",
    identifierCase: "preserve",
    defaultPort: 3306,
    limitStyle: "limit",
    defaultOwner: "",
  },
  mariadb: {
    engine: "mariadb",
    catalog: { listTables: MYSQL_LIST_TABLES_SQL, listColumns: MYSQL_LIST_COLUMNS_SQL },
    versionSql: "SELECT VERSION()",
    quoteStyle: "backtick",
    identifierCase: "preserve",
    defaultPort: 3306,
    limitStyle: "limit",
    defaultOwner: "",
  },
  sqlserver: {
    engine: "sqlserver",
    catalog: { listTables: MSSQL_LIST_TABLES_SQL, listColumns: MSSQL_LIST_COLUMNS_SQL },
    versionSql: "SELECT @@VERSION",
    quoteStyle: "bracket",
    identifierCase: "preserve",
    defaultPort: 1433,
    limitStyle: "top",
    defaultOwner: "dbo",
  },
  sqlanywhere: {
    engine: "sqlanywhere",
    catalog: catalogQueriesFor("modern"),
    versionSql: PRODUCT_VERSION_SQL,
    quoteStyle: "ansi",
    identifierCase: "fold-lower",
    defaultPort: 2638,
    limitStyle: "top",
    defaultOwner: "dba",
  },
});

/** Narrow an operator-supplied string to a known engine. */
export function isSqlEngine(value: string): value is SqlEngine {
  return (SQL_ENGINES as readonly string[]).includes(value);
}

/** Look up a profile, throwing on an unknown engine rather than defaulting —
 *  a silent fallback would emit the wrong quoting for the wrong server. */
export function engineProfile(engine: SqlEngine): EngineProfile {
  const profile = ENGINE_PROFILES[engine];
  if (!profile) {
    throw new RangeError(`unknown SQL engine "${engine}" — no profile registered`);
  }
  return profile;
}
