-- WARP-3912 (ADR-043 §4, ADR-072 §1): OffLanChannelKey gains `remote_mcp` — the
-- owner's master switch over every outbound MCP session (the curated Atlassian
-- server today, owner-added servers later). Read fail-closed by remoteMcpGate on
-- every remote call; turning it off tears sessions down.
--
-- Its OWN migration: Postgres refuses to USE a new enum value in the transaction
-- that added it, so the row that names it comes in the next migration. Guarded
-- by a pg_enum check because re-adding an existing value errors.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'OffLanChannelKey' AND e.enumlabel = 'remote_mcp'
    ) THEN
        ALTER TYPE "OffLanChannelKey" ADD VALUE 'remote_mcp';
    END IF;
END $$;
