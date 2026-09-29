-- ADR-055 (P4a) — append 'doors' to ModuleId.
--
-- Its OWN migration directory, stamped BEFORE the doors tables', because
-- PostgreSQL will not let a transaction use an enum value that the same
-- transaction added. Guarded on pg_enum so a re-run is a no-op — the idiom
-- from 20260923010000_warp_2977_module_security/migration.sql.
--
-- Named `doors`, never `access`: /api/access and ModuleId-adjacent `access`
-- names are ADR-032's RBAC. The module ships dark (DOORS_ENABLED, default
-- off); adding the value changes nothing on a box until that flag is on.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ModuleId' AND e.enumlabel = 'doors'
    ) THEN
        ALTER TYPE "ModuleId" ADD VALUE 'doors';
    END IF;
END $$;
