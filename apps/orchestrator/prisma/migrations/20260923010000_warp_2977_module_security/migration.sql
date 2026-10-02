-- WARP-2977 (ADR-059 P2) — append 'security' to ModuleId.
--
-- Its OWN migration directory, stamped BEFORE the SecurityEvent tables',
-- because PostgreSQL will not let a transaction use an enum value that the
-- same transaction added. Guarded on pg_enum so a re-run is a no-op — the
-- idiom from 20260901045000_warp_2581_module_money/migration.sql.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ModuleId' AND e.enumlabel = 'security'
    ) THEN
        ALTER TYPE "ModuleId" ADD VALUE 'security';
    END IF;
END $$;
