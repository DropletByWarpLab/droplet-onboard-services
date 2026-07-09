-- =============================================================================
-- WARP-1106 — Dry-setup smoke test
-- =============================================================================
-- Runs the erp-connector's ACTUAL built SQL (quoted-identifier style, from
-- read-queries.ts / write-commands.ts) against the mock, and proves the
-- least-privilege model. Run as the postgres superuser; each section SET ROLEs
-- into the provisioned account so real permission checks apply.
--
--   cat smoke.sql | docker compose -f docker-compose.yml exec -T mock-eaglesoft \
--     psql -U postgres -d pattersonpm
-- =============================================================================

\echo '== 1. droplet_ro :: get_schedule_today (today [from,to) window) =='
SET ROLE droplet_ro;
SELECT "appt_id", "appt_time", "provider_id", "operatory_id", "status", "patient_id"
FROM "dba"."appointment"
WHERE "appt_time" >= date_trunc('day', now())
  AND "appt_time" <  date_trunc('day', now()) + interval '1 day'
ORDER BY "appt_time";

\echo '== 2. droplet_ro :: find_patient (last-name prefix "Lis") =='
SELECT "patient_id", "first_name", "last_name"
FROM "dba"."patient"
WHERE "last_name" LIKE 'Lis%' ESCAPE '\'
ORDER BY "last_name", "first_name";

\echo '== 2b. find_patient PHI-overfetch defense :: a "%" search is escaped, matches 0 =='
SELECT count(*) AS rows_returned_for_wildcard_search
FROM "dba"."patient"
WHERE "last_name" LIKE '\%%' ESCAPE '\';   -- escapeLike('%') + prefix '%'  => literal '%' prefix

\echo '== 3. droplet_ro :: get_ar_summary (aggregate in SQL) =='
SELECT COUNT("account_id") AS account_count, SUM("balance") AS total_balance
FROM "dba"."account";

\echo '== 4. droplet_ro is READ-ONLY :: this UPDATE MUST fail with permission denied =='
UPDATE "dba"."appointment" SET "status" = 'cancelled' WHERE "appt_id" = 5001;
RESET ROLE;

-- The real reschedule_appointment binds a NEW appt_time as a literal param
-- (SET "appt_time" = ?), so it never READS appt_time — hence droplet_rw needs
-- SELECT only on the guard columns (appt_id, last_modified), not appt_time.
-- We use a computed literal here (11:30 today) to match that exactly.
\echo '== 5. droplet_rw :: reschedule_appointment, optimistic guard MISS -> 0 rows =='
SET ROLE droplet_rw;
UPDATE "dba"."appointment"
SET "appt_time" = date_trunc('day', now()) + interval '11 hours 30 minutes', "status" = 'confirmed'
WHERE "appt_id" = 5002 AND "last_modified" = TIMESTAMP '1999-01-01 00:00:00';

\echo '== 6. droplet_rw :: reschedule_appointment, optimistic guard HIT -> 1 row =='
-- (In the real flow the orchestrator reads last_modified via droplet_ro and
--  binds it as a param; here a subselect supplies the current value.)
UPDATE "dba"."appointment"
SET "appt_time" = date_trunc('day', now()) + interval '11 hours 30 minutes', "status" = 'confirmed'
WHERE "appt_id" = 5002
  AND "last_modified" = (SELECT "last_modified" FROM "dba"."appointment" WHERE "appt_id" = 5002);
RESET ROLE;

\echo '== 7. verify the reschedule landed AND the watermark advanced (trigger fired) =='
SELECT "appt_id", "appt_time", "status", "last_modified"
FROM "dba"."appointment" WHERE "appt_id" = 5002;

\echo '== 8. droplet_rw canNOT touch a forbidden table :: this UPDATE MUST fail =='
SET ROLE droplet_rw;
UPDATE "dba"."account" SET "balance" = 0 WHERE "account_id" = 7002;
RESET ROLE;

\echo '== smoke test complete =='
