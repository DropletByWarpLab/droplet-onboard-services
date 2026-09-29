-- WARP-3113 — leaver deletion: Delete schedules a 30-day retention instead of
-- purging a person's files on the spot. See User.deletionStatus.
CREATE TYPE "UserDeletionStatus" AS ENUM ('NONE', 'PENDING', 'PURGING');

ALTER TABLE "User"
  ADD COLUMN "deletionStatus" "UserDeletionStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "deletionDueAt" TIMESTAMP(3),
  ADD COLUMN "deletionRequestedBy" TEXT;
