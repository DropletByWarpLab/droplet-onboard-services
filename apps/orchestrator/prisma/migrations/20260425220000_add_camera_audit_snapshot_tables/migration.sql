-- DropIndex
DROP INDEX "FileContentChunk_embedding_idx";

-- CreateTable
CREATE TABLE "CommandAuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "entityId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "data" JSONB,
    "tier" INTEGER NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkConfigSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "config" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "operation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetworkConfigSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "ipAddress" TEXT NOT NULL,
    "macAddress" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoDiscovered" BOOLEAN NOT NULL DEFAULT false,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraNotificationPref" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "onPerson" BOOLEAN NOT NULL DEFAULT true,
    "onVehicle" BOOLEAN NOT NULL DEFAULT true,
    "onAnimal" BOOLEAN NOT NULL DEFAULT false,
    "onMotion" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CameraNotificationPref_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommandAuditLog_entityId_createdAt_idx" ON "CommandAuditLog"("entityId", "createdAt");

-- CreateIndex
CREATE INDEX "CommandAuditLog_userId_createdAt_idx" ON "CommandAuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CommandAuditLog_domain_createdAt_idx" ON "CommandAuditLog"("domain", "createdAt");

-- CreateIndex
CREATE INDEX "NetworkConfigSnapshot_config_createdAt_idx" ON "NetworkConfigSnapshot"("config", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Camera_name_key" ON "Camera"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CameraNotificationPref_userId_cameraId_key" ON "CameraNotificationPref"("userId", "cameraId");

-- AddForeignKey
ALTER TABLE "CameraNotificationPref" ADD CONSTRAINT "CameraNotificationPref_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

