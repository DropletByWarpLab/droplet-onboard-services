-- WARP-2977 fix — do the lock-baseline backfill that
-- 20261001100000_warp_2977_security_lock_baseline cannot.
--
-- That migration adds SecurityEvent."baseline" and backfills it with an
-- UPDATE. But SecurityEvent is append-only (ADR-059 §3.3): the row-level
-- BEFORE UPDATE trigger "SecurityEvent_append_only" (20260925030000) refuses
-- every UPDATE. On any box that holds a lock baseline row (a matter_lock row
-- whose dedupeKey carries ':after:none:'), that UPDATE raised, the migration
-- failed, and the orchestrator could not boot (test box, 2026-10-02).
--
-- This migration sorts first. It adds the column (IF NOT EXISTS), and runs the
-- same one-time backfill with the guard switched off for exactly that
-- statement. All of it is one transaction, so a failure leaves the trigger
-- enabled. 20261001100000 then finds no row still false: its UPDATE matches
-- zero rows, and a FOR EACH ROW trigger does not fire on zero rows, so it
-- applies cleanly on every box. No applied migration is edited.
--
-- Boxes that already applied 20261001100000 (no baseline row at the time) run
-- this on their next deploy as a no-op: the column exists and nothing matches.
BEGIN;

ALTER TABLE "SecurityEvent" ADD COLUMN IF NOT EXISTS "baseline" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SecurityEvent" DISABLE TRIGGER "SecurityEvent_append_only";

UPDATE "SecurityEvent"
SET "baseline" = true
WHERE "source" = 'matter_lock'
  AND "baseline" = false
  AND "dedupeKey" LIKE '%:after:none:%';

ALTER TABLE "SecurityEvent" ENABLE TRIGGER "SecurityEvent_append_only";

COMMIT;
