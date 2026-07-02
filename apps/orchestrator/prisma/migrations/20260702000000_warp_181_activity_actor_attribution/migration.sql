-- WARP-181: first-class actor attribution on the signed activity log.
--
-- Adds `actorType` / `actorId` / `schemaVersion` to ActivityRow.
-- Pre-existing rows were signed under the legacy 7-key canonical form
-- (schemaVersion 1, no actor) — they are backfilled to schemaVersion 1
-- via a transient column default, which is then DROPPED so new rows
-- can never silently inherit it: the recorder writes schemaVersion 2
-- explicitly on every insert (activity.service.ts).

-- CreateEnum
CREATE TYPE "ActivityActorType" AS ENUM ('user', 'ai', 'system', 'anonymous');

-- AlterTable
-- `DEFAULT 1` backfills every existing row to schemaVersion 1 in the
-- same statement (Postgres 11+ fast default — no table rewrite).
ALTER TABLE "ActivityRow" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "actorType" "ActivityActorType",
ADD COLUMN     "schemaVersion" INTEGER NOT NULL DEFAULT 1;

-- Drop the default immediately: it exists only to backfill the
-- pre-upgrade rows. From here on an INSERT that omits schemaVersion
-- is a bug and must fail loudly rather than mint a mislabeled v1 row.
ALTER TABLE "ActivityRow" ALTER COLUMN "schemaVersion" DROP DEFAULT;

-- Explicit-era rule: a NULL actor is only legal on pre-upgrade v1
-- rows. Every v2+ row must carry an actorType.
ALTER TABLE "ActivityRow" ADD CONSTRAINT "ActivityRow_actor_explicit_era"
CHECK ("schemaVersion" = 1 OR "actorType" IS NOT NULL);

-- CreateIndex
CREATE INDEX "ActivityRow_actorId_at_idx" ON "ActivityRow"("actorId", "at");
