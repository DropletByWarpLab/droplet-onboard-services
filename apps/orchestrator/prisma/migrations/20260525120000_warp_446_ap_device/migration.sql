-- WARP-446: ApDevice + ApDeviceStatus enum for the coverage-extender
-- onboarding lifecycle. See docs/ADR-005-ap-auto-onboarding.md for the
-- decision record; the schema mirrors the model block in schema.prisma.
--
-- Idempotency: the enum CREATE is wrapped in DO/EXCEPTION the same way
-- the WARP-171 Role and WARP-218 BrainMemoryItemStatus migrations are.
-- Re-running this migration on a converged DB is a no-op (the IF NOT
-- EXISTS on the table, plus the EXCEPTION on the enum, plus
-- CREATE INDEX IF NOT EXISTS guards on the indexes).
--
-- No seed data — the table is populated at runtime by the orchestrator's
-- mDNS discovery poller as extender APs announce themselves.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "ApDeviceStatus" AS ENUM (
        'DISCOVERED',
        'AWAITING_APPROVAL',
        'PROVISIONING',
        'ONLINE',
        'FAILED',
        'DECOMMISSIONED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Table ──

CREATE TABLE IF NOT EXISTS "ApDevice" (
    "mac" TEXT NOT NULL,
    "displayName" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "version" TEXT,
    "lastIp" TEXT,
    "hostname" TEXT,
    "status" "ApDeviceStatus" NOT NULL DEFAULT 'DISCOVERED',
    "failureReason" TEXT,
    "approvedSsid" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "decommissionedAt" TIMESTAMP(3),
    "lastOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApDevice_pkey" PRIMARY KEY ("mac")
);

-- ── Indexes ──

CREATE INDEX IF NOT EXISTS "ApDevice_status_idx" ON "ApDevice"("status");
CREATE INDEX IF NOT EXISTS "ApDevice_lastSeen_idx" ON "ApDevice"("lastSeen");
