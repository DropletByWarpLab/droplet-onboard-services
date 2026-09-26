-- WARP-2979 (ADR-059 P4, spec §5 folder 1) — the enum values Droplet's AI
-- needs: 'proposed' and 'rejected' on SecurityZoneLinkState (a link Droplet
-- suggests; a suggestion or a Droplet link a person turned down), and
-- 'camera_offline_during_activity' on SecurityReasonCode.
--
-- Its OWN migration directory, stamped BEFORE the tables' and CHECKs'
-- (20260926000100_warp_2979_security_ai), because PostgreSQL will not let a
-- transaction use an enum value that the same transaction added — and the
-- next folder's "SecurityZoneLink_origin_shape" and
-- "SecurityIncidentReason_code_severity" CHECKs compare against these values.
-- `ADD VALUE`, never a rewrite of the type: existing rows are untouched and
-- nothing locks the table.
--
-- Guarded on pg_enum so a re-run is a no-op — the idiom from
-- 20260924000000_warp_2977_security_mode_event_values. Nothing else goes in
-- this folder.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityZoneLinkState' AND e.enumlabel = 'proposed'
    ) THEN
        ALTER TYPE "SecurityZoneLinkState" ADD VALUE 'proposed';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityZoneLinkState' AND e.enumlabel = 'rejected'
    ) THEN
        ALTER TYPE "SecurityZoneLinkState" ADD VALUE 'rejected';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SecurityReasonCode' AND e.enumlabel = 'camera_offline_during_activity'
    ) THEN
        ALTER TYPE "SecurityReasonCode" ADD VALUE 'camera_offline_during_activity';
    END IF;
END $$;
