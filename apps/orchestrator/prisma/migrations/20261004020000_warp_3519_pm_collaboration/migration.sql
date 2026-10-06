-- WARP-3519 (ADR-069 WS-2) — Collaboration on work items: comment edit/delete,
-- @mentions, reactions, watchers.
--
-- Additive and idempotent (safe to re-run on a populated database). Introduces:
--   - PmComment.editedAt / isDeleted / deletedAt / deletedById  (+ 2 CHECKs)
--   - PmCommentReaction   (one person's reaction to one comment)
--   - PmWorkItemWatcher   (+ PmWatchReason enum) — who hears about an item
--   - PmCommentMention    (who a comment @mentions)
--   - PmActivityVerb: comment_edited, comment_deleted, watcher_added,
--                     watcher_removed, mentioned
--
-- Per the repo idiom: every CREATE TYPE is duplicate_object guarded, every
-- ADD COLUMN / CREATE TABLE / CREATE INDEX uses IF NOT EXISTS, every
-- constraint add is duplicate_object guarded.
--
-- ── a delete is SOFT, and "deleted" is an explicit column ───────────────────
--
-- The comment row survives a delete as a tombstone (body cleared) so the thread
-- keeps its shape and the activity trail keeps an anchor. `isDeleted` is the
-- canonical signal — NOT derived from `deletedAt IS NOT NULL` (CLAUDE.md "no
-- guessing"; the PmWorkItem.isCompleted/completedAt split from WARP-884).
-- `deletedAt`/`deletedById` stay as the audit pair and are pinned to the flag so
-- the two can never disagree about whether a comment is deleted:
--
--   PmComment_deleted_matches_flag   ("isDeleted" = ("deletedAt" IS NOT NULL))
--                                    and a deleter is only recorded on a
--                                    deleted row
--   PmComment_tombstone_has_no_body  a deleted comment carries no content — a
--                                    non-service writer cannot leave the text
--                                    of a "deleted" comment readable
--
-- Every pre-existing row is isDeleted = false with no deletedAt, which both
-- CHECKs accept, so adding them validates the whole table without a rewrite.
--
-- ── PmActivityVerb ──────────────────────────────────────────────────────────
--
-- The five values are added here and are NOT referenced by any statement in
-- this file: Postgres refuses to USE an enum value added by ALTER TYPE in the
-- same transaction, and Prisma applies a migration file inside one transaction
-- (the same note 20260904140100_warp_2586_pm_work_item_relation carries).
--
-- ── the watcher backfill ────────────────────────────────────────────────────
--
-- Assignees were already told about their own work (the activity notify sweep
-- reads PmWorkItemAssignee). Going forward an assignment also WATCHES the item
-- (reason ASSIGNEE), and that row outlives an unassignment. Existing
-- assignments get the same row so an item assigned yesterday behaves like one
-- assigned tomorrow. Creators and past commenters are deliberately NOT
-- backfilled: that would start notifying people about items they have not
-- touched in months, which is a behaviour change, not a record of one.
-- Idempotent: ON CONFLICT DO NOTHING on the unique (workItemId, userId).

-- ── PmActivityVerb ──

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'comment_edited'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'comment_edited';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'comment_deleted'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'comment_deleted';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'watcher_added'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'watcher_added';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'watcher_removed'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'watcher_removed';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'mentioned'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'mentioned';
    END IF;
END $$;

-- ── PmWatchReason ──

DO $$ BEGIN
    CREATE TYPE "PmWatchReason" AS ENUM ('CREATOR', 'ASSIGNEE', 'COMMENTER', 'MENTIONED', 'MANUAL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── PmComment: edit + soft-delete columns ──

ALTER TABLE "PmComment"
    ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "deletedById" TEXT;

DO $$ BEGIN
    ALTER TABLE "PmComment" ADD CONSTRAINT "PmComment_deleted_matches_flag"
        CHECK (
            "isDeleted" = ("deletedAt" IS NOT NULL)
            AND ("deletedById" IS NULL OR "isDeleted")
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "PmComment" ADD CONSTRAINT "PmComment_tombstone_has_no_body"
        CHECK (NOT "isDeleted" OR "commentHtml" = '');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── PmCommentReaction ──

CREATE TABLE IF NOT EXISTS "PmCommentReaction" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmCommentReaction_pkey" PRIMARY KEY ("id")
);

-- The unique key IS the "reactions on this comment" index (commentId leads).
CREATE UNIQUE INDEX IF NOT EXISTS "PmCommentReaction_commentId_userId_emoji_key"
    ON "PmCommentReaction"("commentId", "userId", "emoji");

DO $$ BEGIN
    ALTER TABLE "PmCommentReaction" ADD CONSTRAINT "PmCommentReaction_commentId_fkey"
        FOREIGN KEY ("commentId") REFERENCES "PmComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── PmWorkItemWatcher ──

CREATE TABLE IF NOT EXISTS "PmWorkItemWatcher" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" "PmWatchReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmWorkItemWatcher_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PmWorkItemWatcher_workItemId_userId_key"
    ON "PmWorkItemWatcher"("workItemId", "userId");
CREATE INDEX IF NOT EXISTS "PmWorkItemWatcher_userId_idx"
    ON "PmWorkItemWatcher"("userId");

DO $$ BEGIN
    ALTER TABLE "PmWorkItemWatcher" ADD CONSTRAINT "PmWorkItemWatcher_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── PmCommentMention ──

CREATE TABLE IF NOT EXISTS "PmCommentMention" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmCommentMention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PmCommentMention_commentId_userId_key"
    ON "PmCommentMention"("commentId", "userId");
CREATE INDEX IF NOT EXISTS "PmCommentMention_userId_idx"
    ON "PmCommentMention"("userId");

DO $$ BEGIN
    ALTER TABLE "PmCommentMention" ADD CONSTRAINT "PmCommentMention_commentId_fkey"
        FOREIGN KEY ("commentId") REFERENCES "PmComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Backfill: today's assignees watch the items they are assigned to ──

INSERT INTO "PmWorkItemWatcher" ("id", "workItemId", "userId", "reason", "createdAt")
SELECT gen_random_uuid()::text, a."workItemId", a."userId", 'ASSIGNEE'::"PmWatchReason", a."createdAt"
FROM "PmWorkItemAssignee" a
ON CONFLICT ("workItemId", "userId") DO NOTHING;
