-- WARP-2909 — a notification carries a deep link.
--
-- Additive, idempotent (ADD COLUMN IF NOT EXISTS, the WARP-2587 idiom), both
-- columns nullable, no backfill: an old row simply has nowhere to open.
--   url  — a same-origin dashboard path, validated in notifications.service.ts
--   data — small flat PHI-free JSON (≤ 1 KB, no token / binding-hash keys)

ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "url" TEXT;
ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "data" JSONB;
