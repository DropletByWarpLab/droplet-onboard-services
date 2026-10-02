-- WARP-2251 / WARP-2267 — MorningBriefing: one agent-written day plan per user
-- per box-local day, plus its five explicit enums.
--
-- Additive, idempotent (safe to re-run): every CREATE TYPE is guarded by
-- duplicate_object, every CREATE TABLE / INDEX uses IF NOT EXISTS, the FK is
-- duplicate_object guarded. Seeds no rows.
--
-- Enum-then-use (schema.prisma, "Postgres trap"): the types are brand new and
-- created before the table in this script, so the column DEFAULTs below
-- reference values that already exist — no second migration needed.

DO $$ BEGIN
    CREATE TYPE "BriefingStatus" AS ENUM ('pending', 'running', 'ready', 'failed', 'skipped');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "BriefingVibe" AS ENUM ('calm', 'focused', 'busy', 'urgent', 'celebratory', 'quiet', 'stormy', 'fresh');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "BriefingArtKind" AS ENUM ('ascii', 'svg', 'photo');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "BriefingPhotoStatus" AS ENUM ('none', 'fetched', 'fetch_failed', 'disabled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "BriefingTrigger" AS ENUM ('scheduler', 'user');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "MorningBriefing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "forDate" DATE NOT NULL,
    "status" "BriefingStatus" NOT NULL DEFAULT 'pending',
    "skipReason" TEXT,
    "failureReason" TEXT,
    "headline" TEXT,
    "vibe" "BriefingVibe",
    "body" JSONB,
    "sources" JSONB,
    "model" TEXT,
    "iterations" INTEGER,
    "artKind" "BriefingArtKind" NOT NULL DEFAULT 'ascii',
    "photoStatus" "BriefingPhotoStatus" NOT NULL DEFAULT 'none',
    "photoRef" TEXT,
    "triggeredBy" "BriefingTrigger" NOT NULL DEFAULT 'scheduler',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MorningBriefing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MorningBriefing_userId_forDate_idx" ON "MorningBriefing"("userId", "forDate" DESC);

CREATE INDEX IF NOT EXISTS "MorningBriefing_status_forDate_idx" ON "MorningBriefing"("status", "forDate");

CREATE UNIQUE INDEX IF NOT EXISTS "MorningBriefing_userId_forDate_key" ON "MorningBriefing"("userId", "forDate");

DO $$ BEGIN
    ALTER TABLE "MorningBriefing" ADD CONSTRAINT "MorningBriefing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
