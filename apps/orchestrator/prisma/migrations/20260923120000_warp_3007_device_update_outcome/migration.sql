-- WARP-3007 follow-up: explicit apply outcome on DeviceUpdate. Additive.
CREATE TYPE "DeviceUpdateOutcome" AS ENUM ('not_applied', 'starting_services', 'committed', 'services_start_failed', 'rolled_back', 'rollback_failed');

ALTER TABLE "DeviceUpdate" ADD COLUMN "outcome" "DeviceUpdateOutcome" NOT NULL DEFAULT 'not_applied';

-- Rows that already reached a swap verdict get the outcome they had. A
-- historical commit predates the post-commit start, so it reads `committed`.
UPDATE "DeviceUpdate" SET "outcome" = 'committed' WHERE "status" = 'committed';
UPDATE "DeviceUpdate" SET "outcome" = 'rolled_back' WHERE "status" = 'rolled_back';
UPDATE "DeviceUpdate" SET "outcome" = 'rollback_failed'
  WHERE "status" = 'failed' AND "failureReason" = 'degraded_health';
