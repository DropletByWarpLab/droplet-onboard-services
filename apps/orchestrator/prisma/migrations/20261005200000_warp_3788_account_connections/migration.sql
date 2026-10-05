CREATE TYPE "MailboxAuthMode" AS ENUM ('PASSWORD', 'GOOGLE_OAUTH');
ALTER TABLE "EmailAccount" ALTER COLUMN "passwordEnc" DROP NOT NULL;
ALTER TABLE "EmailAccount" ADD COLUMN "authMode" "MailboxAuthMode" NOT NULL DEFAULT 'PASSWORD';
CREATE TYPE "CloudOAuthProvider" AS ENUM ('GOOGLE', 'MICROSOFT');
CREATE TABLE "CloudOAuthApp" (
  "provider" "CloudOAuthProvider" NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL,
  "tenantId" TEXT,
  "clientSecretEnc" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TYPE "GoogleConnectionState" AS ENUM ('DISCONNECTED', 'PENDING_CONSENT', 'CONNECTED', 'NEEDS_RECONNECT', 'ERROR');
CREATE TYPE "CloudCalendarSyncState" AS ENUM ('DISCONNECTED', 'WAITING', 'CONNECTED', 'NEEDS_RECONNECT', 'ERROR');
CREATE TABLE "GoogleConnection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "state" "GoogleConnectionState" NOT NULL DEFAULT 'DISCONNECTED',
  "mailEnabled" BOOLEAN NOT NULL DEFAULT true,
  "calendarEnabled" BOOLEAN NOT NULL DEFAULT false,
  "calendarSyncState" "CloudCalendarSyncState" NOT NULL DEFAULT 'DISCONNECTED',
  "calendarSourceId" TEXT,
  "accountAddress" TEXT,
  "emailAccountId" TEXT,
  "tokenEnc" TEXT,
  "pendingStateHash" TEXT,
  "pendingFlowEnc" TEXT,
  "pendingExpiresAt" TIMESTAMP(3),
  "connectedAt" TIMESTAMP(3),
  "lastRefreshOkAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoogleConnection_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "GoogleConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GoogleConnection_calendarSourceId_fkey" FOREIGN KEY ("calendarSourceId") REFERENCES "CalendarSource"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GoogleConnection_userId_key" ON "GoogleConnection"("userId");
CREATE UNIQUE INDEX "GoogleConnection_emailAccountId_key" ON "GoogleConnection"("emailAccountId");
CREATE UNIQUE INDEX "GoogleConnection_pendingStateHash_key" ON "GoogleConnection"("pendingStateHash");
CREATE UNIQUE INDEX "GoogleConnection_calendarSourceId_key" ON "GoogleConnection"("calendarSourceId");
ALTER TABLE "M365Connection" ADD COLUMN "calendarEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "calendarSyncState" "CloudCalendarSyncState" NOT NULL DEFAULT 'DISCONNECTED',
  ADD COLUMN "calendarSourceId" TEXT;
CREATE UNIQUE INDEX "M365Connection_calendarSourceId_key" ON "M365Connection"("calendarSourceId");
ALTER TABLE "M365Connection" ADD CONSTRAINT "M365Connection_calendarSourceId_fkey" FOREIGN KEY ("calendarSourceId") REFERENCES "CalendarSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CalendarEvent" ADD COLUMN "externalSeenRun" TEXT;
ALTER TABLE "CalendarSource" ADD COLUMN "externalSyncRun" TEXT,
  ADD COLUMN "externalWindowStart" TIMESTAMP(3), ADD COLUMN "externalWindowEnd" TIMESTAMP(3);
-- Preserve the invariant the legacy transports relied on, while allowing explicit OAuth mailboxes.
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_auth_credential_check" CHECK (
  ("authMode" = 'PASSWORD' AND "passwordEnc" IS NOT NULL) OR
  ("authMode" = 'GOOGLE_OAUTH' AND "passwordEnc" IS NULL AND "userId" IS NOT NULL)
);
