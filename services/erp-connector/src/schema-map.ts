/**
 * WARP-1094 — schema map + drift fingerprint (brief §9.2, §5 rules 3 & 9).
 *
 * Eaglesoft's exact tables/columns/keys vary by version, so the connector
 * introspects the live (or copy) database, builds this map, and fingerprints
 * it. Two responsibilities live here, both PURE (no I/O, no driver):
 *
 *   1. `computeSchemaFingerprint` — a stable hash over the tables we depend
 *      on. On every connect and before every write the fingerprint is
 *      recomputed and compared; a mismatch means Eaglesoft was upgraded, and
 *      the integration fails safe (freeze writes, degrade reads — invariant 9).
 *
 *   2. Identifier resolution — table/column names bind ONLY through this map
 *      (invariant 3). Values are always `?` parameters; identifiers are NEVER
 *      taken from user/LLM input. An unknown identifier throws rather than
 *      being string-concatenated into SQL.
 *
 * Identifiers are normalized to lower-case (SQL Anywhere identifiers are
 * case-insensitive) so an introspection pass that reports a different case
 * does not spuriously trip the drift lock.
 */
import { createHash } from "node:crypto";

/** A column as reported by introspection (brief §9.1). */
export interface IntrospectedColumn {
  name: string;
  /** Domain/type name, e.g. "integer", "varchar", "timestamp". */
  type: string;
}

/** A base table as reported by introspection (brief §9.1). */
export interface IntrospectedTable {
  name: string;
  /** Schema owner, typically "dba" (brief §3). */
  owner: string;
  columns: IntrospectedColumn[];
}

/** Thrown when an identifier cannot be resolved through the map. Never
 *  fall back to the raw string — an unresolved identifier is a hard stop. */
export class SchemaResolutionError extends Error {
  readonly code = "SCHEMA_RESOLUTION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "SchemaResolutionError";
  }
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Stable fingerprint over (owner + table names + column names + types).
 *
 * Order-independent: tables and columns are sorted before hashing so an
 * introspection pass that returns rows in a different order produces the
 * same hash. Content-sensitive: an added/removed/retyped column, or a
 * changed owner, changes the hash (that is exactly the drift signal). Hex
 * sha256 so it is stable across processes/architectures.
 */
export function computeSchemaFingerprint(tables: IntrospectedTable[]): string {
  const canonical = tables
    .map((t) => ({
      owner: norm(t.owner),
      name: norm(t.name),
      columns: t.columns
        .map((c) => ({ name: norm(c.name), type: norm(c.type) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Resolved, ready-to-bind physical identifiers for one table. */
interface MappedTable {
  owner: string;
  name: string;
  /** normalized column name → physical column name (both lower-cased). */
  columns: Map<string, string>;
}

/** The server-side identifier dictionary (invariant 3). */
export interface SchemaMap {
  tables: Map<string, MappedTable>;
}

/** Build the resolution map from an introspected schema. */
export function buildSchemaMap(tables: IntrospectedTable[]): SchemaMap {
  const map: SchemaMap = { tables: new Map() };
  for (const t of tables) {
    const columns = new Map<string, string>();
    for (const c of t.columns) {
      columns.set(norm(c.name), norm(c.name));
    }
    map.tables.set(norm(t.name), { owner: norm(t.owner), name: norm(t.name), columns });
  }
  return map;
}

/** Double-quote a SQL Anywhere identifier, escaping embedded quotes.
 *  Input is already validated against the map, so this is belt-and-suspenders. */
function quote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/** Resolve a logical table name to a quoted `"owner"."table"`. Throws on
 *  an unmapped table — never string-concatenate an unknown identifier. */
export function resolveTable(map: SchemaMap, table: string): string {
  const t = map.tables.get(norm(table));
  if (!t) {
    throw new SchemaResolutionError(`unknown table "${table}" — not in the schema map`);
  }
  return `${quote(t.owner)}.${quote(t.name)}`;
}

/** Resolve a logical column on a known table to a quoted `"column"`. Throws
 *  on an unmapped table or column (invariant 3). */
export function resolveColumn(map: SchemaMap, table: string, column: string): string {
  const t = map.tables.get(norm(table));
  if (!t) {
    throw new SchemaResolutionError(`unknown table "${table}" — not in the schema map`);
  }
  const physical = t.columns.get(norm(column));
  if (!physical) {
    throw new SchemaResolutionError(
      `unknown column "${column}" on table "${table}" — not in the schema map`,
    );
  }
  return quote(physical);
}
