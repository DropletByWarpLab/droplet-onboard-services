/**
 * WARP-1094 — schema introspection SQL constants (brief §9.1).
 *
 * SQL Anywhere catalog queries used to discover Eaglesoft's actual schema at
 * connect time. Never trust a hardcoded schema (brief §9): the connector runs
 * these against the live (or copy) database, builds the schema map, and
 * fingerprints it. These are read-only SELECTs against SYS.* catalog views.
 *
 * The queries are string CONSTANTS only — this module performs no I/O. The
 * driver that executes them is stubbed until the SAP SQL Anywhere client and a
 * copy of PattersonPM.db are available (see connector.ts).
 *
 * Column-list introspection binds the table name as a `?` parameter
 * (invariant 3) — the caller passes it positionally; it is never
 * concatenated into the SQL.
 */

/** List base tables and their owners (brief §9.1). `table_type = 1` = base
 *  tables (excludes views/materialized views). */
export const LIST_TABLES_SQL = `SELECT t.table_name, u.user_name AS owner
FROM SYS.SYSTAB t
JOIN SYS.SYSUSER u ON t.creator = u.user_id
WHERE t.table_type = 1`;

/** List columns for one table (brief §9.1). Bind the table name as `?`. */
export const LIST_COLUMNS_SQL = `SELECT c.column_name, d.domain_name AS type, c.nulls, c.width, c.scale
FROM SYS.SYSTABCOL c
JOIN SYS.SYSTAB t ON c.table_id = t.table_id
JOIN SYS.SYSDOMAIN d ON c.domain_id = d.domain_id
WHERE t.table_name = ?
ORDER BY c.column_id`;

/** Primary-key / index columns for one table (brief §9.1). Bind table name. */
export const LIST_INDEXES_SQL = `SELECT i.index_name, i.index_category, ic.column_id, ic."order"
FROM SYS.SYSIDX i
JOIN SYS.SYSTAB t ON i.table_id = t.table_id
JOIN SYS.SYSIDXCOL ic ON ic.table_id = i.table_id AND ic.index_id = i.index_id
WHERE t.table_name = ?
ORDER BY i.index_id, ic.sequence`;

/** Legacy compatibility fallbacks for SQL Anywhere 7, where SYS.SYSTAB* may
 *  be absent (brief §9.1). Feature-detect at connect time and fall back to
 *  these SYSTABLE / SYSCOLUMN compat views. */
export const LEGACY_LIST_TABLES_SQL = `SELECT table_name, creator AS owner
FROM SYSTABLE
WHERE table_type = 'BASE'`;

export const LEGACY_LIST_COLUMNS_SQL = `SELECT column_name, domain_name AS type
FROM SYSCOLUMN c
JOIN SYSTABLE t ON c.table_id = t.table_id
WHERE t.table_name = ?
ORDER BY c.column_id`;
