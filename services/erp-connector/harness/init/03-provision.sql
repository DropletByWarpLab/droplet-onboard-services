-- =============================================================================
-- WARP-1106 — Mock provisioning (Postgres flavor of sql/provision.sql)
-- =============================================================================
--
-- Mirrors the intent of services/erp-connector/sql/provision.sql (the real SQL
-- Anywhere script) so the least-privilege model is exercised in the dry setup:
--
--   droplet_ro  — SELECT-only on the mapped tables; the default, used for reads.
--   droplet_rw  — created UNUSABLE; granted ONLY the one v1 write capability
--                 (column-scoped UPDATE on appointment's four mutable columns).
--
-- Dev passwords only — this is a throwaway local mock, never a real box.

-- 1) Read-only service account -------------------------------------------------
CREATE ROLE droplet_ro LOGIN PASSWORD 'droplet_ro_dev_pw';
GRANT USAGE ON SCHEMA dba TO droplet_ro;
GRANT SELECT ON
  dba.patient, dba.appointment, dba.provider, dba.operatory,
  dba.service, dba.serv_trans, dba.recall, dba.account
TO droplet_ro;
-- NB: droplet_ro gets NO INSERT/UPDATE/DELETE anywhere (read-only belt).

-- 2) Write account — created unusable, then the ONE opt-in capability ----------
CREATE ROLE droplet_rw LOGIN PASSWORD 'droplet_rw_dev_pw';
GRANT USAGE ON SCHEMA dba TO droplet_rw;

-- reschedule_appointment: column-scoped UPDATE on the four mutable scheduling
-- columns ONLY (write-commands.ts allowedColumns). Never the PK or patient link.
GRANT UPDATE (appt_time, provider_id, operatory_id, status)
  ON dba.appointment TO droplet_rw;

-- The optimistic guard reads appt_id + last_modified in the UPDATE ... WHERE, so
-- the writer needs SELECT on exactly those two columns (and nothing else).
-- (SQL Anywhere has the same column-scoped-SELECT requirement.)
GRANT SELECT (appt_id, last_modified) ON dba.appointment TO droplet_rw;

-- droplet_rw deliberately has NO grant on account / serv_trans / clinical
-- tables — they are FORBIDDEN_WRITE_TABLES and stay read-only in v1.
