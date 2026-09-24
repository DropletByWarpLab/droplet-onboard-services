-- WARP-2977 P2b-2 (ADR-059 §3.2, §3.4) — the Matter lock adapter's enum
-- values: 'matter_lock' on SecurityEventSource, 'lock_state' on
-- SecurityEventKind and 'lock' on SecurityZoneSourceKind.
--
-- Its OWN migration directory, stamped BEFORE the lock rows' migration,
-- because PostgreSQL will not let a transaction use an enum value that the
-- same transaction added — and the next migration's "SecurityEvent_lock_shape"
-- and re-added "SecurityZoneLink_ref" CHECKs compare against all three.
-- Guarded on pg_enum so a re-run is a no-op — the idiom from
-- 20260923010000_warp_2977_module_security and
-- 20260924000000_warp_2977_security_mode_event_values. Nothing else goes in
-- this folder.
--
-- Re-stamped from 20260925000000 with its rows migration (see
-- 20260925050100_warp_2977_security_lock_rows for why); the pg_enum guards
-- are what make the re-run on a box that applied the old stamp a no-op.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityEventSource' AND e.enumlabel = 'matter_lock'
    ) THEN
        ALTER TYPE "SecurityEventSource" ADD VALUE 'matter_lock';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityEventKind' AND e.enumlabel = 'lock_state'
    ) THEN
        ALTER TYPE "SecurityEventKind" ADD VALUE 'lock_state';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityZoneSourceKind' AND e.enumlabel = 'lock'
    ) THEN
        ALTER TYPE "SecurityZoneSourceKind" ADD VALUE 'lock';
    END IF;
END $$;
