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
import type { CatalogDialect } from "./version-detect.js";

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

/**
 * Triggers on base tables (write-safety, review B-5). A raw INSERT/UPDATE does
 * NOT reproduce Eaglesoft's app-tier logic, but it DOES fire any DB triggers on
 * the target — so a writable table carrying triggers must not be written blind;
 * the write-enable gate (PR-3) refuses it. Modern catalog only (v10+); we do
 * not write to ASA7 legacy installs.
 */
export const LIST_TRIGGERS_SQL = `SELECT tr.trigger_name, t.table_name, tr.event, tr.trigger_time
FROM SYS.SYSTRIGGER tr
JOIN SYS.SYSTAB t ON tr.table_id = t.table_id
WHERE tr.table_id IS NOT NULL`;

/**
 * Foreign-key relationships (write-safety, review B-5). Before allow-listing a
 * write we must know the target table's FK obligations. Modern catalog only.
 */
export const LIST_FOREIGN_KEYS_SQL = `SELECT ft.table_name AS foreign_table, pt.table_name AS primary_table
FROM SYS.SYSFKEY fk
JOIN SYS.SYSTAB ft ON fk.foreign_table_id = ft.table_id
JOIN SYS.SYSTAB pt ON fk.primary_table_id = pt.table_id`;

/**
 * Candidate change-tracking watermark columns (research §3). SQL Anywhere has
 * NO implicit rowversion — a usable watermark exists only where a table
 * explicitly declares DEFAULT TIMESTAMP. This scan finds them; if a target
 * entity has none, the sync/optimistic-guard falls back to the OnSchedule
 * audit trail or a bounded poll+diff — never a silent no-guard downgrade
 * (review B-4). Modern catalog only.
 */
export const FIND_WATERMARK_COLUMNS_SQL = `SELECT t.table_name, c.column_name, c."default" AS column_default
FROM SYS.SYSTABCOL c
JOIN SYS.SYSTAB t ON c.table_id = t.table_id
WHERE c."default" LIKE '%TIMESTAMP%'`;

/** The table+column introspection pair for a given catalog dialect. */
export interface CatalogQuerySet {
  listTables: string;
  listColumns: string;
}

/**
 * Pick the correct catalog-view family for the detected engine (review C-5).
 * Choose the dialect with parseEngineVersion() at connect time — never assume
 * the family, because introspecting ASA7 with SYS.SYSTAB* (or vice-versa) fails
 * on exactly the installs where it matters.
 */
export function catalogQueriesFor(dialect: CatalogDialect): CatalogQuerySet {
  return dialect === "legacy"
    ? { listTables: LEGACY_LIST_TABLES_SQL, listColumns: LEGACY_LIST_COLUMNS_SQL }
    : { listTables: LIST_TABLES_SQL, listColumns: LIST_COLUMNS_SQL };
}
