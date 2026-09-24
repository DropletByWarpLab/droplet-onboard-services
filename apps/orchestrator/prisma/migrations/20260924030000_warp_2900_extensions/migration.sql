-- WARP-2900 (ADR-056 slice H2) — promoted extensions.
--
-- `Extension` is one row per workshop workspace an owner promoted, keyed by
-- its slug (deriveExtensionSlug: <= 27 chars so "ext-" + slug fits the
-- multiplexer's 32-char server id). `ExtensionVersion` keeps every signed
-- statement EXACTLY as signed (statementBytes, the base64 signature, the
-- signer and the signing key's fingerprint) with the manifest bytes it
-- names, so every install re-verifies the stored bytes and never re-derives
-- them. `status` is an explicit enum; nothing is inferred from a NULL.
--
-- `serviceTokenHash` holds the sha256 of the extension's call-back bearer
-- (rotated on every start, cleared on stop); unique so a presented bearer
-- resolves to at most one extension.
--
-- `RemoteToolClassification.inputSchemaHash` lets a re-discovered tool keep
-- its reviewed classification only while its input schema is unchanged (H3).
-- Nullable: every existing row predates it.

-- CreateEnum
CREATE TYPE "ExtensionStatus" AS ENUM ('signed', 'installed', 'live', 'disabled', 'failed', 'uninstalled');

-- CreateEnum
CREATE TYPE "ExtensionSigner" AS ENUM ('box', 'release');

-- AlterTable
ALTER TABLE "RemoteToolClassification" ADD COLUMN     "inputSchemaHash" TEXT;

-- CreateTable
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "installedByUserId" TEXT NOT NULL,
    "status" "ExtensionStatus" NOT NULL DEFAULT 'signed',
    "operatorDomain" TEXT,
    "currentVersionId" TEXT,
    "serviceTokenHash" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionVersion" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    "tree" TEXT NOT NULL,
    "manifestBytes" BYTEA NOT NULL,
    "manifestSha256" TEXT NOT NULL,
    "statementBytes" BYTEA NOT NULL,
    "signature" TEXT NOT NULL,
    "signer" "ExtensionSigner" NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "promotedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Extension_workspaceId_key" ON "Extension"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Extension_currentVersionId_key" ON "Extension"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Extension_serviceTokenHash_key" ON "Extension"("serviceTokenHash");

-- CreateIndex
CREATE INDEX "Extension_status_idx" ON "Extension"("status");

-- CreateIndex
CREATE INDEX "ExtensionVersion_extensionId_createdAt_idx" ON "ExtensionVersion"("extensionId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionVersion_extensionId_version_key" ON "ExtensionVersion"("extensionId", "version");

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ExtensionVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionVersion" ADD CONSTRAINT "ExtensionVersion_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

