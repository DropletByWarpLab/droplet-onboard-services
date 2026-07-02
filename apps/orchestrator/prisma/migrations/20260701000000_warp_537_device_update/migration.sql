-- CreateEnum
CREATE TYPE "DeviceUpdateStatus" AS ENUM ('pending', 'superseded', 'verifying', 'applying', 'committed', 'rolled_back', 'failed', 'rejected');

-- CreateTable
CREATE TABLE "DeviceUpdate" (
    "id" TEXT NOT NULL,
    "status" "DeviceUpdateStatus" NOT NULL DEFAULT 'pending',
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "releaseTag" TEXT,
    "gitSha" TEXT NOT NULL,
    "builtAt" TIMESTAMP(3) NOT NULL,
    "manifestSha256" TEXT NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceUpdate_status_createdAt_idx" ON "DeviceUpdate"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceUpdate_gitSha_idx" ON "DeviceUpdate"("gitSha");

