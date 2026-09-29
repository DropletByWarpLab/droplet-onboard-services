-- ADR-055 (P4a, brief §11.3) — AccessPoint (a door) and AccessEvent (the
-- append-only evidence log).
--
-- Additive only. The Prisma-generated half comes first; the hand-written
-- CHECKs and the two triggers follow. Both are invisible to
-- `prisma migrate diff`, so check-schema-drift cannot see them — the pg-lane
-- tests (doors.pg.test.ts) pin them.
--
-- APPEND-ONLY, IN THE DATABASE. AccessEvent is evidence of people entering
-- places at times. A BEFORE UPDATE OR DELETE trigger refuses every UPDATE
-- unconditionally, and every DELETE except inside the retention job's own
-- transaction, which sets a transaction-local flag first
-- (services/doors.service.ts purgeExpiredAccessEvents — the only code that
-- names it). This is deliberately stricter than SecurityEvent's trigger
-- (20260925030000_warp_2978_security_incidents), which covers UPDATE only and
-- lets retention DELETE through by not being asked.
--
-- DERIVED ALARMS (§9.7, §11.3). A `forced_door` or `held_open` row is derived
-- from a `door_open` row and references it; a BEFORE INSERT trigger holds that
-- (same door, kind door_open), refuses either alarm for a door whose
-- doorPositionSource is 'none', and ties the forced-door claim to the source
-- (a lock is its own witness; a strike-only door is not).
--
-- No seed rows.
--
-- RE-RUNNABLE (the repo idiom; branch migrations are re-stamped before
-- merge): tables and indexes use IF NOT EXISTS, foreign keys are added only
-- when pg_constraint lacks them, the CHECKs are DROP IF EXISTS + ADD, the
-- functions are CREATE OR REPLACE and the triggers DROP IF EXISTS + CREATE.
--
-- NULL discipline: a CHECK whose expression evaluates to NULL PASSES. Every
-- CHECK below compares nullable columns with IS [NOT] NULL only, and reads
-- NOT NULL columns otherwise.

