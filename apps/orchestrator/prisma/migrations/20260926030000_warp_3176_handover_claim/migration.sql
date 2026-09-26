-- WARP-3176 — record a hand-over's HANDING_OVER claim explicitly (when, what
-- it replaced, to whom), so a claim orphaned by an orchestrator crash can be
-- found by age and released by the boot / nightly sweep. See User.deletionStatus.
ALTER TABLE "User"
  ADD COLUMN "handoverClaimedAt" TIMESTAMP(3),
  ADD COLUMN "handoverPriorStatus" "UserDeletionStatus",
  ADD COLUMN "handoverRecipientId" TEXT;

-- A claim taken before this column existed: start its clock now (the sweep
-- releases it once the stale window passes). Its prior value was not
-- recorded; a scheduled retention delete is the only state that carries a
-- due date, so restore that one, else NONE.
UPDATE "User"
SET "handoverClaimedAt" = CURRENT_TIMESTAMP,
    "handoverPriorStatus" = CASE WHEN "deletionDueAt" IS NOT NULL
                                 THEN 'PENDING'::"UserDeletionStatus"
                                 ELSE 'NONE'::"UserDeletionStatus" END
WHERE "deletionStatus" = 'HANDING_OVER';
