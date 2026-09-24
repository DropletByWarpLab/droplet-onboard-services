-- WARP-2804 — a notification can be acknowledged by its recipient.
--
-- One explicit state (`unacked | acked | untracked`; unread = unacked) plus the
-- facts of the ack: when, by which path, from which sign-in (the sign-in's id
-- from the signed token; its live-session check can be skipped when the
-- session store is unreachable, so `ackSessionChecked` records whether it ran),
-- and what the client said it was (reported, never proof). No IP and no
-- DeviceClient FK: nothing on an API request binds it to a paired device.
--
-- THE BACKFILL. Rows written before this migration predate acks, so nobody can
-- say whether they were seen: they become `untracked`, never counted as unread
-- and still ackable. `unacked` would flood every badge with 90 days of
-- history; `acked` would fake an ack nobody made. The ADD COLUMN's DEFAULT is
-- what the existing rows get (Postgres stores it as the column's missing
-- value, no table rewrite); the SET DEFAULT after it is what every new row
-- gets, and it matches `@default(unacked)` in schema.prisma.
--
-- THE CHECKS live here because Prisma's schema language cannot express them,
-- and the drift gate cannot see them:
--   * NotificationLog_ack_shape — `acked` exactly when ackedAt and ackMethod
--     are both set; the device facts (ackSessionId, ackClient) only on an
--     acked row;
--   * NotificationLog_ack_session_checked — ackSessionChecked only on an acked
--     row that names a sign-in.
--
-- Re-runnable (repo idiom, WARP-2896's): the types and the CHECK are
-- guarded, the columns and the index use IF NOT EXISTS, so a second run — a
-- re-stamped folder, a hand re-run — is a no-op rather than a failed
-- migration and a dark box. A second run never re-backfills: the columns
-- already exist, so ADD COLUMN is skipped and no existing row changes.

DO $$
BEGIN
  CREATE TYPE "NotificationAckState" AS ENUM ('unacked', 'acked', 'untracked');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "NotificationAckMethod" AS ENUM ('inbox', 'opened', 'all', 'incident');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Existing rows predate acks: 'untracked'. New rows default to 'unacked'.
ALTER TABLE "NotificationLog"
  ADD COLUMN IF NOT EXISTS "ackState" "NotificationAckState" NOT NULL DEFAULT 'untracked',
  ADD COLUMN IF NOT EXISTS "ackedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ackMethod" "NotificationAckMethod",
  ADD COLUMN IF NOT EXISTS "ackSessionId" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "ackClient" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "ackSessionChecked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationLog" ALTER COLUMN "ackState" SET DEFAULT 'unacked';

CREATE INDEX IF NOT EXISTS "NotificationLog_username_ackState_createdAt_idx"
  ON "NotificationLog" ("username", "ackState", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NotificationLog_ack_shape' AND conrelid = '"NotificationLog"'::regclass
  ) THEN
    ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_ack_shape" CHECK (
      ("ackState" = 'acked') = ("ackedAt" IS NOT NULL AND "ackMethod" IS NOT NULL)
      AND ("ackState" = 'acked' OR ("ackSessionId" IS NULL AND "ackClient" IS NULL))
    );
  END IF;
END $$;

-- "The session store confirmed that sign-in was live" can only be said of an
-- acked row that names a sign-in. Its own constraint, so it is added (and
-- guarded) independently of NotificationLog_ack_shape.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NotificationLog_ack_session_checked' AND conrelid = '"NotificationLog"'::regclass
  ) THEN
    ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_ack_session_checked" CHECK (
      NOT "ackSessionChecked" OR ("ackState" = 'acked' AND "ackSessionId" IS NOT NULL)
    );
  END IF;
END $$;
