-- WARP-3176 — record each HANDING_OVER / PURGING claim explicitly (when; for
-- a hand-over also what it replaced and to whom), so a claim orphaned by an
-- orchestrator crash can be found by age and released, and a live claim is
-- never taken over. See User.deletionClaimedAt.
ALTER TABLE "User"
  ADD COLUMN "deletionClaimedAt" TIMESTAMP(3),
  ADD COLUMN "handoverPriorStatus" "UserDeletionStatus",
  ADD COLUMN "handoverRecipientId" TEXT;

-- Claims taken before these columns existed: start their clock now, so the
-- sweep / nightly retry picks them up once the stale window passes.
UPDATE "User" SET "deletionClaimedAt" = CURRENT_TIMESTAMP
WHERE "deletionStatus" = 'PURGING';

-- A hand-over claim's prior value was not recorded; a scheduled retention
-- delete is the only state that carries a due date, so restore that, else NONE.
UPDATE "User"
SET "deletionClaimedAt" = CURRENT_TIMESTAMP,
    "handoverPriorStatus" = CASE WHEN "deletionDueAt" IS NOT NULL
                                 THEN 'PENDING'::"UserDeletionStatus"
                                 ELSE 'NONE'::"UserDeletionStatus" END
WHERE "deletionStatus" = 'HANDING_OVER';
