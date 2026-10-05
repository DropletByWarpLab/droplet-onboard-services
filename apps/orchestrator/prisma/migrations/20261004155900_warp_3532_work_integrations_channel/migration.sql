-- WARP-3532 (ADR-069 §9): OffLanChannelKey gains `work_integrations` — the one
-- sovereignty switch for work data leaving the box: webhooks, Slack / Teams /
-- Discord / Google Chat notifications, and WS-18's GitHub / GitLab poll. The
-- delivery worker reads it fail-closed before every off-LAN delivery
-- (workIntegrationsGate). Default posture is OFF: seedOffLanChannels inserts
-- enabled=false, and only the owner can turn it on.
--
-- Its OWN migration, deliberately, ordered BEFORE 20261004160000_warp_3532_
-- work_webhooks: Postgres refuses to USE a new enum value in the transaction
-- that added it, so the value lands alone and anything that names it comes in
-- a later migration (the repo's drift gate expects that pattern; every earlier
-- channel did it). Same shape as 20260927120000_warp_3264_offlan_place_lookup:
-- the value is APPENDED, and the ADD VALUE is guarded by a pg_enum catalog
-- check because re-adding an existing value errors.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'OffLanChannelKey' AND e.enumlabel = 'work_integrations'
    ) THEN
        ALTER TYPE "OffLanChannelKey" ADD VALUE 'work_integrations';
    END IF;
END $$;
