-- WARP-3533 — ICS feeds for Projects, personal API tokens, OpenAPI (ADR-069 WS-17).
--
-- PmApiToken: a per-person bearer credential (`dpm_…`) for /api/pm and
-- /api/support. Only sha256 of the full token is stored, so neither a database
-- read nor a backup yields a working token. Status is an explicit enum
-- (active | revoked | expired), never derived from the timestamps. `scopes` is
-- text[] with a CHECK for the vocabulary; `issuedRole` pins the role the token
-- was minted under (a role change ends it). Rows cascade with the owning User.
--
-- CalendarFeedToken gains `scope` (+ `projectId` for a project feed) so one
-- credential mechanism serves three feeds: the person's calendar (every row
-- that exists today, by the column default), "my work", and one project. A
-- link reads ONLY its own feed.
--
-- The box-wide switch for API tokens is not here: it is the
-- `workspace.api_tokens_enabled` WorkspaceSetting, seeded OFF at boot by
-- seedWorkspaceSettings (insert-or-skip, like every other setting), so a fresh
-- box and an OTA-updated box both get it switched off with no manual step.
--
-- Additive only: no existing column or row changes meaning.
--
-- RE-RUNNABLE (the repo idiom; branch migrations are re-stamped before
-- merge): enums in DO blocks that swallow duplicate_object, tables, columns
-- and indexes IF NOT EXISTS, foreign keys and CHECKs only when pg_constraint
-- lacks them.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "PmApiTokenStatus" AS ENUM ('active', 'revoked', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "PmApiTokenRevokeReason" AS ENUM ('manual', 'user_deactivated', 'role_changed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "CalendarFeedTokenScope" AS ENUM ('calendar', 'pm_my_work', 'pm_project');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PmApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "issuedRole" "Role" NOT NULL,
    "status" "PmApiTokenStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "PmApiTokenRevokeReason",
    "revokedById" TEXT,
    "refusalAuditedAt" TIMESTAMP(3),

    CONSTRAINT "PmApiToken_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CalendarFeedToken" ADD COLUMN IF NOT EXISTS "scope" "CalendarFeedTokenScope" NOT NULL DEFAULT 'calendar';
ALTER TABLE "CalendarFeedToken" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PmApiToken_hash_key" ON "PmApiToken"("hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PmApiToken_userId_status_idx" ON "PmApiToken"("userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarFeedToken_projectId_idx" ON "CalendarFeedToken"("projectId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PmApiToken_userId_fkey' AND conrelid = '"PmApiToken"'::regclass) THEN
    ALTER TABLE "PmApiToken" ADD CONSTRAINT "PmApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CalendarFeedToken_projectId_fkey' AND conrelid = '"CalendarFeedToken"'::regclass) THEN
    ALTER TABLE "CalendarFeedToken" ADD CONSTRAINT "CalendarFeedToken_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- The scope vocabulary, and "at least one". The service validates the same
-- list; this is the database refusing a writer that does not.
--
-- `"scopes" IS NOT NULL` is part of the test on purpose: a CHECK passes when its
-- expression is NULL, and `cardinality(NULL)` is NULL, so without it a row with no
-- scopes value at all would be accepted. (Prisma declares a scalar list nullable at
-- the database, so the column cannot simply be NOT NULL without drifting from
-- schema.prisma.) Dropped first so a database that already carries the earlier,
-- weaker definition converges to this one.
DO $$
BEGIN
  ALTER TABLE "PmApiToken" DROP CONSTRAINT IF EXISTS "PmApiToken_scopes_valid";
  ALTER TABLE "PmApiToken" ADD CONSTRAINT "PmApiToken_scopes_valid"
    CHECK ("scopes" IS NOT NULL AND cardinality("scopes") > 0 AND "scopes" <@ ARRAY['pm:read', 'pm:write', 'support:read', 'support:write']::text[]);
END $$;

-- An external guest or a service principal never holds a token.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PmApiToken_role_may_hold' AND conrelid = '"PmApiToken"'::regclass) THEN
    ALTER TABLE "PmApiToken" ADD CONSTRAINT "PmApiToken_role_may_hold"
      CHECK ("issuedRole" IN ('owner', 'admin', 'family'));
  END IF;
END $$;

-- `revoked` and its two facts travel together: no revoked row without a time
-- and a reason, and no time or reason on a row that is not revoked.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PmApiToken_revoked_coherent' AND conrelid = '"PmApiToken"'::regclass) THEN
    ALTER TABLE "PmApiToken" ADD CONSTRAINT "PmApiToken_revoked_coherent"
      CHECK (("status" = 'revoked') = ("revokedAt" IS NOT NULL AND "revokedReason" IS NOT NULL)
             AND ("status" = 'revoked' OR ("revokedAt" IS NULL AND "revokedReason" IS NULL AND "revokedById" IS NULL)));
  END IF;
END $$;

-- A project feed names its project; every other feed names none.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CalendarFeedToken_project_scope_coherent' AND conrelid = '"CalendarFeedToken"'::regclass) THEN
    ALTER TABLE "CalendarFeedToken" ADD CONSTRAINT "CalendarFeedToken_project_scope_coherent"
      CHECK (("scope" = 'pm_project') = ("projectId" IS NOT NULL));
  END IF;
END $$;
