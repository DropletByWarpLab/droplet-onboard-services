-- WARP-2729 (ADR-048) — the filing ledger.
--
-- The two rows that already say "new content exists" become the queue. No
-- shadow queue table: WARP-2587 put `notifyStatus` on the activity tables
-- rather than adding an event log, and a parallel queue is a second source of
-- truth for the same fact.
--
-- 🔴 EVERY COLUMN ADDED HERE IS NULLABLE OR CARRIES A POSTGRES DEFAULT.
--
-- `services/file-indexer/db.py set_index_status` INSERTs FileIndexStatus naming
-- its columns explicitly, so a column it never writes is filled by Postgres —
-- which is what lets this land with ZERO Python change and no ordering
-- dependency between a Prisma migration and a file-indexer image release. An
-- unknown column there would kill ALL indexing, not just filing, and it would
-- do it SILENTLY: `watcher.py _set_status` swallows every DB exception at
-- `logger.debug` under the default LOG_LEVEL=INFO.
--
-- Note this is a property of DB-level defaults specifically. Prisma's
-- client-side defaults (`@default(uuid())`, `@default(cuid())`, `@updatedAt`)
-- emit no DEFAULT at all — see `Device.id` / `Device.updatedAt` in the init
-- migration — so a NOT NULL column of that shape would break the Python writer.

-- CreateEnum
CREATE TYPE "ExtractStatus" AS ENUM ('pending', 'running', 'done', 'skipped', 'failed', 'not_needed');

-- CreateEnum
CREATE TYPE "ExtractReason" AS ENUM ('phi_record', 'phi_path', 'not_business', 'too_large', 'bad_json', 'model_unreachable', 'cloud_model_refused', 'owner_unavailable', 'out_of_scope', 'ignored_by_you', 'stale_claim', 'backlog', 'unchanged');

-- AlterTable
ALTER TABLE "FileIndexStatus" ADD COLUMN     "extractStatus" "ExtractStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "extractClaimedAt" TIMESTAMP(3),
ADD COLUMN     "extractAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extractReason" "ExtractReason",
ADD COLUMN     "extractedAt" TIMESTAMP(3),
ADD COLUMN     "extractedFromUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "extractFingerprint" TEXT;

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "extractStatus" "ExtractStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "extractClaimedAt" TIMESTAMP(3),
ADD COLUMN     "extractAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extractReason" "ExtractReason",
ADD COLUMN     "extractedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "FileIndexStatus_extractStatus_updatedAt_idx" ON "FileIndexStatus"("extractStatus", "updatedAt");

-- CreateIndex
CREATE INDEX "EmailMessage_extractStatus_receivedAt_idx" ON "EmailMessage"("extractStatus", "receivedAt");

-- Backfill. LOAD-BEARING, not hygiene.
--
-- Both columns above default to 'pending', so without this every row that
-- already exists on the box becomes claimable the moment filing is switched on
-- — and a three-year corpus would be extracted overnight, one LLM call at a
-- time, on a CPU box sharing its inference slot with interactive chat.
--
-- `backlog` is deliberately NOT in the sticky-reason set: a file the owner
-- re-saves bumps `updatedAt`, and the re-arm arm then picks it up normally.
-- "Look through what is already here" is a separate, bounded, explicit owner
-- action (a 90-day window, shipped in WARP-2731), never an implicit one.
UPDATE "FileIndexStatus"
   SET "extractStatus"          = 'not_needed',
       "extractReason"          = 'backlog',
       "extractedAt"            = "updatedAt",
       "extractedFromUpdatedAt" = "updatedAt";

UPDATE "EmailMessage"
   SET "extractStatus" = 'not_needed',
       "extractReason" = 'backlog',
       "extractedAt"   = "createdAt";

-- A terminal status and a terminal timestamp move together, in both directions.
--
-- Without the "only if" half a row could carry `extractedAt` while still
-- pending, which would make the re-arm comparison read a watermark from an
-- extraction that never finished. Written as an equality of two booleans so
-- neither direction can be forgotten.
ALTER TABLE "FileIndexStatus"
  ADD CONSTRAINT "FileIndexStatus_extract_terminal"
  CHECK (
    ("extractStatus" IN ('done', 'skipped', 'failed', 'not_needed'))
    = ("extractedAt" IS NOT NULL)
  );

ALTER TABLE "EmailMessage"
  ADD CONSTRAINT "EmailMessage_extract_terminal"
  CHECK (
    ("extractStatus" IN ('done', 'skipped', 'failed', 'not_needed'))
    = ("extractedAt" IS NOT NULL)
  );
