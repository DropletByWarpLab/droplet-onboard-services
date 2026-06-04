-- BUG-3 / ADR-019: software-RAID (mdadm) storage pool management.
--
-- Adds StoragePool + PoolMember and the explicit state enums
-- PoolStatus / DiskRole / ArrayLevel (handbook rule 10 — state is explicit,
-- never derived from absence; canonical precedent WARP-218
-- BrainMemoryItemStatus).
--
-- Pools are OPTIONAL and owner-driven. This migration SEEDS NOTHING — a fresh
-- box has zero pools and runs fine. Nothing auto-creates a pool.
--
-- Re-runnable: every CREATE TYPE is guarded by DO/EXCEPTION (duplicate_object)
-- and every table/index uses IF NOT EXISTS, so re-running on a populated db is
-- a no-op and must not change row counts.

BEGIN;

-- ── Enums (guarded so a re-run is idempotent) ──

DO $$ BEGIN
    CREATE TYPE "PoolStatus" AS ENUM (
        'active',
        'degraded',
        'resyncing',
        'failed',
        'none'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "DiskRole" AS ENUM (
        'active',
        'spare',
        'failed',
        'unassigned'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ArrayLevel" AS ENUM (
        'raid0',
        'raid1',
        'raid5',
        'raid6',
        'raid10',
        'jbod'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── StoragePool ──

CREATE TABLE IF NOT EXISTS "StoragePool" (
    "device"      TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "level"       "ArrayLevel" NOT NULL,
    "status"      "PoolStatus" NOT NULL DEFAULT 'none',
    "notes"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoragePool_pkey" PRIMARY KEY ("device")
);

CREATE INDEX IF NOT EXISTS "StoragePool_status_idx"
    ON "StoragePool"("status");

-- ── PoolMember ──

CREATE TABLE IF NOT EXISTS "PoolMember" (
    "id"         TEXT NOT NULL,
    "poolDevice" TEXT NOT NULL,
    "device"     TEXT NOT NULL,
    "uuid"       TEXT,
    "role"       "DiskRole" NOT NULL DEFAULT 'unassigned',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PoolMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PoolMember_poolDevice_device_key"
    ON "PoolMember"("poolDevice", "device");

CREATE INDEX IF NOT EXISTS "PoolMember_poolDevice_idx"
    ON "PoolMember"("poolDevice");

-- FK: drop-then-add guarded so a re-run doesn't error on the existing
-- constraint (ADD CONSTRAINT has no IF NOT EXISTS in this PG version).
DO $$ BEGIN
    ALTER TABLE "PoolMember"
        ADD CONSTRAINT "PoolMember_poolDevice_fkey"
        FOREIGN KEY ("poolDevice") REFERENCES "StoragePool"("device")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

COMMIT;
