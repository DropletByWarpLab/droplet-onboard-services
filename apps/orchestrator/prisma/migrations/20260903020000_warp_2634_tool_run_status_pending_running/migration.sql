-- WARP-2634 — add `pending` and `running` to ToolRunStatus.
--
-- 20260528100000_warp_462_tool_spec created the enum as ('ok','failed',
-- 'cancelled'), but schema.prisma has declared five members since the same
-- change: `pending, running, ok, failed, cancelled`. The two have disagreed on
-- every migrated box ever since — entry 1 of prisma/schema-drift-baseline.sql,
-- carried as OPEN DRIFT since WARP-1542.
--
-- Latent, not dormant: the generated client accepts `status: "running"`, and a
-- box would answer it with `22P02 invalid input value for enum ToolRunStatus`.
-- tool-spec-runner.service.ts:410 is the only writer and always passes 'ok' or
-- 'failed' explicitly, so nothing has hit it yet. Adding the members is purely
-- additive — no existing row's value changes, no reader's `WHERE status = …`
-- moves.
--
-- BEFORE 'ok' rather than a bare append: it puts the physical enum order in the
-- same sequence schema.prisma declares. Nothing in the codebase reads enum
-- declaration order, so this is cosmetic — it keeps `migrate diff` from having
-- an ordering opinion in a future Prisma release. Same form as
-- 20260828020000_warp_2458_integration_status_needs_reconnect.
--
-- THE COLUMN DEFAULT IS NOT SET HERE, ON PURPOSE.
-- `ToolRun.status DEFAULT 'pending'` USES a value this file adds, and Postgres
-- will not let a value be used in the transaction that adds it. It lands in the
-- next migration, 20260903020100, which is a separate transaction.
--
-- Guarded on the pg_enum catalog: `ALTER TYPE … ADD VALUE` has no
-- transaction-safe `IF NOT EXISTS` across every supported PG and re-adding an
-- existing value errors, so a re-run on a converged DB would fail without this.
-- Same pattern as 20260712000000_warp_1257_intent_failure_states.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ToolRunStatus' AND e.enumlabel = 'pending'
    ) THEN
        ALTER TYPE "ToolRunStatus" ADD VALUE 'pending' BEFORE 'ok';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ToolRunStatus' AND e.enumlabel = 'running'
    ) THEN
        ALTER TYPE "ToolRunStatus" ADD VALUE 'running' BEFORE 'ok';
    END IF;
END $$;
