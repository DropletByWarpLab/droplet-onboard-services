-- WARP-2582 (ADR-045 slice E) - append the four business kinds to
-- "ContextPinKind": 'customer', 'deal', 'project', 'work_item'.
--
-- ITS OWN MIGRATION DIRECTORY, ahead of anything that USES the values.
-- PostgreSQL will not let a transaction read an enum value the same
-- transaction added, so the unique index this slice also needs lives in
-- 20260901001000_warp_2582_context_pin_unique instead of here. That is the
-- idiom 20260829000000_warp_2117_module_ids used for exactly this reason.
--
-- Guarded on pg_enum so a replay is a no-op: `ALTER TYPE ... ADD VALUE` has
-- no transaction-safe IF NOT EXISTS, and these migrations are hand-written
-- and get replayed onto boxes bootstrapped out of order.
--
-- Members are APPENDED, never reordered. Prisma orders enum members by
-- physical declaration; nothing reads ContextPinKind ordinally, so there is
-- no value here that needs to sort before another and no BEFORE clause.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ContextPinKind' AND e.enumlabel = 'customer'
    ) THEN
        ALTER TYPE "ContextPinKind" ADD VALUE 'customer';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ContextPinKind' AND e.enumlabel = 'deal'
    ) THEN
        ALTER TYPE "ContextPinKind" ADD VALUE 'deal';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ContextPinKind' AND e.enumlabel = 'project'
    ) THEN
        ALTER TYPE "ContextPinKind" ADD VALUE 'project';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ContextPinKind' AND e.enumlabel = 'work_item'
    ) THEN
        ALTER TYPE "ContextPinKind" ADD VALUE 'work_item';
    END IF;
END $$;
