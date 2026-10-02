-- WARP-2977 P2b-2 (#2513 review) — "is this a lock's baseline row" as an
-- explicit column, not a substring of the dedupe key.
--
-- A baseline is the row the lock adapter writes when the store held no
-- earlier reading for that lock to compare against (the first reading ever,
-- or the first after retention emptied its history). Its time is when
-- Droplet first saw the lock, not when the lock turned, so the lock-change
-- readers (WARP-2979) must skip it. Until now they did that by looking for
-- `:after:none:` inside `dedupeKey`, which breaks the repo's "no guessing"
-- rule (persistent state lives in an explicit column).
--
-- Additive and re-runnable (ADD COLUMN IF NOT EXISTS; the backfill only
-- touches rows still false). Only lock rows are ever true. The backfill is
-- for boxes that ran this branch before the column existed: their baseline
-- rows are exactly the lock rows whose key the adapter built with no
-- previous row id. It runs once here; nothing reads the key for this again.

-- AlterTable
ALTER TABLE "SecurityEvent" ADD COLUMN IF NOT EXISTS "baseline" BOOLEAN NOT NULL DEFAULT false;

-- Backfill
UPDATE "SecurityEvent"
SET "baseline" = true
WHERE "source" = 'matter_lock'
  AND "baseline" = false
  AND "dedupeKey" LIKE '%:after:none:%';
