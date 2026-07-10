-- WARP-1118 (Phase 0, §11): AI Personality & Business Onboarding schema.
--
-- Adds the personality/business-profile enums + the two singleton models
-- (AssistantPersona, BusinessProfile) and the BusinessProfile → ChatSession
-- interview relation. Ordered AFTER 20260708000000 (which adds the
-- MemoryFactCategory 'Business' value alone) — nothing here references that
-- value, keeping the "new enum value not used in its own transaction" rule
-- intact.
--
-- Only AssistantPersona is wired into the prompt this phase; BusinessProfile
-- is created now so the schema is stable and Phase 2 only adds behaviour.
--
-- IDEMPOTENCY: every CREATE TYPE is wrapped in a DO/EXCEPTION duplicate_object
-- guard, tables use CREATE TABLE IF NOT EXISTS, indexes/constraints are guarded,
-- and the singleton seeds use INSERT … ON CONFLICT ("id") DO NOTHING — so
-- re-running on a converged DB (or an existing box snapshot) is a no-op and
-- row/enum-member counts stay stable. The @updatedAt columns carry no DB
-- default, so the seed supplies updatedAt explicitly.

-- ── 1 · Enums ──

DO $$ BEGIN
    CREATE TYPE "PersonaPreset" AS ENUM (
        'warm_friendly',
        'professional_precise',
        'founder',
        'direct_technical'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "PersonaVerbosity" AS ENUM (
        'concise',
        'balanced',
        'detailed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "BusinessOnboardingState" AS ENUM (
        'not_started',
        'in_progress',
        'completed',
        'skipped',
        're_running'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "BusinessProfileSource" AS ENUM (
        'onboarding',
        'settings'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ReviewNudgeState" AS ENUM (
        'none',
        'due',
        'dismissed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── 2 · AssistantPersona (personality singleton) ──

CREATE TABLE IF NOT EXISTS "AssistantPersona" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "preset" "PersonaPreset" NOT NULL DEFAULT 'warm_friendly',
    "verbosity" "PersonaVerbosity" NOT NULL DEFAULT 'balanced',
    "useFirstNames" BOOLEAN NOT NULL DEFAULT true,
    "customInstructions" VARCHAR(1200) NOT NULL DEFAULT '',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantPersona_pkey" PRIMARY KEY ("id")
);

-- ── 3 · BusinessProfile (business-knowledge singleton) ──

CREATE TABLE IF NOT EXISTS "BusinessProfile" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "onboardingState" "BusinessOnboardingState" NOT NULL DEFAULT 'not_started',
    "interviewChatId" TEXT,
    "summary" VARCHAR(1500) NOT NULL DEFAULT '',
    "whatWeDo" VARCHAR(600) NOT NULL DEFAULT '',
    "customers" VARCHAR(600) NOT NULL DEFAULT '',
    "teamShape" VARCHAR(600) NOT NULL DEFAULT '',
    "toolsUsed" VARCHAR(600) NOT NULL DEFAULT '',
    "typicalDay" VARCHAR(600) NOT NULL DEFAULT '',
    "goals" VARCHAR(600) NOT NULL DEFAULT '',
    "lastSource" "BusinessProfileSource",
    "reviewNudgeState" "ReviewNudgeState" NOT NULL DEFAULT 'none',
    "reviewDueAt" TIMESTAMP(3),
    "reviewDismissedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- The interview relation is 1:1 (at most one profile points at a session);
-- the unique index backs Prisma's `interviewChatId String? @unique`. Guarded
-- so re-runs don't error.
DO $$ BEGIN
    CREATE UNIQUE INDEX "BusinessProfile_interviewChatId_key" ON "BusinessProfile"("interviewChatId");
EXCEPTION
    WHEN duplicate_table THEN null;
    WHEN duplicate_object THEN null;
END $$;

-- SetNull on delete: deleting the interview ChatSession must not cascade the
-- singleton profile away (the Phase 3 delete-hook transitions state instead).
-- Guarded so a re-run on a converged DB is a no-op.
DO $$ BEGIN
    ALTER TABLE "BusinessProfile"
        ADD CONSTRAINT "BusinessProfile_interviewChatId_fkey"
        FOREIGN KEY ("interviewChatId") REFERENCES "ChatSession"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── 4 · Singleton seeds ──
--
-- Seed both singletons so the box has a stable id='singleton' row from
-- migrate-time. The services also create-default-on-first-read, so the seed is
-- belt-and-suspenders; ON CONFLICT DO NOTHING keeps re-runs stable. updatedAt
-- is supplied explicitly (the @updatedAt column has no DB default outside this
-- seed's CURRENT_TIMESTAMP).

INSERT INTO "AssistantPersona" ("id", "preset", "verbosity", "useFirstNames", "customInstructions", "updatedAt")
VALUES ('singleton', 'warm_friendly', 'balanced', true, '', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "BusinessProfile" ("id", "onboardingState", "reviewNudgeState", "updatedAt")
VALUES ('singleton', 'not_started', 'none', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
