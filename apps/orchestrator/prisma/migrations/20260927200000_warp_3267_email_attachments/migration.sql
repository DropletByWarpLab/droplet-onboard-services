-- WARP-3267 — inbound email attachments (bytes in box storage, see the
-- EmailAttachment model comment for the ruling) and the ids a forward carries.
-- Additive only: a new table and enum, and a defaulted column on EmailDraft.

-- CreateEnum
CREATE TYPE "EmailAttachmentStatus" AS ENUM ('stored', 'too_large', 'over_limit');

-- AlterTable
ALTER TABLE "EmailDraft" ADD COLUMN     "attachmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "EmailAttachment" (
    "id" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "contentId" TEXT,
    "status" "EmailAttachmentStatus" NOT NULL,
    "data" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailAttachment_accountId_idx" ON "EmailAttachment"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAttachment_emailMessageId_partIndex_key" ON "EmailAttachment"("emailMessageId", "partIndex");

-- AddForeignKey
ALTER TABLE "EmailAttachment" ADD CONSTRAINT "EmailAttachment_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

