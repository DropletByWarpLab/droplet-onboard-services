-- WARP-2581 — append 'money' to ModuleId.
--
-- Its OWN migration directory, and stamped BEFORE the ErpDocument table's,
-- because PostgreSQL will not let a transaction use an enum value that the
-- same transaction added. Guarded on pg_enum so a re-run is a no-op — the
-- idiom from 20260829000000_warp_2117_module_ids/migration.sql.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ModuleId' AND e.enumlabel = 'money'
    ) THEN
        ALTER TYPE "ModuleId" ADD VALUE 'money';
    END IF;
END $$;
