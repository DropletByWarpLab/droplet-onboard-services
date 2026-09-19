-- WARP-2909 (notifier slice C6) — a notification carries a deep link.
--
-- A notification on this box could not tell the person where to go: the log
-- row held kind/title/body and nothing else, so a push about a parked
-- background run opened the cameras page (the service worker's fallback).
-- These two columns are the durable half of the link the dispatcher now
-- threads through the toast, the web push and GET /api/notifications:
--
--   url   a same-origin dashboard path (`/admin/audit?run=<id>`), validated
--         by assertNotificationLink before every write — a single leading `/`,
--         no scheme, no protocol-relative `//host`, no backslash or control
--         characters, at most 512 characters.
--   data  a small, FLAT, PHI-free JSON record the client may badge on
--         (`needsDecision: true` on a parked run), validated by
--         assertNotificationData — no nested values, at most 1 KB, and never
--         the keys url / token / confirmationToken / bindingHash /
--         pendingBindingHash. A notification payload is copied to third-party
--         push services and OS notification stores, and this is what keeps
--         that copy defensible.
--
-- Both nullable, no backfill: a row written before this migration had no link
-- and still has none. A notification never carries a token or an approve
-- action of its own — approval is redeemed only through
-- POST /api/agent-runs/:id/confirm, and the columns cannot hold one.
--
-- Additive and idempotent (WARP-2587 idiom): every ADD COLUMN is IF NOT EXISTS,
-- so a re-run on a populated box is a no-op. This migration seeds NO rows.

ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "url" TEXT;
ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "data" JSONB;
