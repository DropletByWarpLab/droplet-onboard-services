-- WARP-233 — app-layer column encryption plumbing.
CREATE TABLE "DocumentEncryptionKey" (
    "keyId" TEXT NOT NULL,
    "wrappedDek" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentEncryptionKey_pkey" PRIMARY KEY ("keyId")
);

CREATE TYPE "ChunkSensitivity" AS ENUM ('standard', 'sensitive');

ALTER TABLE "FileContentChunk"
    ADD COLUMN "sensitivity" "ChunkSensitivity" NOT NULL DEFAULT 'standard';
CREATE INDEX "FileContentChunk_userId_sensitivity_idx"
    ON "FileContentChunk" ("userId", "sensitivity");

-- email uniqueness moves to the blind index (ciphertext is non-deterministic).
ALTER TABLE "User" ADD COLUMN "emailLookupHash" TEXT;
CREATE UNIQUE INDEX "User_emailLookupHash_key" ON "User" ("emailLookupHash");
DROP INDEX "User_email_key";
-- Plaintext emails remain until apps/orchestrator/scripts/encrypt-existing-phi-columns.ts
-- backfills (idempotent; see docs/POSTGRES_TLS_AND_COLUMN_ENCRYPTION.md). Readers
-- accept both forms via the explicit dcv1: format marker during the transition.
