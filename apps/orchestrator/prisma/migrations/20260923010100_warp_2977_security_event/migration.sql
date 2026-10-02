-- WARP-2977 (ADR-059 §3.3) — the Security command center's event store.
--
-- SecurityEvent is append-only, one row per observation, and deliberately
-- NOT ActivityRow (an HMAC chain; see schema.prisma). The unique dedupeKey
-- absorbs MQTT QoS-1 redelivery. SecurityIngestState is a one-row table for
-- the threat mirror's cursor and the retention job's last run.
--
-- Additive only. 'security' was appended to ModuleId in the migration
-- stamped just before this one (an enum value cannot be used in the
-- transaction that adds it).

-- CreateEnum
CREATE TYPE "SecurityEventSource" AS ENUM ('frigate', 'frigate_status', 'activity_mirror');

-- CreateEnum
CREATE TYPE "SecurityEventKind" AS ENUM ('detection', 'detection_low', 'camera_offline', 'camera_online', 'source_offline', 'source_online', 'threat');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('info', 'notice', 'alert');

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" BIGSERIAL NOT NULL,
    "source" "SecurityEventSource" NOT NULL,
    "kind" "SecurityEventKind" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "camera" TEXT,
    "sourceRef" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "labels" TEXT[],
    "cameraZones" TEXT[],
    "score" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityIngestState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "threatCursor" BIGINT NOT NULL DEFAULT 0,
    "threatMirrorRanAt" TIMESTAMP(3),
    "retentionRanAt" TIMESTAMP(3),
    "retentionDeleted" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityIngestState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecurityEvent_dedupeKey_key" ON "SecurityEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "SecurityEvent_startedAt_idx" ON "SecurityEvent"("startedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_camera_startedAt_idx" ON "SecurityEvent"("camera", "startedAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_kind_startedAt_idx" ON "SecurityEvent"("kind", "startedAt");

