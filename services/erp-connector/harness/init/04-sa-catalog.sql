-- =============================================================================
-- 04-sa-catalog.sql — SQL Anywhere catalog views over the mock schema
-- =============================================================================
--
-- WARP-2874. The bridge's `/introspect` route used to run whatever SELECT the
-- wire carried; it now accepts only the catalog statements
-- `erp-connector/src/introspection.ts` emits (SYS.SYSTAB / SYS.SYSTABCOL on
-- SA10+, SYSTABLE / SYSCOLUMN on ASA7). Before that, this harness had the
-- caller hand it Postgres `information_schema` SQL instead — which meant the
-- live lane proved the bridge could run *some* catalog query, never the one
-- that ships.
--
-- These views let the real statements run here, so introspection is exercised
-- end to end exactly as a practice runs it. They are a TEST FIXTURE: the mock
-- stands in for PattersonPM, and a stand-in that cannot answer the product's
-- own catalog queries is not standing in for much.
--
-- Only the `dba` schema is exposed, because that is what the mock owns and
-- what the connector's schema map is built from.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS sys;

-- `user_name` is the owner the connector records per table ("dba" here).
CREATE VIEW sys.sysuser AS
  SELECT n.oid::bigint AS user_id, n.nspname AS user_name
  FROM pg_namespace n;

-- `table_type = 1` is SQL Anywhere's base table; only base tables exist here.
--
-- Privilege-filtered on purpose: `information_schema` (what this lane used to
-- introspect with) shows only tables the CALLER may read, and the connector
-- builds its schema map from that. droplet_ro holds SELECT on the eight mapped
-- tables and nothing else, so the map stays what 03-provision.sql granted —
-- a table the read account cannot read is not part of its schema.
CREATE VIEW sys.systab AS
  SELECT c.oid::bigint AS table_id,
         c.relname AS table_name,
         c.relnamespace::bigint AS creator,
         1 AS table_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname = 'dba'
    AND has_table_privilege(c.oid, 'SELECT');

CREATE VIEW sys.sysdomain AS
  SELECT t.oid::bigint AS domain_id, t.typname AS domain_name
  FROM pg_type t;

-- `column_id` drives the ORDER BY, so it must be the declaration order.
CREATE VIEW sys.systabcol AS
  SELECT a.attrelid::bigint AS table_id,
         a.attname AS column_name,
         a.atttypid::bigint AS domain_id,
         a.attnum::int AS column_id,
         (NOT a.attnotnull) AS nulls,
         a.attlen::int AS width,
         0 AS scale
  FROM pg_attribute a
  JOIN sys.systab t ON t.table_id = a.attrelid::bigint
  WHERE a.attnum > 0 AND NOT a.attisdropped;

-- Read-only, like every other grant the mock hands these roles (03-provision).
-- Introspection always runs on the READ identity (main.py acquires "read"),
-- so only that account needs the catalog.
GRANT USAGE ON SCHEMA sys TO droplet_ro;
GRANT SELECT ON sys.sysuser, sys.systab, sys.sysdomain, sys.systabcol TO droplet_ro;