-- CreateTable
CREATE TABLE IF NOT EXISTS "AccessPoint" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "doorPositionSource" "DoorPositionSource" NOT NULL,
    "heldOpenSeconds" INTEGER NOT NULL DEFAULT 30,
    "status" "AccessPointStatus" NOT NULL DEFAULT 'active',
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AccessEvent" (
    "id" BIGSERIAL NOT NULL,
    "accessPointId" TEXT NOT NULL,
    "kind" "AccessEventKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "correlationKey" VARCHAR(128),
    "derivedFromId" BIGINT,
    "forcedClaim" "AccessForcedClaim",
    "troubleCode" "AccessTroubleCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccessPoint_status_idx" ON "AccessPoint"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AccessEvent_dedupeKey_key" ON "AccessEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccessEvent_accessPointId_occurredAt_idx" ON "AccessEvent"("accessPointId", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccessEvent_occurredAt_id_idx" ON "AccessEvent"("occurredAt", "id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccessEvent_kind_occurredAt_idx" ON "AccessEvent"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccessEvent_derivedFromId_idx" ON "AccessEvent"("derivedFromId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccessEvent_createdAt_idx" ON "AccessEvent"("createdAt");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AccessEvent_accessPointId_fkey' AND conrelid = '"AccessEvent"'::regclass) THEN
    ALTER TABLE "AccessEvent" ADD CONSTRAINT "AccessEvent_accessPointId_fkey" FOREIGN KEY ("accessPointId") REFERENCES "AccessPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey. NO ACTION, not RESTRICT: the retention job deletes an alarm
-- and the door_open row it references in one statement, and only NO ACTION
-- checks at the end of the statement rather than per row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AccessEvent_derivedFromId_fkey' AND conrelid = '"AccessEvent"'::regclass) THEN
    ALTER TABLE "AccessEvent" ADD CONSTRAINT "AccessEvent_derivedFromId_fkey" FOREIGN KEY ("derivedFromId") REFERENCES "AccessEvent"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;

-- ── Hand-written CHECKs ─────────────────────────────────────────────────────

-- A door has a name a person can read, a held-open time that is a real
-- number of seconds, and is retired iff it says when.
ALTER TABLE "AccessPoint" DROP CONSTRAINT IF EXISTS "AccessPoint_shape";
ALTER TABLE "AccessPoint" ADD CONSTRAINT "AccessPoint_shape" CHECK (
  char_length(btrim("name")) BETWEEN 1 AND 80
  AND "heldOpenSeconds" BETWEEN 5 AND 3600
  AND ("status" = 'retired') = ("retiredAt" IS NOT NULL)
);

-- Which columns belong to which kind, and only those: a derived alarm
-- references its door_open row; a forced-door row says which claim it makes;
-- a trouble row says what the trouble is.
ALTER TABLE "AccessEvent" DROP CONSTRAINT IF EXISTS "AccessEvent_kind_shape";
ALTER TABLE "AccessEvent" ADD CONSTRAINT "AccessEvent_kind_shape" CHECK (
  ("kind" IN ('forced_door', 'held_open')) = ("derivedFromId" IS NOT NULL)
  AND ("kind" = 'forced_door') = ("forcedClaim" IS NOT NULL)
  AND ("kind" = 'trouble') = ("troubleCode" IS NOT NULL)
  AND char_length("dedupeKey") BETWEEN 1 AND 200
);

-- ── AccessEvent is append-only (brief §11.3: "a door event is evidence") ────

CREATE OR REPLACE FUNCTION "access_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AccessEvent is append-only (ADR-055 §11.3): UPDATE refused'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- DELETE. current_setting(…, true) is NULL when never set and '' after a
  -- SET LOCAL has expired on a reused connection; only 'on' opens the door.
  IF coalesce(current_setting('droplet.access_event_retention', true), '') <> 'on' THEN
    RAISE EXCEPTION 'AccessEvent is append-only (ADR-055 §11.3): DELETE refused outside the retention job'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "AccessEvent_append_only" ON "AccessEvent";
CREATE TRIGGER "AccessEvent_append_only" BEFORE UPDATE OR DELETE ON "AccessEvent"
  FOR EACH ROW EXECUTE FUNCTION "access_event_append_only"();

-- ── Derived alarms (brief §9.7, §11.3) ──────────────────────────────────────

CREATE OR REPLACE FUNCTION "access_event_derived_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src "DoorPositionSource";
  parent_kind "AccessEventKind";
  parent_door TEXT;
BEGIN
  IF NEW."kind" NOT IN ('forced_door', 'held_open') THEN
    RETURN NEW;
  END IF;

  SELECT "doorPositionSource" INTO src FROM "AccessPoint" WHERE "id" = NEW."accessPointId";
  -- §9.7: an alarm the product cannot derive is not one it advertises.
  IF src = 'none' THEN
    RAISE EXCEPTION 'AccessEvent: a door with doorPositionSource none has no % claim (ADR-055 §9.7)', NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "kind", "accessPointId" INTO parent_kind, parent_door FROM "AccessEvent" WHERE "id" = NEW."derivedFromId";
  IF parent_kind IS DISTINCT FROM 'door_open' OR parent_door IS DISTINCT FROM NEW."accessPointId" THEN
    RAISE EXCEPTION 'AccessEvent: a % must reference a door_open row of the same door (ADR-055 §11.3)', NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The two forced-door claims are not interchangeable: only a lock is its
  -- own witness (a latch term exists); a strike-only door has none.
  IF NEW."kind" = 'forced_door' AND (NEW."forcedClaim" = 'latch_witnessed') <> (src = 'lock') THEN
    RAISE EXCEPTION 'AccessEvent: forcedClaim % does not match doorPositionSource % (ADR-055 §9.7)', NEW."forcedClaim", src
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "AccessEvent_derived_guard" ON "AccessEvent";
CREATE TRIGGER "AccessEvent_derived_guard" BEFORE INSERT ON "AccessEvent"
  FOR EACH ROW EXECUTE FUNCTION "access_event_derived_guard"();
