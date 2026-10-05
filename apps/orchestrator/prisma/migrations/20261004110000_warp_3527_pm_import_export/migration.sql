-- WARP-3527 (ADR-069 WS-11) — import and export for Projects.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmWorkItem.externalSystem / externalId — where an imported item came
--      from and its id there — and the unique index that makes a RE-import
--      update the item instead of creating a twin:
--          UNIQUE ("projectId", "externalSystem", "externalId")
--      Postgres treats NULLs as distinct in a unique index, so every natively
--      created item (both columns NULL) is unconstrained.
--
--   2. PmWorkItem_external_both_or_neither — a CHECK Prisma's schema language
--      cannot express. A half-set pair (a system with no id, an id with no
--      system) would never collide with anything and so could never be updated
--      by a re-import: the row would be a permanent duplicate-in-waiting. The
--      pair is either an identity or it is absent.
--
--   3. PmImportJob (+ PmImportJobFile, the uploaded bytes in their own 1:1 table
--      so a status poll can never drag a 10 MB blob along) with explicit enums
--      PmImportSource and PmImportJobStatus. Status is the state, never derived
--      from finishedAt.
--
--   4. Two more invariants, also invisible to `prisma migrate diff` (it ignores
--      partial indexes and CHECKs, so neither needs a drift-baseline entry):
--        * PmImportJob_projectId_active_key — UNIQUE ("projectId") WHERE status
--          IN ('PENDING','RUNNING'). One import at a time per project: two
--          concurrent runs would race the project's seqCounter row lock for the
--          whole duration of both and each other's parent links.
--        * PmImportJob_finished_matches_status — finishedAt is set exactly when
--          the status is terminal. Same shape as PmActivity_notifiedAt_matches_status
--          (WARP-2587): a timestamp pinned to the enum so neither can drift.
--
-- No enum VALUE is added to an existing type, so there is no companion
-- enum-only migration (the 20261004105900 slot stays unused).
--
-- RE-RUNNABLE (the repo idiom; branch migrations are re-stamped before merge):
-- enums in DO blocks that swallow duplicate_object, columns / tables / indexes
-- IF NOT EXISTS, constraints only when pg_constraint lacks them.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "PmImportSource" AS ENUM ('CSV', 'JIRA_CSV', 'ASANA_CSV', 'TRELLO_JSON', 'LINEAR_CSV', 'GITHUB_CSV');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "PmImportJobStatus" AS ENUM ('PENDING', 'PREVIEWED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "PmWorkItem" ADD COLUMN IF NOT EXISTS "externalSystem" TEXT;
ALTER TABLE "PmWorkItem" ADD COLUMN IF NOT EXISTS "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PmWorkItem_projectId_externalSystem_externalId_key"
  ON "PmWorkItem"("projectId", "externalSystem", "externalId");

-- CHECK: both or neither
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PmWorkItem_external_both_or_neither' AND conrelid = '"PmWorkItem"'::regclass
  ) THEN
    ALTER TABLE "PmWorkItem"
      ADD CONSTRAINT "PmWorkItem_external_both_or_neither"
      CHECK (("externalSystem" IS NULL) = ("externalId" IS NULL));
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PmImportJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "PmImportSource" NOT NULL,
    "status" "PmImportJobStatus" NOT NULL DEFAULT 'PREVIEWED',
    "fileName" TEXT NOT NULL,
    "fileBytes" INTEGER NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PmImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PmImportJobFile" (
    "jobId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,

    CONSTRAINT "PmImportJobFile_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PmImportJob_projectId_createdAt_idx" ON "PmImportJob"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PmImportJob_status_updatedAt_idx" ON "PmImportJob"("status", "updatedAt");

-- INVARIANT: at most one active (PENDING | RUNNING) import per project.
CREATE UNIQUE INDEX IF NOT EXISTS "PmImportJob_projectId_active_key"
  ON "PmImportJob"("projectId")
  WHERE "status" IN ('PENDING', 'RUNNING');

-- INVARIANT: finishedAt is set exactly when the status is terminal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PmImportJob_finished_matches_status' AND conrelid = '"PmImportJob"'::regclass
  ) THEN
    ALTER TABLE "PmImportJob"
      ADD CONSTRAINT "PmImportJob_finished_matches_status"
      CHECK (("finishedAt" IS NOT NULL) = ("status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')));
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PmImportJob_projectId_fkey' AND conrelid = '"PmImportJob"'::regclass) THEN
    ALTER TABLE "PmImportJob" ADD CONSTRAINT "PmImportJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PmImportJobFile_jobId_fkey' AND conrelid = '"PmImportJobFile"'::regclass) THEN
    ALTER TABLE "PmImportJobFile" ADD CONSTRAINT "PmImportJobFile_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PmImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
