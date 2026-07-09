-- WARP-1118 (D-9): add the `Business` value to the MemoryFactCategory enum.
--
-- This migration adds the enum VALUE and NOTHING ELSE. Postgres cannot USE a
-- freshly-added enum value in the same transaction that adds it
-- (ERROR: unsafe use of new value ... of enum type). So the value is added
-- alone here and every consumer that references `Business` (the persona /
-- business-profile models, the extract/recall handlers, routes/memory.ts zod,
-- the dashboard type + CATEGORIES dropdown) lands in later migrations/commits
-- (Phase 2), never in this file.
--
-- IDEMPOTENCY: `ALTER TYPE … ADD VALUE` has no transaction-safe `IF NOT EXISTS`
-- on every supported Postgres and re-adding an existing value errors, so the
-- add is guarded by a pg_enum catalog check inside a DO block — re-running the
-- migration on a converged DB is a no-op and the enum-member count stays
-- stable. Same defensive spirit as the 20260601000000 SetupStep 'claim' guard.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'MemoryFactCategory' AND e.enumlabel = 'Business'
    ) THEN
        ALTER TYPE "MemoryFactCategory" ADD VALUE 'Business';
    END IF;
END $$;
