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
 * Identifiers are LOOKED UP case-insensitively (SQL Anywhere identifiers are
 * case-insensitive) so an introspection pass that reports a different case
 * does not spuriously trip the drift lock. What is EMITTED is a separate
 * question, governed by `identifierCase` (WARP-2011): the lookup key is always
 * normalized, but the physical identifier written to the wire is preserved
 * verbatim when the engine is case-SENSITIVE. On PostgreSQL, on SQL Server
 * with a case-sensitive collation, and on MySQL/MariaDB on Linux, a column
 * created quoted-and-mixed-case (`"FirstName"`) does not answer to
 * `"firstname"` — folding the physical name there emits an identifier that
 * does not exist. The default stays `fold-lower`, so SQL Anywhere behaviour
 * and every existing caller are byte-identical.
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
 * How an engine delimits identifiers (WARP-2011). ANSI double quotes are NOT
 * universal: on MySQL/MariaDB in the default `sql_mode`, `"x"` is a string
 * LITERAL, not an identifier, so a map built for MySQL must emit backticks.
 */
export type QuoteStyle = "ansi" | "backtick" | "bracket";

/**
 * Whether the PHYSICAL identifier keeps the case introspection reported
 * (`preserve`, required by every case-sensitive engine) or is folded to
 * lower-case (`fold-lower`, the SQL Anywhere default). Lookup is always
 * case-insensitive regardless — this governs only what reaches the wire.
 */
export type IdentifierCase = "fold-lower" | "preserve";

/** Per-engine emission traits. Both default to the SQL Anywhere behaviour. */
export interface SchemaMapOptions {
  quoteStyle?: QuoteStyle;
  identifierCase?: IdentifierCase;
}

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
  /** Physical owner/schema identifier, exactly as it must reach the wire. */
  owner: string;
  /** Physical table identifier, exactly as it must reach the wire. */
  name: string;
  /** normalized column name → PHYSICAL column identifier. The key is the
   *  case-insensitive lookup handle; the value is what gets quoted. */
  columns: Map<string, string>;
}

/** The server-side identifier dictionary (invariant 3). */
export interface SchemaMap {
  tables: Map<string, MappedTable>;
  /** How {@link resolveTable}/{@link resolveColumn} delimit what they emit. */
  quoteStyle: QuoteStyle;
  /** Whether the stored physical identifiers kept their introspected case. */
  identifierCase: IdentifierCase;
}

/**
 * Build the resolution map from an introspected schema.
 *
 * `opts` defaults to `{ quoteStyle: "ansi", identifierCase: "fold-lower" }` —
 * exactly the pre-WARP-2011 behaviour — so every existing caller and every
 * existing test is byte-identical without change.
 */
export function buildSchemaMap(
  tables: IntrospectedTable[],
  opts: SchemaMapOptions = {},
): SchemaMap {
  const quoteStyle = opts.quoteStyle ?? "ansi";
  const identifierCase = opts.identifierCase ?? "fold-lower";
  // The ONLY difference between the two modes: what we store as physical.
  const physical = identifierCase === "preserve" ? (s: string) => s.trim() : norm;

  const map: SchemaMap = { tables: new Map(), quoteStyle, identifierCase };
  for (const t of tables) {
    const columns = new Map<string, string>();
    for (const c of t.columns) {
      columns.set(norm(c.name), physical(c.name));
    }
    map.tables.set(norm(t.name), {
      owner: physical(t.owner),
      name: physical(t.name),
      columns,
    });
  }
  return map;
}

/**
 * Delimit an identifier for the target engine, escaping the delimiter by
 * DOUBLING it — never by stripping, which would silently change which object
 * the statement names. Input is already validated against the map, so this is
 * belt-and-suspenders.
 *
 * The switch is exhaustive with no `default:` arm: adding a `QuoteStyle`
 * member is a compile error here rather than a silent fall-through to ANSI.
 */
function quote(ident: string, style: QuoteStyle): string {
  switch (style) {
    case "ansi":
      return `"${ident.replace(/"/g, '""')}"`;
    case "backtick":
      return `\`${ident.replace(/`/g, "``")}\``;
    case "bracket":
      return `[${ident.replace(/]/g, "]]")}]`;
  }
}

/** Resolve a logical table name to a quoted `"owner"."table"`. Throws on
 *  an unmapped table — never string-concatenate an unknown identifier. */
export function resolveTable(map: SchemaMap, table: string): string {
  const t = map.tables.get(norm(table));
  if (!t) {
    throw new SchemaResolutionError(`unknown table "${table}" — not in the schema map`);
  }
  // MySQL/MariaDB have no owner distinct from the database, so a catalog that
  // reports none yields "". Emitting `""."tbl"` would name an object that
  // cannot exist; an unqualified name is the correct rendering.
  if (t.owner === "") return quote(t.name, map.quoteStyle);
  return `${quote(t.owner, map.quoteStyle)}.${quote(t.name, map.quoteStyle)}`;
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
  return quote(physical, map.quoteStyle);
}
