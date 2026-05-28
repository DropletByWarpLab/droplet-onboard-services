-- WARP-462 — Phase C1. Productized workflow registry.
--
-- ToolSpec composes capabilities (from packages/tools-core) into an
-- operator-shareable, scheduled, versioned routine. ToolStep is the
-- ordered list of dispatches; ToolRun is the per-execution audit row;
-- ToolSchedule is the RRULE wrapper that WARP-463's ticker advances.
--
-- Idempotent: enums in DO/EXCEPTION blocks, tables + indexes with
-- IF NOT EXISTS, FK constraints in DO/EXCEPTION blocks. Same posture
-- as the WARP-456 / WARP-457 / WARP-460 / WARP-461 / WARP-467 /
-- WARP-468 / WARP-470 / WARP-473 / WARP-474 / WARP-475 migrations.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "ToolSpecStatus" AS ENUM ('live', 'draft', 'suggested');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ToolRunStatus" AS ENUM ('ok', 'failed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Tables ──

CREATE TABLE IF NOT EXISTS "ToolSpec" (
    "id"          TEXT             NOT NULL,
    "slug"        TEXT             NOT NULL,
    "name"        TEXT             NOT NULL,
    "category"    TEXT,
    "description" TEXT,
    "version"     INTEGER          NOT NULL DEFAULT 1,
    "status"      "ToolSpecStatus" NOT NULL DEFAULT 'draft',
    "ownerId"     TEXT,
    "share"       TEXT,
    "safety"      INTEGER          NOT NULL DEFAULT 1,
    "writes"      BOOLEAN          NOT NULL DEFAULT false,
    "reversible"  BOOLEAN          NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "ToolSpec_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ToolSpec_slug_key"
    ON "ToolSpec"("slug");

CREATE INDEX IF NOT EXISTS "ToolSpec_status_updatedAt_idx"
    ON "ToolSpec"("status", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS "ToolStep" (
    "id"     TEXT    NOT NULL,
    "specId" TEXT    NOT NULL,
    "idx"    INTEGER NOT NULL,
    "kind"   TEXT    NOT NULL DEFAULT 'call',
    "args"   JSONB   NOT NULL,

    CONSTRAINT "ToolStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ToolStep_specId_idx_idx"
    ON "ToolStep"("specId", "idx");

CREATE TABLE IF NOT EXISTS "ToolRun" (
    "id"          TEXT            NOT NULL,
    "specId"      TEXT            NOT NULL,
    "triggeredBy" TEXT,
    "startedAt"   TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"     TIMESTAMP(3),
    "status"      "ToolRunStatus" NOT NULL DEFAULT 'ok',
    "error"       TEXT,
    "trace"       JSONB,

    CONSTRAINT "ToolRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ToolRun_specId_startedAt_idx"
    ON "ToolRun"("specId", "startedAt" DESC);

CREATE TABLE IF NOT EXISTS "ToolSchedule" (
    "id"         TEXT         NOT NULL,
    "specId"     TEXT         NOT NULL,
    "rrule"      TEXT         NOT NULL,
    "nextFireAt" TIMESTAMP(3) NOT NULL,
    "enabled"    BOOLEAN      NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ToolSchedule_nextFireAt_idx"
    ON "ToolSchedule"("nextFireAt");
CREATE INDEX IF NOT EXISTS "ToolSchedule_specId_idx"
    ON "ToolSchedule"("specId");

-- ── Foreign keys ──
-- Postgres lacks IF NOT EXISTS for constraints; wrap each in
-- DO/EXCEPTION so re-applying the migration is a no-op.

DO $$ BEGIN
    ALTER TABLE "ToolStep"
        ADD CONSTRAINT "ToolStep_specId_fkey"
        FOREIGN KEY ("specId") REFERENCES "ToolSpec"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ToolRun"
        ADD CONSTRAINT "ToolRun_specId_fkey"
        FOREIGN KEY ("specId") REFERENCES "ToolSpec"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ToolSchedule"
        ADD CONSTRAINT "ToolSchedule_specId_fkey"
        FOREIGN KEY ("specId") REFERENCES "ToolSpec"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
