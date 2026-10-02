-- WARP-2980 (ADR-059 P5 PR-A) — what normal looks like: coverage spans, the
-- learning state per camera, and the baseline builds and their cells.
--
-- Additive only. The Prisma-generated half (CREATE TYPE / CREATE TABLE /
-- indexes / the Cascade FK cell → build) comes first; the hand-written
-- partial unique indexes and CHECKs follow. Both are invisible to
-- `prisma migrate diff`, so check-schema-drift cannot see them either way —
-- they are pinned by security-baseline-build.pg.test.ts instead.
--
-- The spec's job-bookkeeping model `SecurityBaselineState` is created as
-- "SecurityBaselineJobState": `SecurityBaselineState` is the learning-state
-- enum (learning / active / stale), and a Prisma model cannot share an enum's
-- name.
--
-- No seed rows. "SecurityBaselineJobState" is created lazily with
-- INSERT … ON CONFLICT DO NOTHING (createMany with skipDuplicates) and then a
-- read, never upsert({update:{}}).
--
-- NULL discipline: a CHECK whose expression evaluates to NULL PASSES. Every
-- CHECK below that reads a nullable input compares it with IS [NOT] NULL only,
-- or wraps the expression in COALESCE(…, false) — "cameras" is a nullable
-- TEXT[] (Prisma's String[]), so both of its arms are wrapped.

-- CreateEnum
CREATE TYPE "SecurityDayType" AS ENUM ('weekday', 'weekend');

-- CreateEnum
CREATE TYPE "SecurityBaselineState" AS ENUM ('learning', 'active', 'stale');

-- CreateEnum
CREATE TYPE "SecurityCoverageSpanState" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "SecurityBaselineBuildState" AS ENUM ('building', 'ready', 'superseded', 'failed');

-- CreateEnum
CREATE TYPE "SecurityBaselineBuildTrigger" AS ENUM ('first', 'nightly', 'timezone_changed', 'catch_up');

-- CreateEnum
CREATE TYPE "SecurityBaselineKeyKind" AS ENUM ('area', 'camera');

-- CreateTable
CREATE TABLE "SecurityCoverageSpan" (
    "id" BIGSERIAL NOT NULL,
    "camera" VARCHAR(64) NOT NULL,
    "state" "SecurityCoverageSpanState" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "coveredUntil" TIMESTAMP(3) NOT NULL,
    "processId" UUID NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SecurityCoverageSpan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityBaselineSource" (
    "sourceKey" VARCHAR(72) NOT NULL,
    "camera" VARCHAR(64) NOT NULL,
    "state" "SecurityBaselineState" NOT NULL,
    "daysObserved" SMALLINT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "stateChangedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityBaselineSource_pkey" PRIMARY KEY ("sourceKey")
);

-- CreateTable
CREATE TABLE "SecurityBaselineBuild" (
    "id" TEXT NOT NULL,
    "state" "SecurityBaselineBuildState" NOT NULL,
    "trigger" "SecurityBaselineBuildTrigger" NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "windowFrom" VARCHAR(10) NOT NULL,
    "windowTo" VARCHAR(10) NOT NULL,
    "rulesetVersion" SMALLINT NOT NULL,
    "cellsVersion" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "cellCount" INTEGER NOT NULL DEFAULT 0,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(500),

    CONSTRAINT "SecurityBaselineBuild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityBaselineCell" (
    "id" BIGSERIAL NOT NULL,
    "buildId" TEXT NOT NULL,
    "zoneKey" VARCHAR(72) NOT NULL,
    "keyKind" "SecurityBaselineKeyKind" NOT NULL,
    "zoneId" TEXT,
    "camera" VARCHAR(64),
    "zoneVersion" INTEGER,
    "cameras" TEXT[],
    "label" VARCHAR(64) NOT NULL,
    "dayType" "SecurityDayType" NOT NULL,
    "hour" SMALLINT NOT NULL,
    "daysObserved" SMALLINT NOT NULL,
    "daysWithEvent" SMALLINT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "observedMinutes" INTEGER NOT NULL,
    "dwellSamples" INTEGER NOT NULL,
    "durationP99Sec" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityBaselineCell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityBaselineJobState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "hourlyThrough" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityBaselineJobState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityCoverageSpan_camera_coveredUntil_idx" ON "SecurityCoverageSpan"("camera", "coveredUntil");

-- CreateIndex
CREATE INDEX "SecurityCoverageSpan_coveredUntil_idx" ON "SecurityCoverageSpan"("coveredUntil");

-- CreateIndex
CREATE INDEX "SecurityBaselineBuild_state_startedAt_idx" ON "SecurityBaselineBuild"("state", "startedAt");

-- CreateIndex
CREATE INDEX "SecurityBaselineCell_zoneId_idx" ON "SecurityBaselineCell"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityBaselineCell_buildId_zoneKey_label_dayType_hour_key" ON "SecurityBaselineCell"("buildId", "zoneKey", "label", "dayType", "hour");

-- AddForeignKey
ALTER TABLE "SecurityBaselineCell" ADD CONSTRAINT "SecurityBaselineCell_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "SecurityBaselineBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Hand-written: partial unique indexes ────────────────────────────────

-- At most one OPEN coverage span per camera.
CREATE UNIQUE INDEX "SecurityCoverageSpan_one_open" ON "SecurityCoverageSpan" ("camera") WHERE "state" = 'open';
-- Exactly one build is read (the swap is one transaction), and at most one is
-- being built: the database-level single-flight guard for a tick that outlives
-- its advisory lock.
CREATE UNIQUE INDEX "SecurityBaselineBuild_one_ready" ON "SecurityBaselineBuild" ((1)) WHERE "state" = 'ready';
CREATE UNIQUE INDEX "SecurityBaselineBuild_one_building" ON "SecurityBaselineBuild" ((1)) WHERE "state" = 'building';

-- ── Hand-written CHECKs ─────────────────────────────────────────────────

ALTER TABLE "SecurityCoverageSpan" ADD CONSTRAINT "SecurityCoverageSpan_shape" CHECK (
  "camera" ~ '^[a-zA-Z0-9_-]{1,64}$'
  AND "coveredUntil" >= "startedAt"
  AND ("state" = 'closed') = ("closedAt" IS NOT NULL)
);

ALTER TABLE "SecurityBaselineSource" ADD CONSTRAINT "SecurityBaselineSource_shape" CHECK (
  "camera" ~ '^[a-zA-Z0-9_-]{1,64}$'
  AND "sourceKey" = 'camera:' || "camera"
  AND "daysObserved" BETWEEN 0 AND 28
  AND ("state" <> 'active'   OR "daysObserved" >= 14)
  AND ("state" <> 'learning' OR "daysObserved" < 14)
  AND "lastSeenAt" >= "firstSeenAt"
);

ALTER TABLE "SecurityBaselineBuild" ADD CONSTRAINT "SecurityBaselineBuild_shape" CHECK (
  "windowFrom" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "windowTo" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND "windowFrom" <= "windowTo"
  AND ("state" = 'building') = ("finishedAt" IS NULL)
  AND ("state" = 'failed') = ("error" IS NOT NULL)
  AND "rulesetVersion" >= 1 AND "cellsVersion" >= 0 AND "cellCount" >= 0 AND "eventCount" >= 0
);

ALTER TABLE "SecurityBaselineCell" ADD CONSTRAINT "SecurityBaselineCell_key" CHECK (
  ("keyKind" = 'area' AND "zoneId" IS NOT NULL AND "camera" IS NULL AND "zoneVersion" IS NOT NULL
     AND "zoneKey" = 'area:' || "zoneId"
     AND COALESCE(cardinality("cameras") >= 1 AND array_position("cameras", NULL) IS NULL, false))
  OR ("keyKind" = 'camera' AND "camera" IS NOT NULL AND "zoneId" IS NULL AND "zoneVersion" IS NULL
     AND "zoneKey" = 'camera:' || "camera"
     AND COALESCE("cameras" = ARRAY["camera"]::text[], false)
     AND COALESCE("camera" ~ '^[a-zA-Z0-9_-]{1,64}$', false))
);

ALTER TABLE "SecurityBaselineCell" ADD CONSTRAINT "SecurityBaselineCell_counts" CHECK (
  "hour" BETWEEN 0 AND 23
  AND "label" ~ '^[a-zA-Z0-9_-]{1,64}$'
  AND "daysObserved" BETWEEN 0 AND 28
  AND "daysWithEvent" BETWEEN 0 AND "daysObserved"
  AND "eventCount" >= "daysWithEvent"
  AND ("eventCount" = 0) = ("daysWithEvent" = 0)
  AND ("daysObserved" = 0) = ("observedMinutes" = 0)
  AND "observedMinutes" BETWEEN 0 AND "daysObserved" * 120
  AND "dwellSamples" >= 0
  AND ("durationP99Sec" IS NULL) = ("dwellSamples" = 0)
  AND COALESCE("durationP99Sec" >= 0, true)
);

ALTER TABLE "SecurityBaselineJobState" ADD CONSTRAINT "SecurityBaselineJobState_singleton" CHECK ("id" = 'singleton');
