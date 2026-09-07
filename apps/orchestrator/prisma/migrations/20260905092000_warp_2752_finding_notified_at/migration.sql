-- WARP-2752 (ADR-051) -- `BrainFinding.notifiedAt`: when this finding was last
-- told to somebody.
--
-- A SEPARATE MIGRATION rather than an edit to 20260905090000, which created
-- the table earlier on this same branch. That migration is already pushed, so
-- somebody may have applied it; changing its body would change its checksum
-- and `prisma migrate` would refuse to run on their database. A new file
-- always applies cleanly, and the cost is one extra file.
--
-- WHY THE COLUMN EXISTS. The detector pass runs hourly. Without a record of
-- what has already been announced, the same overdue invoice is pushed to the
-- operator's phone every hour forever -- which is exactly how a nightly
-- feature earns a mute, and a muted feature is a deleted feature. NULL means
-- "nobody has been told", and that is the queue the digest drains.
--
-- DELIBERATELY NOT DERIVED FROM `status`. A finding can be acknowledged in the
-- UI without ever having been pushed anywhere, and re-notifying it at that
-- point tells someone what they are already looking at. Explicit column, the
-- no-guessing rule (canonical precedent WARP-218 `BrainMemoryItemStatus`).

-- AlterTable
ALTER TABLE "BrainFinding" ADD COLUMN "notifiedAt" TIMESTAMP(3);

-- CreateIndex
-- The notification queue reads `WHERE notifiedAt IS NULL AND status = 'new'`,
-- so the nullable column LEADS: Postgres indexes NULLs and this is the one
-- query where they are the rows being looked for.
CREATE INDEX "BrainFinding_notifiedAt_status_idx" ON "BrainFinding"("notifiedAt", "status");
