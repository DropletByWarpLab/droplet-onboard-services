-- WARP-1683 — Team chat v1: internal member-to-member messaging with Files
-- doc + AI-chat forwarding.
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces:
--   - TeamChatThreadKind enum (direct, group)
--   - TeamChatMessageKind enum (text, file_share, ai_chat_share)
--   - `team_chat` appended to the App-Modules ModuleId enum (registry entry
--     defaultEnabled=true — no ModuleSetting seed row; a missing row means
--     "operator hasn't decided" and the registry default applies, per the
--     module-toggles design)
--   - TeamChatThread / TeamChatParticipant / TeamChatMessage models
--
-- User references (createdById / userId / senderId) are BARE `User.id` UUID
-- columns — no FK — matching the FileComment.authorUserId precedent, so a
-- user-row deletion never cascades a shared conversation history away.
-- ADR-027 IDOR rule: these hold `req.user.id`, NEVER the username.
--
-- TeamChatMessage.sharedChatSessionId IS a real FK to ChatSession with
-- ON DELETE SET NULL: the forward keeps serving from its immutable
-- `sharedChatSnapshot` after the source conversation is deleted.
--
-- Per the repo idiom: every CREATE TYPE uses DO $$ ... EXCEPTION WHEN
-- duplicate_object, the enum append uses a pg_enum catalog check (ALTER TYPE
-- ... ADD VALUE has no in-transaction IF NOT EXISTS on every supported PG,
-- and the new value is never USED inside this same transaction), every
-- CREATE TABLE/INDEX uses IF NOT EXISTS, every FK add is duplicate_object
-- guarded. This migration seeds NO rows.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "TeamChatThreadKind" AS ENUM ('direct', 'group');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TeamChatMessageKind" AS ENUM ('text', 'file_share', 'ai_chat_share');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Extend ModuleId with 'team_chat' (append-only; order is not read) ──

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ModuleId' AND e.enumlabel = 'team_chat'
    ) THEN
        ALTER TYPE "ModuleId" ADD VALUE 'team_chat';
    END IF;
END $$;

-- ── TeamChatThread ──

CREATE TABLE IF NOT EXISTS "TeamChatThread" (
    "id"            TEXT                 NOT NULL,
    "kind"          "TeamChatThreadKind" NOT NULL,
    "title"         TEXT,
    "createdById"   TEXT                 NOT NULL,
    "createdAt"     TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChatThread_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TeamChatThread_lastMessageAt_idx"
    ON "TeamChatThread"("lastMessageAt" DESC);

-- ── TeamChatParticipant ──

CREATE TABLE IF NOT EXISTS "TeamChatParticipant" (
    "id"         TEXT         NOT NULL,
    "threadId"   TEXT         NOT NULL,
    "userId"     TEXT         NOT NULL,
    "joinedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChatParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamChatParticipant_threadId_userId_key"
    ON "TeamChatParticipant"("threadId", "userId");

CREATE INDEX IF NOT EXISTS "TeamChatParticipant_userId_idx"
    ON "TeamChatParticipant"("userId");

DO $$ BEGIN
    ALTER TABLE "TeamChatParticipant"
        ADD CONSTRAINT "TeamChatParticipant_threadId_fkey"
        FOREIGN KEY ("threadId") REFERENCES "TeamChatThread"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── TeamChatMessage ──

CREATE TABLE IF NOT EXISTS "TeamChatMessage" (
    "id"                  TEXT                  NOT NULL,
    "threadId"            TEXT                  NOT NULL,
    "senderId"            TEXT                  NOT NULL,
    "kind"                "TeamChatMessageKind" NOT NULL,
    "body"                TEXT,
    "sharedNcFileId"      INTEGER,
    "sharedFileName"      TEXT,
    "sharedFilePath"      TEXT,
    "sharedChatSessionId" TEXT,
    "sharedChatSnapshot"  JSONB,
    "createdAt"           TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TeamChatMessage_threadId_createdAt_idx"
    ON "TeamChatMessage"("threadId", "createdAt");

CREATE INDEX IF NOT EXISTS "TeamChatMessage_sharedChatSessionId_idx"
    ON "TeamChatMessage"("sharedChatSessionId");

DO $$ BEGIN
    ALTER TABLE "TeamChatMessage"
        ADD CONSTRAINT "TeamChatMessage_threadId_fkey"
        FOREIGN KEY ("threadId") REFERENCES "TeamChatThread"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "TeamChatMessage"
        ADD CONSTRAINT "TeamChatMessage_sharedChatSessionId_fkey"
        FOREIGN KEY ("sharedChatSessionId") REFERENCES "ChatSession"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
