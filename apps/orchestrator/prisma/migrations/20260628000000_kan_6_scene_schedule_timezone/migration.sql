-- KAN-6 — per-row IANA timezone for SceneSchedule (fix DST drift).
--
-- SceneSchedule (added in 20260619000000_scene_schedule) stored a UTC-only
-- RRULE with no per-row timezone, so a routine authored at "07:00 local"
-- persisted as a fixed UTC instant and drifted an hour across a
-- daylight-saving change (07:00 PDT → 06:00 PST). This adds the IANA zone
-- the rrule's wall-clock time is interpreted in; the scene-schedule-ticker
-- recomputes nextFireAt against it each fire, so the wall-clock the owner
-- picked stays put and the resolved UTC instant shifts with the offset.
--
-- BACK-COMPAT: NOT NULL DEFAULT 'UTC'. Every existing row back-fills to
-- 'UTC', which is the rrule.ts UTC fast-path — byte-for-byte the pre-KAN-6
-- behaviour, so already-persisted schedules fire at exactly the same instant
-- they did before. New rows carry the owner's browser IANA zone.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so a re-apply (e.g. a reflash that
-- replays migrations) is a no-op. Same posture as the WARP-112 / scene
-- migrations.

ALTER TABLE "SceneSchedule"
    ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'UTC';
