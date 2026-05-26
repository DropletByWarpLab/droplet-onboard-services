-- WARP-484: migration journal fix for the WARP-456 folder rename.
--
-- Background: WARP-456 (`ActivityRow`) and WARP-171 (`Role` enum) both
-- shipped on `main` with the same folder timestamp `20260525000000_*`.
-- That's a Prisma-sort collision — folder-name tiebreaks aren't
-- guaranteed deterministic across filesystem locales and ICU collations.
-- The rename ships in the preceding commit on the same branch:
-- `chore(orchestrator): WARP-484 — rename migration to break timestamp
-- collision with WARP-171`.
--
-- Devices already provisioned before this fix have a row in
-- `_prisma_migrations` keyed by the OLD folder name:
--   migration_name = '20260525000000_warp_456_activity_row'
-- When such a device pulls the new code and `prisma migrate deploy`
-- scans the migrations folder, it sees the renamed
-- `20260525000100_warp_456_activity_row/` and concludes "this
-- migration has never been applied" — even though the SQL ran fine
-- under the old name. Prisma then re-runs the WARP-456 SQL, which is
-- idempotent (every CREATE wrapped in IF NOT EXISTS / DO/EXCEPTION),
-- and inserts a new journal row for the new name. The DB now has two
-- rows for what is logically a single migration.
--
-- This migration (`20260525145000_*`) is ordered AFTER the renamed
-- folder (`20260525000100_*`), so by the time we run, the new-name
-- row is already in `_prisma_migrations`. We collapse the old-name
-- row into the new one without re-running any SQL.
--
-- Idempotency contracts:
--   1. Fresh install with the post-rename code: only the new-name row
--      exists; UPDATE matches zero rows, DELETE matches zero rows.
--      Pure no-op.
--   2. Device provisioned before the rename, this migration is the
--      first to fix the journal: only the old-name row exists.
--      UPDATE renames the row in place.
--   3. Device provisioned before the rename, Prisma re-ran the
--      renamed SQL just now: both old- and new-name rows exist.
--      DELETE drops the stale old-name row; the new-name row is the
--      canonical entry.
--   4. Hand-run via `psql` outside the Prisma CLI on a DB without
--      `_prisma_migrations` (defensive — Prisma's own bootstrap
--      creates the table before any user migration runs, so this
--      branch is unreachable in normal operation): `EXCEPTION WHEN
--      undefined_table` swallows the missing-table error.
--
-- All paths are no-op-on-second-run. The underlying ActivityRow table
-- is one consistent table either way (the WARP-456 SQL is
-- `CREATE IF NOT EXISTS` end-to-end).

DO $$
DECLARE
    new_name_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM   "_prisma_migrations"
        WHERE  migration_name = '20260525000100_warp_456_activity_row'
    ) INTO new_name_exists;

    IF new_name_exists THEN
        -- Case 3 (or no-op case 1): new-name row already exists. Drop
        -- any stale old-name row to converge to a single journal entry.
        DELETE FROM "_prisma_migrations"
        WHERE  migration_name = '20260525000000_warp_456_activity_row';
    ELSE
        -- Case 2: only the old-name row exists (or neither does).
        -- UPDATE renames the journal entry without re-running the
        -- WARP-456 SQL. Zero rows matched ⇒ no-op.
        UPDATE "_prisma_migrations"
        SET    migration_name = '20260525000100_warp_456_activity_row'
        WHERE  migration_name = '20260525000000_warp_456_activity_row';
    END IF;
EXCEPTION
    WHEN undefined_table THEN
        -- Case 4: `_prisma_migrations` does not exist. Safe no-op.
        NULL;
END $$;
