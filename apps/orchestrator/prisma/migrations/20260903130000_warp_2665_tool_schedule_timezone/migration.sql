-- WARP-2665 — per-row IANA timezone for ToolSchedule.
--
-- KAN-6 gave SceneSchedule this column and documented why: an RRULE with no
-- per-row zone freezes a "07:00 local" routine to a single UTC instant, which
-- drifts by an hour at every daylight-saving boundary. ToolSchedule was left
-- on the UTC-only path and the ticker still calls nextFireFromRrule/2.
--
-- That was harmless while nothing could create a ToolSchedule row (no route,
-- no seed, no tool wrote one — see this ticket's defect 1). WARP-2665 adds the
-- write path, so the zone has to exist before the first row does; otherwise
-- every routine an operator schedules is silently interpreted as UTC.
--
-- Default 'UTC' keeps nextFireFromRrule's UTC fast-path byte-for-byte, and
-- there is no backfill to write because the table is empty on every box.
ALTER TABLE "ToolSchedule"
    ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'UTC';
