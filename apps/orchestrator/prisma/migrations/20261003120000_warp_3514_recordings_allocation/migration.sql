-- WARP-3514 / ADR-070 — auto-sized, quota-capped camera recordings allocation.
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces:
--   - StorageRole / AllocationMode / AllocationStatus enums
--   - StorageAllocation      the slice of an encrypted bay drive that holds
--                            camera recordings (one row per filesystem)
--   - CameraBitrateSample    hourly per-camera recording rate; the input to the
--                            allocator's sizing (kept 14 days, pruned by the
--                            sampler itself)
--   - RecordingsAlertCode enum + RecordingsAlertState
--                            per-condition outage state, so the owner is told
--                            once per outage and not once per hourly tick
--
-- Creates tables only. No existing row, column or retention window changes, and
-- NOTHING here moves or deletes footage: the allocator creates its first
-- StorageAllocation row at runtime, once an eligible (encrypted, prepared) drive
-- exists. On a box with no such drive the tables stay empty and recordings stay
-- where they are, reported as `no_eligible_drive`.
--
-- Ordering: sorts after 20261003000000_warp_3474_remove_security_doors_modules,
-- the chain tip this was cut from (handbook pr-review pattern P18).

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StorageRole') THEN
    CREATE TYPE "StorageRole" AS ENUM ('RECORDINGS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AllocationMode') THEN
    CREATE TYPE "AllocationMode" AS ENUM ('AUTO_RESERVED', 'FULL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AllocationStatus') THEN
    CREATE TYPE "AllocationStatus" AS ENUM ('PENDING', 'MIGRATING', 'ACTIVE', 'DEGRADED', 'MISSING');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RecordingsAlertCode') THEN
    CREATE TYPE "RecordingsAlertCode" AS ENUM ('DRIVE_MISSING', 'READ_ONLY', 'ON_SYSTEM_DISK', 'NEAR_FULL', 'CANNOT_GROW', 'SMART_FAILED', 'NOT_ENCRYPTED');
  END IF;
END$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "StorageAllocation" (
    "id" TEXT NOT NULL,
    "fsUuid" TEXT NOT NULL,
    "role" "StorageRole" NOT NULL DEFAULT 'RECORDINGS',
    "mode" "AllocationMode" NOT NULL DEFAULT 'AUTO_RESERVED',
    "reservedBytes" BIGINT NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'PENDING',
    "migrationFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CameraBitrateSample" (
    "id" TEXT NOT NULL,
    "camera" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mbPerHour" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "CameraBitrateSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RecordingsAlertState" (
    "code" "RecordingsAlertCode" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "since" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingsAlertState_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StorageAllocation_fsUuid_key" ON "StorageAllocation"("fsUuid");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StorageAllocation_role_status_idx" ON "StorageAllocation"("role", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CameraBitrateSample_camera_sampledAt_idx" ON "CameraBitrateSample"("camera", "sampledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CameraBitrateSample_sampledAt_idx" ON "CameraBitrateSample"("sampledAt");
