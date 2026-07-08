-- WARP-1094 — ERP-connector framework (Eaglesoft direct-SQL integration).
-- DB-independent Prisma foundation (brief §12): control-plane models for the
-- connection lifecycle, incremental-sync cursor, read-model cache, staged
-- write outbox, and append-only PHI audit log. Every lifecycle state is an
-- explicit enum column (architecture-guard rule 10 / WARP-218) — never
-- derived from NULL. `secretRef` is a pointer into the encrypted secret store;
-- no credential is ever persisted here (brief §7.4). No seed data.

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'PROVISIONING', 'CONNECTED', 'DEGRADED', 'DRIFT_LOCKED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "WriteStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED', 'APPLYING', 'APPLIED', 'DISCREPANCY', 'FAILED', 'REVERSED', 'REJECTED');

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "host" TEXT NOT NULL,
    "databaseName" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "schemaVersion" TEXT,
    "schemaHash" TEXT,
    "writeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastHealthyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpSyncCursor" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "watermark" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpSyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpEntityCache" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpEntityCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpWriteRequest" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "WriteStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "requestedBy" TEXT NOT NULL,
    "confirmedBy" TEXT,
    "reversal" JSONB,
    "discrepancy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpWriteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpAuditLog" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationConnection_provider_status_idx" ON "IntegrationConnection"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ErpSyncCursor_connectionId_entity_key" ON "ErpSyncCursor"("connectionId", "entity");

-- CreateIndex
CREATE INDEX "ErpEntityCache_connectionId_entity_idx" ON "ErpEntityCache"("connectionId", "entity");

-- CreateIndex
CREATE UNIQUE INDEX "ErpEntityCache_connectionId_entity_sourceKey_key" ON "ErpEntityCache"("connectionId", "entity", "sourceKey");

-- CreateIndex
CREATE INDEX "ErpWriteRequest_connectionId_status_idx" ON "ErpWriteRequest"("connectionId", "status");

-- CreateIndex
CREATE INDEX "ErpAuditLog_connectionId_at_idx" ON "ErpAuditLog"("connectionId", "at");
