-- WARP-3193 PERF-3: an atomic apply claim on DeviceUpdate, so POST
-- /updates/apply-now and the cron apply window can never run the same update
-- at the same time. Additive; every existing row starts `unclaimed`, which is
-- true of it (no code before this migration ever claimed a row).
CREATE TYPE "DeviceUpdateApplyClaim" AS ENUM ('unclaimed', 'claimed');

ALTER TABLE "DeviceUpdate"
  ADD COLUMN "applyClaim" "DeviceUpdateApplyClaim" NOT NULL DEFAULT 'unclaimed',
  ADD COLUMN "applyClaimId" TEXT,
  ADD COLUMN "applyClaimedAt" TIMESTAMP(3);
