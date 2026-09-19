-- WARP-2904: NotificationLog records the web-push decision EXPLICITLY.
--
-- `channels` means "channels actually attempted" (push appears only when a
-- push went out) and `error` is only written when nothing delivered. So a
-- push refused by the new `web_push` off-LAN gate, behind a toast that DID
-- deliver, had nowhere to land — and in a query "no subscribers", "gate
-- refused" and "push service failed" were the same row. `pushOutcome` names
-- which one it was; it is never inferred from NULLs (a NULL is a row that
-- predates the column or was written by the transactional
-- `recordNotification` path before any transport ran).
--
-- Additive and nullable, no backfill: the historical rows genuinely carry
-- no decision. Idempotent — the type is guarded by a pg_type catalog check
-- (CREATE TYPE has no IF NOT EXISTS) and the column by ADD COLUMN IF NOT
-- EXISTS — so a re-run on a box that already applied it is a no-op.
-- Separate migration from the enum extension above on purpose: Postgres
-- refuses to USE a value added by `ALTER TYPE … ADD VALUE` in the same
-- transaction, and keeping the two concerns apart keeps each one trivially
-- re-runnable.

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PushOutcome') THEN
        CREATE TYPE "PushOutcome" AS ENUM ('sent', 'no_subscribers', 'refused_gate', 'failed');
    END IF;
END $$;

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN IF NOT EXISTS "pushOutcome" "PushOutcome";
