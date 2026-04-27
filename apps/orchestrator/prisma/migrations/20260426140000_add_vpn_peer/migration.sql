-- CreateTable
CREATE TABLE "VpnPeer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceLabel" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "assignedIp" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "VpnPeer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VpnPeer_publicKey_key" ON "VpnPeer"("publicKey");

-- CreateIndex
CREATE INDEX "VpnPeer_userId_idx" ON "VpnPeer"("userId");

-- CreateIndex
CREATE INDEX "VpnPeer_status_idx" ON "VpnPeer"("status");

-- CreateIndex
CREATE INDEX "VpnPeer_assignedIp_idx" ON "VpnPeer"("assignedIp");
