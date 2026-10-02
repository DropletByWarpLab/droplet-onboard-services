-- WARP-2911 — the notification recipient column is named for what it holds.
--
-- `NotificationLog.userId` and `PushSubscription.userId` have only ever held a
-- Nextcloud username (`User.username`): the subscribe route stores
-- `req.user.username`, both NotificationLog readers filter by it, and the
-- toast topic is `droplet/notifications/<username>`. The column name said
-- `userId`, so three callers (WARP-2783, WARP-2813, WARP-2910) passed a
-- `User.id` and notified nobody. Renamed to `username`.
--
-- RENAME ONLY. No row is rewritten: every value already IS a username (or, for
-- the rows those three defects wrote, a UUID nobody could read then either).
-- The two indexes follow the column so their names match what Prisma derives
-- from `@@index([username, createdAt])` / `@@index([username])`; leaving the
-- old names is drift `prisma migrate diff` reports. `PushSubscription_endpoint_key`
-- does not mention the column and is untouched.
--
-- Re-runnable (repo idiom): each rename is guarded, so a second run — a
-- re-stamped folder, a hand re-run — is a no-op rather than a failed
-- migration and a dark box.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'NotificationLog' AND column_name = 'userId'
  ) THEN
    ALTER TABLE "NotificationLog" RENAME COLUMN "userId" TO "username";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'PushSubscription' AND column_name = 'userId'
  ) THEN
    ALTER TABLE "PushSubscription" RENAME COLUMN "userId" TO "username";
  END IF;
END $$;

ALTER INDEX IF EXISTS "NotificationLog_userId_createdAt_idx" RENAME TO "NotificationLog_username_createdAt_idx";
ALTER INDEX IF EXISTS "PushSubscription_userId_idx" RENAME TO "PushSubscription_username_idx";
