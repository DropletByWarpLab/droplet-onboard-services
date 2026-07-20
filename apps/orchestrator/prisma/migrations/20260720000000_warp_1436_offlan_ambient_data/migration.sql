-- WARP-1436: OffLanChannelKey gains `ambient_data` — the sovereignty
-- channel for ambient web data ("Weather & currency data (Open-Meteo,
-- European Central Bank)"). GET /api/web/weather and GET /api/web/rates
-- check this channel (fail-closed) before proxying to the
-- services/web-fetch allowlisted fetcher. Default posture is OFF:
-- seedOffLanChannels inserts enabled=false, same as web_fetch /
-- cloud_model_escape — the operator opts in from Settings.
--
-- This migration only EXTENDS the enum. The value is appended (Postgres
-- orders members by physical declaration and `ALTER TYPE … ADD VALUE`
-- only appends cheaply); nothing reads the enum's declaration order.
-- Idempotent: guarded by a pg_enum catalog check, because
-- `ALTER TYPE … ADD VALUE` has no transaction-safe `IF NOT EXISTS` on
-- every supported PG and re-adding an existing value errors — same
-- pattern as 20260715000000_warp_1058_activitykind_voice.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'OffLanChannelKey' AND e.enumlabel = 'ambient_data'
    ) THEN
        ALTER TYPE "OffLanChannelKey" ADD VALUE 'ambient_data';
    END IF;
END $$;
