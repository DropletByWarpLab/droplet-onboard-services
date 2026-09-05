-- WARP-2587 (ADR-045 slice I) — the notify claim on the activity tables, and
-- NotificationLog.kind promoted from a free string to an enum.
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces:
--   - NotifyStatus enum (pending, sent, not_needed)
--   - NotificationKind enum (reminder, event, system, ai) + the TEXT→enum
--     conversion of NotificationLog.kind
--   - PmActivity.notifyStatus / .notifiedAt  + [notifyStatus, createdAt] index
--   - CrmActivity.notifyStatus / .notifiedAt + [notifyStatus, createdAt] index
--   - one CHECK per activity table pinning notifiedAt to the enum
--
-- Per the repo idiom: every CREATE TYPE uses DO $$ ... EXCEPTION WHEN
-- duplicate_object, every ADD COLUMN uses IF NOT EXISTS, every CREATE INDEX
-- uses IF NOT EXISTS, every constraint add is duplicate_object guarded.
-- This migration seeds NO rows.
--
-- ── WHY AN ENUM AND NOT A NULLABLE TIMESTAMP ────────────────────────────────
--
-- The obvious claim column is `notifiedAt DateTime?` claimed on IS NULL. It
-- cannot work here: a two-state nullable timestamp has no way to say
-- "considered and correctly declined", so every non-notifiable row — an
-- `updated` verb, a CRM NOTE, an assignment whose only recipient is the person
-- who made it — would sit at NULL forever and be rescanned by the 60s sweep
-- for the life of the row. That is the forever-pending state CLAUDE.md's
-- "no guessing" rule exists to prevent, and TeamChatMeetingReminderStatus
-- (pending/sent/not_needed) is the shipped precedent this copies.
--
-- `notifiedAt` survives as an AUDIT timestamp only, pinned to the enum by the
-- CHECK below so it can never become a second, disagreeing answer to "was this
-- notified". Same split as PmWorkItem.isCompleted/completedAt and
-- CrmDeal.stage.kind/closedAt.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "NotifyStatus" AS ENUM ('pending', 'sent', 'not_needed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "NotificationKind" AS ENUM ('reminder', 'event', 'system', 'ai');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── NotificationLog.kind: TEXT → NotificationKind ───────────────────────────
--
-- The vocabulary already existed; it just lived in a `//` comment above a
-- String column, which is exactly the string soup the ContextPin docstring
-- cites CLAUDE.md against. Every shipped writer is already constrained to the
-- four labels (notifications.service.ts's TS union, routes/notifications.ts's
-- zod enum, tools-core send-notification's hardcoded 'ai'), so this is the
-- database catching up with the code rather than a behaviour change.
--
-- Nothing at the DB level ever GUARANTEED that, though, and a failed cast
-- would abort an OTA update over a single stray row in a log with a 90-day
-- retention. So any out-of-vocabulary value is normalised to 'system' first
-- and the count is raised as an operator NOTICE — the WARP-2022
-- allowPrivateHost migration's idiom. Deliberately a coercion and not a
-- failure: this table is an append-only delivery log, not a source of truth.
DO $$
DECLARE
  affected INTEGER;
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'NotificationLog' AND column_name = 'kind'
  ) = 'text' THEN
    SELECT COUNT(*) INTO affected
    FROM "NotificationLog"
    WHERE "kind" NOT IN ('reminder', 'event', 'system', 'ai');

    IF affected > 0 THEN
      UPDATE "NotificationLog"
      SET "kind" = 'system'
      WHERE "kind" NOT IN ('reminder', 'event', 'system', 'ai');
      RAISE NOTICE 'WARP-2587: % NotificationLog row(s) carried a kind outside the documented vocabulary and were normalised to ''system'' before the enum cast.', affected;
    END IF;

    ALTER TABLE "NotificationLog"
      ALTER COLUMN "kind" TYPE "NotificationKind" USING "kind"::"NotificationKind";
  END IF;
END $$;

-- ── PmActivity: the claim ───────────────────────────────────────────────────
--
-- ADD COLUMN with DEFAULT 'not_needed', then move the default to 'pending'.
-- That ordering is the whole backfill, and it is deliberate on both counts:
--
--   1. Every row that predates this migration was never notified and must
--      never BE notified. A box upgrading with months of PM history would
--      otherwise have its first sweep tick fan a digest of ancient news out to
--      every assignee on the appliance.
--   2. On PG11+ ADD COLUMN with a constant default is metadata-only, so this
--      backfills a large history table instantly and without a rewrite. An
--      `UPDATE ... SET notifyStatus = 'not_needed'` after the fact would
--      rewrite every row for the same result.
--
-- The final DEFAULT is 'pending', which is what schema.prisma declares — so
-- scripts/check-schema-drift.sh sees no drift.
ALTER TABLE "PmActivity"
  ADD COLUMN IF NOT EXISTS "notifyStatus" "NotifyStatus" NOT NULL DEFAULT 'not_needed';
ALTER TABLE "PmActivity" ALTER COLUMN "notifyStatus" SET DEFAULT 'pending';
ALTER TABLE "PmActivity" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);

-- The sweep's only scan. Without it the 60s tick sequentially walks an
-- append-only table whose rows are ~100% terminal within a minute of being
-- written. Prefix-selective on 'pending' exactly like the
-- [reminderStatus, startsAt] index the meeting sweep runs on.
CREATE INDEX IF NOT EXISTS "PmActivity_notifyStatus_createdAt_idx"
  ON "PmActivity" ("notifyStatus", "createdAt");

-- ── CrmActivity: the same claim ─────────────────────────────────────────────
--
-- Indexed on createdAt, NOT occurredAt, even though every other index on this
-- table is on occurredAt. `occurredAt` is when the interaction HAPPENED and is
-- caller-supplied: a connector backdates it, and a MEETING activity can carry
-- a FUTURE one. A sweep gated on a future occurredAt would never reach its
-- cutoff and the row would be pending forever. `createdAt` is the row-write
-- clock and is monotone.
ALTER TABLE "CrmActivity"
  ADD COLUMN IF NOT EXISTS "notifyStatus" "NotifyStatus" NOT NULL DEFAULT 'not_needed';
ALTER TABLE "CrmActivity" ALTER COLUMN "notifyStatus" SET DEFAULT 'pending';
ALTER TABLE "CrmActivity" ADD COLUMN IF NOT EXISTS "notifiedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "CrmActivity_notifyStatus_createdAt_idx"
  ON "CrmActivity" ("notifyStatus", "createdAt");

-- ── Invariants Prisma's schema language cannot express ──────────────────────
--
-- `notifiedAt` is an audit timestamp, never the state. This constraint is what
-- keeps that true: it is stamped exactly when the row is claimed 'sent', and
-- is NULL for both 'pending' and 'not_needed'. Without it the column drifts
-- into being a second answer to "was this notified", and the next reader picks
-- whichever one is convenient — which is how Reminder.notifiedAt ended up
-- being the state it was never meant to be.
DO $$ BEGIN
  ALTER TABLE "PmActivity"
    ADD CONSTRAINT "PmActivity_notifiedAt_matches_status"
    CHECK (("notifyStatus" = 'sent') = ("notifiedAt" IS NOT NULL));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "CrmActivity"
    ADD CONSTRAINT "CrmActivity_notifiedAt_matches_status"
    CHECK (("notifyStatus" = 'sent') = ("notifiedAt" IS NOT NULL));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
