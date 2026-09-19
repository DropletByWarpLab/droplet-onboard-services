-- WARP-2018 / WARP-2117 — append 'contacts' and 'crm' to ModuleId.
--
-- Its OWN migration directory, ahead of the tables, because PostgreSQL will
-- not let a transaction use an enum value that the same transaction added.
-- Guarded on pg_enum so a re-run is a no-op (the idiom from
-- 20260803000000_warp_1683_team_chat/migration.sql:44-53).

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ModuleId' AND e.enumlabel = 'contacts'
    ) THEN
        ALTER TYPE "ModuleId" ADD VALUE 'contacts';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ModuleId' AND e.enumlabel = 'crm'
    ) THEN
        ALTER TYPE "ModuleId" ADD VALUE 'crm';
    END IF;
END $$;
