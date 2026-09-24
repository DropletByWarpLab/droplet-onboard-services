-- WARP-2977 P2b (ADR-059 §3.4, §3.6) — areas (zones), opening hours and the
-- site mode.
--
-- Additive only. The Prisma-generated half (CREATE TYPE / CREATE TABLE /
-- indexes / the Restrict FK) comes first; the hand-written CHECKs follow. The
-- CHECKs are invisible to `prisma migrate diff`, so check-schema-drift cannot
-- see them either way — they are pinned by the P2b pg-lane tests instead.
--
-- Areas resolve against SecurityEvent at READ time: no zoneId column is added
-- to SecurityEvent. 'site_mode' / 'mode_changed' were appended to the P2a
-- enums in the migration stamped just before this one (an enum value cannot
-- be used in the transaction that adds it), which is what lets
-- "SecurityEvent_site_mode_shape" name them here.
--
-- No seed rows. The singletons (SecuritySiteHours, SecurityModeState) are
-- created lazily with INSERT … ON CONFLICT DO NOTHING (createMany with
-- skipDuplicates) and then a read — never upsert({update:{}}), which Prisma 5
-- runs as read-then-insert, so two first callers race to a P2002 — and their
-- column defaults satisfy every CHECK below.
--
-- NULL discipline: a CHECK whose expression evaluates to NULL PASSES. Every
-- CHECK below that reads a nullable input is therefore wrapped in
-- COALESCE(…, false), so a NULL label array, a NULL array element or a NULL
-- minute can never slip a row past its shape rule.

-- CreateEnum
CREATE TYPE "SecurityZoneKind" AS ENUM ('entry', 'interior', 'perimeter', 'parking', 'restricted');

-- CreateEnum
CREATE TYPE "SecurityZoneState" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "SecurityZoneSourceKind" AS ENUM ('camera', 'camera_zone');

-- CreateEnum
CREATE TYPE "SecurityZoneLinkState" AS ENUM ('active', 'removed');

-- CreateEnum
CREATE TYPE "SecurityHoursState" AS ENUM ('not_set', 'set');

-- CreateEnum
CREATE TYPE "SecurityDayKind" AS ENUM ('closed', 'open_all_day', 'hours');

-- CreateEnum
CREATE TYPE "SecurityMode" AS ENUM ('open', 'closed', 'away');

-- CreateEnum
CREATE TYPE "SecurityModeSource" AS ENUM ('schedule', 'manual');

-- CreateEnum
CREATE TYPE "SecurityManualEnd" AS ENUM ('none', 'next_opening', 'at_time', 'until_changed');

-- CreateTable
CREATE TABLE "SecurityZone" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "nameKey" VARCHAR(60) NOT NULL,
    "kind" "SecurityZoneKind" NOT NULL,
    "state" "SecurityZoneState" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityZoneLink" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "sourceKind" "SecurityZoneSourceKind" NOT NULL,
    "sourceRef" VARCHAR(160) NOT NULL,
    "sourceLabel" VARCHAR(120) NOT NULL,
    "state" "SecurityZoneLinkState" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityZoneLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecuritySiteHours" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "state" "SecurityHoursState" NOT NULL DEFAULT 'not_set',
    "timezone" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecuritySiteHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecuritySchedule" (
    "weekday" SMALLINT NOT NULL,
    "kind" "SecurityDayKind" NOT NULL,
    "opensMin" SMALLINT,
    "closesMin" SMALLINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecuritySchedule_pkey" PRIMARY KEY ("weekday")
);

