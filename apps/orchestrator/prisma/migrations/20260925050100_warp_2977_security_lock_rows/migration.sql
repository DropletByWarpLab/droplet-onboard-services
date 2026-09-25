-- WARP-2977 P2b-2 (ADR-059 §3.2) — lock_state rows in the Security event
-- store, and lock links on areas.
--
-- Additive only. The Prisma-generated half (the enum, the column and the
-- index) comes first; the hand-written CHECKs follow. The CHECKs are
-- invisible to `prisma migrate diff`, so check-schema-drift cannot see them
-- either way — they are pinned by security-schema-checks.pg.test.ts instead.
--
-- 'matter_lock' / 'lock_state' / 'lock' were appended in the migration
-- stamped just before this one (an enum value cannot be used in the
-- transaction that adds it), which is what lets the CHECKs below name them.
--
-- `observed` defaults to 'live', which is what every row written so far is:
-- Frigate detections, camera status, mirrored threats and mode changes all
-- stamp startedAt when the thing happened. Only the lock sweep writes
-- 'polled' (startedAt = when Droplet's 60 s check found the change).
--
-- NULL discipline (as in 20260924000100): a CHECK that evaluates to NULL
-- PASSES, so the shape rule reads its nullable inputs (camera, labels, a
-- label element) inside COALESCE(…, false).
--
-- RE-STAMPED, AND THEREFORE RE-RUNNABLE. Written as
-- `20260925000100_warp_2977_security_lock_rows` (its enum values as
-- `20260925000000_…_lock_values`) and moved past stage's newest
-- (20260925020000) and the stamps the other open ADR-059 branches hold
-- (…030000 incidents, …030100/…030200 early presence, …040000 active
-- department), so the history applies in the order it merges. A dev box that
-- ran the pre-merge build holds journal rows under the OLD names, so
-- `migrate deploy` runs both folders again over a schema that already has
-- every object below. Every statement is therefore idempotent — a
-- duplicate_object guard on the enum, IF NOT EXISTS on the column and index,
-- DROP … IF EXISTS then ADD for each CHECK — the WARP-2896 re-stamp's idiom.
-- The old-name journal rows are left in place on purpose (WARP-2896: the old
-- folder's SQL is not idempotent, and deleting its row would re-run it on the
-- next deploy of a build that still carries it).

-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "SecurityObservation" AS ENUM ('live', 'polled');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "SecurityEvent" ADD COLUMN IF NOT EXISTS "observed" "SecurityObservation" NOT NULL DEFAULT 'live';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecurityEvent_sourceRef_startedAt_idx" ON "SecurityEvent"("sourceRef", "startedAt");

-- ── Hand-written CHECKs ─────────────────────────────────────────────────

-- A lock_state row is exactly a matter_lock row. It carries no camera (the
-- camera-grant filter never decides it; smart_home ≥ view does, DS-019), one
-- label — the reading, from the RAW DoorLock.LockState number, never the
-- sidecar's state string — and the endpoint it is about as
-- matter:<nodeId>/<endpointId>, which is also its lock links' sourceRef.
ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_lock_shape";
ALTER TABLE "SecurityEvent"
  ADD CONSTRAINT "SecurityEvent_lock_shape"
  CHECK (
    (("source" = 'matter_lock') = ("kind" = 'lock_state'))
    AND (
      "kind" <> 'lock_state'
      OR COALESCE(
        "camera" IS NULL
        AND cardinality("labels") = 1
        AND "labels"[1] IN ('locked', 'unlocked', 'not_fully_locked', 'unlatched', 'unknown')
        AND "sourceRef" ~ '^matter:[0-9]{1,20}/[0-9]{1,5}$',
        false
      )
    )
  );

-- Links: Frigate names (camera, or camera/zone) as before, plus one Matter
-- DoorLock endpoint in the same grammar as the lock rows' sourceRef.
ALTER TABLE "SecurityZoneLink" DROP CONSTRAINT IF EXISTS "SecurityZoneLink_ref";
ALTER TABLE "SecurityZoneLink"
  ADD CONSTRAINT "SecurityZoneLink_ref"
  CHECK (
    ("sourceKind" = 'camera' AND "sourceRef" ~ '^[a-zA-Z0-9_-]{1,64}$')
    OR ("sourceKind" = 'camera_zone' AND "sourceRef" ~ '^[a-zA-Z0-9_-]{1,64}/[a-zA-Z0-9_-]{1,64}$')
    OR ("sourceKind" = 'lock' AND "sourceRef" ~ '^matter:[0-9]{1,20}/[0-9]{1,5}$')
  );
