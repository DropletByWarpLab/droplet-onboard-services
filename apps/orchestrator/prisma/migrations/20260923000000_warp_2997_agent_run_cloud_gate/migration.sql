-- WARP-2997 — background runs pass the per-person cloud gate and the off-LAN
-- stored-content gate at every claim; the verdict is recorded on the run.
CREATE TYPE "AgentRunCloudGate" AS ENUM ('unchecked', 'local', 'cloud_allowed', 'cloud_refused', 'cloud_unverified');

ALTER TABLE "AgentRun"
  ADD COLUMN "cloudGate" "AgentRunCloudGate" NOT NULL DEFAULT 'unchecked',
  ADD COLUMN "offLanProvider" TEXT,
  ADD COLUMN "offLanWithheldTools" TEXT[] DEFAULT ARRAY[]::TEXT[];
