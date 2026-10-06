-- WARP-3530 (ADR-069 §6, WS-14) — append sla_at_risk, sla_breached and
-- macro_applied to PmActivityVerb.
--
-- Its OWN migration directory, stamped BEFORE the one that ships the SLA tables
-- (20261004140000_warp_3530_service_desk_sla), because PostgreSQL refuses to USE
-- an enum value that the same transaction added, and Prisma applies a migration
-- file inside one transaction. Nothing in the next file writes these verbs; the
-- ticker and the macro service do, at runtime, after both have committed. The
-- idiom — one guarded ADD VALUE per label — is
-- 20261004115900_warp_3528_module_support/migration.sql (and
-- 20260901045000_warp_2581_module_money before it): a re-run is a no-op.
--
--   sla_at_risk / sla_breached  the SLA ticker moved a ticket into AT_RISK /
--                               BREACHED, or a state change found a target already
--                               missed when the ticket was solved. Null actor.
--   macro_applied               an agent applied a macro; the field changes it made
--                               are their own rows, in the same transaction.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'sla_at_risk'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'sla_at_risk';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'sla_breached'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'sla_breached';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'macro_applied'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'macro_applied';
    END IF;
END $$;
