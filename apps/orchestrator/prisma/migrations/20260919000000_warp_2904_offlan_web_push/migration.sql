-- WARP-2904: OffLanChannelKey gains `web_push` — the sovereignty channel
-- for Web Push delivery. `dispatchToUser` (push-dispatch.service.ts) dials
-- whichever push service each PushSubscription row names — a Google, Apple
-- or Mozilla host the browser handed over at subscribe time — and until
-- this key existed that dial had no channel, no registry entry and no
-- gate. The gate reads this channel (fail-closed) at the one dial site,
-- before the subscription rows are even loaded. Default posture is OFF:
-- seedOffLanChannels inserts enabled=false, same as web_fetch /
-- ambient_data / cloud_model_escape — the operator opts in from Settings.
--
-- This migration only EXTENDS the enum. The value is appended (Postgres
-- orders members by physical declaration and `ALTER TYPE … ADD VALUE`
-- only appends cheaply); nothing reads the enum's declaration order.
-- Idempotent: guarded by a pg_enum catalog check, because
-- `ALTER TYPE … ADD VALUE` has no transaction-safe `IF NOT EXISTS` on
-- every supported PG and re-adding an existing value errors — same
-- pattern as 20260720000000_warp_1436_offlan_ambient_data.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'OffLanChannelKey' AND e.enumlabel = 'web_push'
    ) THEN
        ALTER TYPE "OffLanChannelKey" ADD VALUE 'web_push';
    END IF;
END $$;
