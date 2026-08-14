-- WARP-1685 — Team chat v1.1: meetings inside threads (invite card, RSVP,
-- cancel) + the reminder sweep's lifecycle columns.
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces:
--   - TeamChatMeetingStatus enum (scheduled, cancelled)
--   - TeamChatMeetingReminderStatus enum (pending, sent, not_needed)
--   - TeamChatRsvpResponse enum (accepted, declined)
--   - `meeting_invite` + `meeting_reminder` appended to TeamChatMessageKind
--     (pg_enum catalog check, the WARP-1683 ModuleId-append idiom)
--   - TeamChatMeeting / TeamChatMeetingRsvp models
--   - TeamChatMessage.meetingId (FK → TeamChatMeeting, ON DELETE SET NULL:
--     the card message survives as history if the meeting row ever goes)
--
-- User references (createdById / userId) are BARE `User.id` UUID columns —
-- no FK — matching the v1 precedent, so a user-row deletion never cascades
-- a shared meeting history away. ADR-027 IDOR rule: these hold
-- `req.user.id`, NEVER the username. `inviteMessageId` / `calendarEventId`
-- are bare link columns for the same reason.
--
-- Per the repo idiom: every CREATE TYPE uses DO $$ ... EXCEPTION WHEN
-- duplicate_object, enum appends use a pg_enum catalog check (ALTER TYPE
-- ... ADD VALUE has no in-transaction IF NOT EXISTS on every supported PG,
-- and the new values are never USED inside this same transaction), every
-- CREATE TABLE/INDEX uses IF NOT EXISTS, every ALTER TABLE ADD COLUMN uses
-- IF NOT EXISTS, every FK add is duplicate_object guarded. This migration
-- seeds NO rows.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "TeamChatMeetingStatus" AS ENUM ('scheduled', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TeamChatMeetingReminderStatus" AS ENUM ('pending', 'sent', 'not_needed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TeamChatRsvpResponse" AS ENUM ('accepted', 'declined');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Extend TeamChatMessageKind (append-only; order is not read) ──

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'TeamChatMessageKind' AND e.enumlabel = 'meeting_invite'
    ) THEN
        ALTER TYPE "TeamChatMessageKind" ADD VALUE 'meeting_invite';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'TeamChatMessageKind' AND e.enumlabel = 'meeting_reminder'
    ) THEN
        ALTER TYPE "TeamChatMessageKind" ADD VALUE 'meeting_reminder';
    END IF;
END $$;

-- ── TeamChatMeeting ──

CREATE TABLE IF NOT EXISTS "TeamChatMeeting" (
    "id"                    TEXT                            NOT NULL,
    "threadId"              TEXT                            NOT NULL,
    "inviteMessageId"       TEXT,
    "calendarEventId"       TEXT,
    "title"                 TEXT                            NOT NULL,
    "startsAt"              TIMESTAMP(3)                    NOT NULL,
    "durationMinutes"       INTEGER,
    "location"              TEXT,
    "note"                  TEXT,
    "createdById"           TEXT                            NOT NULL,
    "status"                "TeamChatMeetingStatus"         NOT NULL DEFAULT 'scheduled',
    "reminderMinutesBefore" INTEGER                         NOT NULL DEFAULT 15,
    "reminderStatus"        "TeamChatMeetingReminderStatus" NOT NULL DEFAULT 'pending',
    "createdAt"             TIMESTAMP(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChatMeeting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TeamChatMeeting_reminderStatus_startsAt_idx"
    ON "TeamChatMeeting"("reminderStatus", "startsAt");

CREATE INDEX IF NOT EXISTS "TeamChatMeeting_threadId_idx"
    ON "TeamChatMeeting"("threadId");

DO $$ BEGIN
    ALTER TABLE "TeamChatMeeting"
        ADD CONSTRAINT "TeamChatMeeting_threadId_fkey"
        FOREIGN KEY ("threadId") REFERENCES "TeamChatThread"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── TeamChatMeetingRsvp ──

CREATE TABLE IF NOT EXISTS "TeamChatMeetingRsvp" (
    "id"          TEXT                   NOT NULL,
    "meetingId"   TEXT                   NOT NULL,
    "userId"      TEXT                   NOT NULL,
    "response"    "TeamChatRsvpResponse" NOT NULL,
    "respondedAt" TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamChatMeetingRsvp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamChatMeetingRsvp_meetingId_userId_key"
    ON "TeamChatMeetingRsvp"("meetingId", "userId");

CREATE INDEX IF NOT EXISTS "TeamChatMeetingRsvp_userId_idx"
    ON "TeamChatMeetingRsvp"("userId");

DO $$ BEGIN
    ALTER TABLE "TeamChatMeetingRsvp"
        ADD CONSTRAINT "TeamChatMeetingRsvp_meetingId_fkey"
        FOREIGN KEY ("meetingId") REFERENCES "TeamChatMeeting"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── TeamChatMessage.meetingId ──

ALTER TABLE "TeamChatMessage"
    ADD COLUMN IF NOT EXISTS "meetingId" TEXT;

CREATE INDEX IF NOT EXISTS "TeamChatMessage_meetingId_idx"
    ON "TeamChatMessage"("meetingId");

DO $$ BEGIN
    ALTER TABLE "TeamChatMessage"
        ADD CONSTRAINT "TeamChatMessage_meetingId_fkey"
        FOREIGN KEY ("meetingId") REFERENCES "TeamChatMeeting"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
