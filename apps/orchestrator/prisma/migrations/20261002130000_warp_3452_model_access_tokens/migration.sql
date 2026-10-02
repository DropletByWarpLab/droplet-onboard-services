-- WARP-3452 — coding-tool tokens for the local model API (`https://<box>/llm/`).
--
-- ModelAccessToken: a per-person bearer credential (`dlk_…`). Only sha256 of
-- the full token is stored, so neither a database read nor a backup yields a
-- working token. Status is an explicit enum (active | revoked | expired),
-- never derived from the timestamps. Rows cascade with the owning User.
--
-- ModelAccessTokenUsage: per-token, per-day counters (requests, prompt and
-- completion tokens, errors). Counts only — no prompt or completion content.
--
-- The box-wide switch is not here: it is the `ai.llm_access.enabled`
-- WorkspaceSetting, seeded OFF at boot by seedWorkspaceSettings (insert-or-skip,
-- like every other setting), so a fresh box and an OTA-updated box both get it
-- switched off with no manual step.
--
-- RE-RUNNABLE (the repo idiom; branch migrations are re-stamped before
-- merge): enums in DO blocks that swallow duplicate_object, tables and indexes
-- IF NOT EXISTS, foreign keys only when pg_constraint lacks them.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "ModelAccessTokenStatus" AS ENUM ('active', 'revoked', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "ModelAccessTokenRevokeReason" AS ENUM ('manual', 'user_deactivated', 'role_guest');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ModelAccessToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "status" "ModelAccessTokenStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "ModelAccessTokenRevokeReason",
    "revokedById" TEXT,
    "refusalAuditedAt" TIMESTAMP(3),

    CONSTRAINT "ModelAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ModelAccessTokenUsage" (
    "tokenId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ModelAccessTokenUsage_pkey" PRIMARY KEY ("tokenId","day")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ModelAccessToken_secretHash_key" ON "ModelAccessToken"("secretHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ModelAccessToken_userId_status_idx" ON "ModelAccessToken"("userId", "status");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ModelAccessToken_userId_fkey' AND conrelid = '"ModelAccessToken"'::regclass) THEN
    ALTER TABLE "ModelAccessToken" ADD CONSTRAINT "ModelAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ModelAccessTokenUsage_tokenId_fkey' AND conrelid = '"ModelAccessTokenUsage"'::regclass) THEN
    ALTER TABLE "ModelAccessTokenUsage" ADD CONSTRAINT "ModelAccessTokenUsage_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ModelAccessToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
