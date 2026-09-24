-- WARP-2904: OffLanChannelKey gains `web_push` — the sovereignty channel for
-- Web Push delivery. dispatchToUser (push-dispatch.service.ts) reads it
-- fail-closed on every call before dialling the push service a
-- PushSubscription row names (Google / Apple / Mozilla). Default posture is
-- OFF: seedOffLanChannels inserts enabled=false, same as ambient_data — an
-- admin opts in.
--
-- Same shape as 20260720000000_warp_1436_offlan_ambient_data: the value is
-- APPENDED, and the ADD VALUE is guarded by a pg_enum catalog check because
-- re-adding an existing value errors.

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
