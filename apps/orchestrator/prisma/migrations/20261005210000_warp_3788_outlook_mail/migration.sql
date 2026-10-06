-- CreateEnum
CREATE TYPE "CloudMailSyncState" AS ENUM ('DISCONNECTED', 'WAITING', 'CONNECTED', 'NEEDS_RECONNECT', 'ERROR');

-- AlterEnum
ALTER TYPE "MailboxAuthMode" ADD VALUE 'M365_GRAPH';

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "externalAttachmentMetadata" JSONB,
ADD COLUMN     "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "internetMessageId" TEXT,
ADD COLUMN     "providerMessageId" TEXT;

-- AlterTable
ALTER TABLE "M365Connection" ADD COLUMN     "emailAccountId" TEXT,
ADD COLUMN     "mailEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mailSyncState" "CloudMailSyncState" NOT NULL DEFAULT 'DISCONNECTED';

-- CreateTable
CREATE TABLE "M365MailFolder" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "externalSyncRun" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "M365MailFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "M365MailMembership" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "externalSeenRun" TEXT,

    CONSTRAINT "M365MailMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "M365MailFolder_accountId_folderId_key" ON "M365MailFolder"("accountId", "folderId");

-- CreateIndex
CREATE INDEX "M365MailMembership_messageId_idx" ON "M365MailMembership"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "M365MailMembership_accountId_folderId_providerMessageId_key" ON "M365MailMembership"("accountId", "folderId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_accountId_providerMessageId_key" ON "EmailMessage"("accountId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "M365Connection_emailAccountId_key" ON "M365Connection"("emailAccountId");

-- AddForeignKey
ALTER TABLE "M365Connection" ADD CONSTRAINT "M365Connection_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "M365MailFolder" ADD CONSTRAINT "M365MailFolder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "M365MailMembership" ADD CONSTRAINT "M365MailMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "M365MailMembership" ADD CONSTRAINT "M365MailMembership_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Cast to text so this migration can run in one transaction immediately after ADD VALUE.
ALTER TABLE "EmailAccount" DROP CONSTRAINT "EmailAccount_auth_credential_check";
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_auth_credential_check" CHECK (
  ("authMode"::text = 'PASSWORD' AND "passwordEnc" IS NOT NULL) OR
  ("authMode"::text IN ('GOOGLE_OAUTH', 'M365_GRAPH') AND "passwordEnc" IS NULL AND "userId" IS NOT NULL)
);
