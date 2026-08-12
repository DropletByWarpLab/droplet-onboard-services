-- WARP-1874 — explicit video-call link on meetings and calendar events.
--
-- Additive and backward-compatible by construction: two nullable columns,
-- no default, no backfill, no rewrite of existing rows. Events that predate
-- this migration — including the ones whose `location` already holds a
-- pasted meeting URL — keep working exactly as they did; that text stays in
-- `location` and stays plain text. Nothing here guesses whether an existing
-- location string "is really a link".
--
-- IF NOT EXISTS makes a re-run a no-op, so `migrate deploy` on a box that
-- already has the column is safe.

ALTER TABLE "CalendarEvent" ADD COLUMN IF NOT EXISTS "meetingUrl" TEXT;
ALTER TABLE "TeamChatMeeting" ADD COLUMN IF NOT EXISTS "meetingUrl" TEXT;