-- CreateTable
CREATE TABLE "SecurityScheduleException" (
    "date" VARCHAR(10) NOT NULL,
    "kind" "SecurityDayKind" NOT NULL,
    "opensMin" SMALLINT,
    "closesMin" SMALLINT,
    "note" VARCHAR(80) NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityScheduleException_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "SecurityModeState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" "SecurityMode" NOT NULL DEFAULT 'open',
    "modeSource" "SecurityModeSource" NOT NULL DEFAULT 'schedule',
    "manualEnd" "SecurityManualEnd" NOT NULL DEFAULT 'none',
    "manualUntil" TIMESTAMP(3),
    "setById" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityModeState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecurityZone_nameKey_key" ON "SecurityZone"("nameKey");

-- CreateIndex
CREATE INDEX "SecurityZone_state_idx" ON "SecurityZone"("state");

-- CreateIndex
CREATE INDEX "SecurityZoneLink_sourceKind_sourceRef_state_idx" ON "SecurityZoneLink"("sourceKind", "sourceRef", "state");

-- CreateIndex
CREATE INDEX "SecurityZoneLink_zoneId_state_idx" ON "SecurityZoneLink"("zoneId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityZoneLink_zoneId_sourceKind_sourceRef_key" ON "SecurityZoneLink"("zoneId", "sourceKind", "sourceRef");

-- AddForeignKey
ALTER TABLE "SecurityZoneLink" ADD CONSTRAINT "SecurityZoneLink_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "SecurityZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand-written CHECKs ─────────────────────────────────────────────────

-- A mode_changed row is exactly a site_mode row, carries no camera (so the
-- camera-grant filter never hides it), and labels = [mode, modeSource,
-- fromMode]: the mode it changed TO, what set it, and the mode it changed
-- FROM — never the same, since every row records a change. With the FROM
-- mode on every row, the mode at any instant inside the retention window
-- reads off the rows alone (P3): the latest row at or before it, else the
-- earliest row after it's fromMode, else the current mode.
ALTER TABLE "SecurityEvent"
  ADD CONSTRAINT "SecurityEvent_site_mode_shape"
  CHECK (
    (("source" = 'site_mode') = ("kind" = 'mode_changed'))
    AND (
      "kind" <> 'mode_changed'
      OR COALESCE(
        "camera" IS NULL
        AND cardinality("labels") = 3
        AND "labels"[1] IN ('open', 'closed', 'away')
        AND "labels"[2] IN ('schedule', 'manual')
        AND "labels"[3] IN ('open', 'closed', 'away')
        AND "labels"[3] <> "labels"[1],
        false
      )
    )
  );

-- Case-insensitive uniqueness lives in the database: nameKey is the unique
-- column, and it can only ever be lower(btrim(name)).
ALTER TABLE "SecurityZone"
  ADD CONSTRAINT "SecurityZone_name_key"
  CHECK (
    "nameKey" = lower(btrim("name"))
    AND length(btrim("name")) BETWEEN 1 AND 60
  );

-- Links are Frigate NAMES (camera, or camera/zone), in Frigate's own name
-- grammar (security-event-ingest.ts FRIGATE_NAME). PR-2 re-adds this with a
-- third arm for `lock`.
ALTER TABLE "SecurityZoneLink"
  ADD CONSTRAINT "SecurityZoneLink_ref"
  CHECK (
    ("sourceKind" = 'camera' AND "sourceRef" ~ '^[a-zA-Z0-9_-]{1,64}$')
    OR ("sourceKind" = 'camera_zone' AND "sourceRef" ~ '^[a-zA-Z0-9_-]{1,64}/[a-zA-Z0-9_-]{1,64}$')
  );

-- One row; a timezone exactly when the hours are set. There is no UTC
-- fallback anywhere.
ALTER TABLE "SecuritySiteHours"
  ADD CONSTRAINT "SecuritySiteHours_shape"
  CHECK (
    "id" = 'singleton'
    AND (("state" = 'set') = ("timezone" IS NOT NULL))
  );

ALTER TABLE "SecuritySchedule"
  ADD CONSTRAINT "SecuritySchedule_weekday"
  CHECK ("weekday" BETWEEN 1 AND 7);

-- Minutes exactly when the day kind is `hours`, both in range, never equal
-- (equal is open_all_day). closesMin < opensMin means "closes the next day".
ALTER TABLE "SecuritySchedule"
  ADD CONSTRAINT "SecuritySchedule_shape"
  CHECK (
    COALESCE(
      ("kind" = 'hours'
        AND "opensMin" IS NOT NULL AND "closesMin" IS NOT NULL
        AND "opensMin" BETWEEN 0 AND 1439
        AND "closesMin" BETWEEN 0 AND 1439
        AND "opensMin" <> "closesMin")
      OR ("kind" <> 'hours' AND "opensMin" IS NULL AND "closesMin" IS NULL),
      false
    )
  );

ALTER TABLE "SecurityScheduleException"
  ADD CONSTRAINT "SecurityScheduleException_shape"
  CHECK (
    COALESCE(
      ("kind" = 'hours'
        AND "opensMin" IS NOT NULL AND "closesMin" IS NOT NULL
        AND "opensMin" BETWEEN 0 AND 1439
        AND "closesMin" BETWEEN 0 AND 1439
        AND "opensMin" <> "closesMin")
      OR ("kind" <> 'hours' AND "opensMin" IS NULL AND "closesMin" IS NULL),
      false
    )
  );

-- A site-local calendar date string, never a timestamp. (The route checks it
-- is a REAL date; this pins the shape.)
ALTER TABLE "SecurityScheduleException"
  ADD CONSTRAINT "SecurityScheduleException_date"
  CHECK ("date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');

-- The only legal mode rows. The schedule never produces away; a manual
-- override may persist indefinitely only in the more-watchful direction
-- (closed/away until_changed); an Open up always has an end.
ALTER TABLE "SecurityModeState"
  ADD CONSTRAINT "SecurityModeState_shape"
  CHECK (
    "id" = 'singleton'
    AND (
      ("modeSource" = 'schedule' AND "manualEnd" = 'none' AND "mode" IN ('open', 'closed') AND "manualUntil" IS NULL)
      OR ("modeSource" = 'manual' AND (
           ("manualEnd" = 'next_opening'  AND "mode" = 'closed'             AND "manualUntil" IS NOT NULL)
        OR ("manualEnd" = 'until_changed' AND "mode" IN ('closed', 'away')  AND "manualUntil" IS NULL)
        OR ("manualEnd" = 'at_time'       AND "mode" = 'open'               AND "manualUntil" IS NOT NULL)))
    )
  );
