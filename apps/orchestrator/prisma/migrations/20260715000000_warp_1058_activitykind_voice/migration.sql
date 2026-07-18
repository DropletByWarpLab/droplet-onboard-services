-- WARP-1058: ActivityKind gains `voice` so voice events (wake
-- detections, missed wakes, DSP wedge/recovery, calibration applied,
-- processor restarts) land in the signed activity chain as their own
-- filterable kind — the /voice page's "Recent voice activity" feed and
-- the audit log's kind=voice filter both ride it.
--
-- This migration only EXTENDS the enum. The value is appended (Postgres
-- orders members by physical declaration and `ALTER TYPE … ADD VALUE`
-- only appends cheaply); nothing reads the enum's declaration order.
-- Idempotent: guarded by a pg_enum catalog check, because
-- `ALTER TYPE … ADD VALUE` has no transaction-safe `IF NOT EXISTS` on
-- every supported PG and re-adding an existing value errors — same
-- pattern as 20260712000000_warp_1257_intent_failure_states.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ActivityKind' AND e.enumlabel = 'voice'
    ) THEN
        ALTER TYPE "ActivityKind" ADD VALUE 'voice';
    END IF;
END $$;
