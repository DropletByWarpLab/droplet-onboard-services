ALTER TABLE "Extension" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'extension',
  ADD COLUMN "appRelayKeyEnc" TEXT, ADD COLUMN "lastHealthAt" TIMESTAMP(3);
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_kind_check" CHECK ("kind" IN ('extension','app'));
ALTER TABLE "WorkshopWorkspace" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'extension';
ALTER TABLE "WorkshopWorkspace" ADD CONSTRAINT "WorkshopWorkspace_kind_check" CHECK ("kind" IN ('extension','app'));
CREATE TABLE "HostedAppGrant" (
  "extensionId" TEXT NOT NULL REFERENCES "Extension"("id") ON DELETE CASCADE,
  "role" "Role" NOT NULL,
  PRIMARY KEY ("extensionId", "role"),
  CONSTRAINT "HostedAppGrant_role_check" CHECK ("role" = 'family')
);
CREATE TABLE "HostedAppSessionCode" (
  "codeHash" TEXT PRIMARY KEY,
  "extensionId" TEXT NOT NULL REFERENCES "Extension"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HostedAppSessionCode_expiresAt_idx" ON "HostedAppSessionCode"("expiresAt");
