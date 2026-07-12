-- WARP-1257: intent-preserving failure states for the department reconciler.
--
-- The reconciler's state machine previously collapsed two DIFFERENT original
-- intents into one generic failure value, then always retried it down the
-- provision / sync path:
--   - a department archive that failed partway (folder-delete 5xx) was stored
--     as ProvisionState `failed` and re-PROVISIONED on the next tick — silently
--     un-archiving the department and restoring its rw/ro group access;
--   - a membership removal that failed partway (OCS 5xx) was stored as
--     NcSyncState `failed` and re-SYNCED on the next tick — silently re-granting
--     the revoked user's access while reporting the row `synced`.
--
-- The fix carries the original intent through the failure with a distinct
-- failure value per intent, honouring the explicit-state / never-guess rule
-- (CLAUDE.md — state is a column, never inferred):
--   - ProvisionState gains `archive_failed` (archive-intent failure);
--     `failed` remains the provision-intent failure.
--   - NcSyncState gains `remove_failed` (removal-intent failure);
--     `failed` remains the sync-intent failure.
--
-- This migration only EXTENDS the two enums. Values are appended (Postgres
-- orders members by physical declaration and `ALTER TYPE … ADD VALUE` only
-- appends cheaply); nothing reads the enums' declaration order. Idempotent:
-- guarded by a pg_enum catalog check, because `ALTER TYPE … ADD VALUE` has no
-- transaction-safe `IF NOT EXISTS` on every supported PG and re-adding an
-- existing value errors — same pattern as 20260624000000_warp_890_email_sending_claim.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ProvisionState' AND e.enumlabel = 'archive_failed'
    ) THEN
        ALTER TYPE "ProvisionState" ADD VALUE 'archive_failed';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'NcSyncState' AND e.enumlabel = 'remove_failed'
    ) THEN
        ALTER TYPE "NcSyncState" ADD VALUE 'remove_failed';
    END IF;
END $$;
