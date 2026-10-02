-- WARP-2977 P2b (ADR-059 §3.6) — the site mode's feed rows: append
-- 'site_mode' to SecurityEventSource and 'mode_changed' to SecurityEventKind.
--
-- Its OWN migration directory, stamped BEFORE the zones/hours/mode tables',
-- because PostgreSQL will not let a transaction use an enum value that the
-- same transaction added — and the next migration's
-- "SecurityEvent_site_mode_shape" CHECK compares against both values. Guarded
-- on pg_enum so a re-run is a no-op — the idiom from
-- 20260923010000_warp_2977_module_security/migration.sql. Nothing else goes
-- in this folder.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityEventSource' AND e.enumlabel = 'site_mode'
    ) THEN
        ALTER TYPE "SecurityEventSource" ADD VALUE 'site_mode';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityEventKind' AND e.enumlabel = 'mode_changed'
    ) THEN
        ALTER TYPE "SecurityEventKind" ADD VALUE 'mode_changed';
    END IF;
END $$;
