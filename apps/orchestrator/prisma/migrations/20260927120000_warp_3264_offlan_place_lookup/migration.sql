-- WARP-3264: OffLanChannelKey gains `place_lookup` — the sovereignty channel
-- for the calendar's online place suggestions (OpenStreetMap Nominatim).
-- GET /api/calendar/places reads it fail-closed on every request before it
-- sends the typed text off the box. Default posture is OFF:
-- seedOffLanChannels inserts enabled=false; only an owner turns it on.
--
-- Same shape as 20260922000000_warp_2904_offlan_web_push: the value is
-- APPENDED, and the ADD VALUE is guarded by a pg_enum catalog check because
-- re-adding an existing value errors.

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'OffLanChannelKey' AND e.enumlabel = 'place_lookup'
    ) THEN
        ALTER TYPE "OffLanChannelKey" ADD VALUE 'place_lookup';
    END IF;
END $$;
