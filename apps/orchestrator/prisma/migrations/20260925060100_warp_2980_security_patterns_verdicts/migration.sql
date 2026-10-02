-- WARP-2980 (ADR-059 P5 PR-B, brief §4.3, §4.4) — pattern flags, expected
-- activity ("SecuritySuppression" in code, never in the UI), verdicts, and the
-- per-day count of what the pattern rules judged.
--
-- Additive only. The Prisma-generated half (6 types, 5 columns on
-- SecurityIncident, 3 tables, indexes, FKs — each guarded, see RE-RUNNABLE)
-- comes first; the hand-written CHECKs follow. The CHECKs are invisible to
-- `prisma migrate diff`, so check-schema-drift cannot see them —
-- security-pattern-flags.pg.test.ts pins every arm.
--
-- TRIAL IS A DATABASE FACT. Every P5 code ships `trial`: a hit is written to
-- SecurityPatternFlag, never to SecurityIncidentReason. This folder
-- deliberately does NOT touch SecurityIncidentReason_code_severity
-- (20260925030000), which still admits only the three P3 codes, so a P5 code
-- on a reason is refused by Postgres until P5 PR-D widens that CHECK with its
-- first writer. The list SQL, the notifier and SecurityIncident_state_shape
-- all assume every reason counts; the separate table keeps that true.
--
-- RE-RUNNABLE (the repo idiom, 20260925030000's): every statement is a no-op
-- the second time —
--   · the types are created in a DO block that swallows duplicate_object;
--   · columns are ADD COLUMN IF NOT EXISTS (`verdictCodes` nullable with
--     Prisma's own list default, exactly as Prisma emits a list, so drift
--     stays clean; the CHECK requires it NOT NULL);
--   · tables and indexes use IF NOT EXISTS;
--   · the foreign keys are added only when pg_constraint lacks them;
--   · the hand-written CHECKs are DROP IF EXISTS + ADD, so a box holding an
--     older definition gets this one.
-- The values 'out_of_place', 'unusual_volume' and 'long_dwell' were added by
-- 20260925060000 (its own folder: a transaction cannot use a value it added),
-- so the CHECKs below may name them.
--
-- NULL discipline (p2b-spec §14.4): a CHECK whose expression evaluates to NULL
-- PASSES. Every array a CHECK reads is itself required NOT NULL and to hold no
-- NULL element (array_position finds NULL); every nullable scalar is read with
-- IS [NOT] NULL only, or behind an arm that already failed when it is NULL.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecurityIncidentVerdict" AS ENUM ('unreviewed', 'expected', 'not_expected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecurityPatternFlagEffect" AS ENUM ('trial', 'suppressed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecuritySuppressionTarget" AS ENUM ('area', 'camera');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecuritySuppressionDays" AS ENUM ('every_day', 'weekdays', 'weekends');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecuritySuppressionState" AS ENUM ('active', 'removed', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecurityPatternOutcome" AS ENUM ('judged', 'no_build', 'zone_changed', 'stale_build', 'no_cell', 'area_changed', 'camera_not_active', 'not_ready', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "SecurityIncident" ADD COLUMN IF NOT EXISTS "verdict" "SecurityIncidentVerdict" NOT NULL DEFAULT 'unreviewed';
ALTER TABLE "SecurityIncident" ADD COLUMN IF NOT EXISTS "verdictAt" TIMESTAMP(3);
ALTER TABLE "SecurityIncident" ADD COLUMN IF NOT EXISTS "verdictById" TEXT;
ALTER TABLE "SecurityIncident" ADD COLUMN IF NOT EXISTS "verdictByName" VARCHAR(120);
ALTER TABLE "SecurityIncident" ADD COLUMN IF NOT EXISTS "verdictCodes" "SecurityReasonCode"[] DEFAULT ARRAY[]::"SecurityReasonCode"[];
ALTER TABLE "SecurityIncident" ADD COLUMN IF NOT EXISTS "verdictFirstAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SecurityPatternFlag" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "code" "SecurityReasonCode" NOT NULL,
    "effect" "SecurityPatternFlagEffect" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "suppressionId" TEXT,
    "rulesetVersion" SMALLINT NOT NULL,
    "zoneKey" VARCHAR(72) NOT NULL,
    "keyCameras" TEXT[],
    "evidenceEventId" BIGINT NOT NULL,
    "evidenceCamera" VARCHAR(64) NOT NULL,
    "evidenceLabel" VARCHAR(64) NOT NULL,
    "evidenceAt" TIMESTAMP(3) NOT NULL,
    "evidenceSummary" VARCHAR(500) NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityPatternFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SecuritySuppression" (
    "id" TEXT NOT NULL,
    "targetKind" "SecuritySuppressionTarget" NOT NULL,
    "zoneId" TEXT,
    "camera" VARCHAR(64),
    "label" VARCHAR(64) NOT NULL,
    "days" "SecuritySuppressionDays" NOT NULL,
    "hourFrom" SMALLINT NOT NULL,
    "hourCount" SMALLINT NOT NULL,
    "codes" "SecurityReasonCode"[],
    "reason" VARCHAR(120) NOT NULL,
    "state" "SecuritySuppressionState" NOT NULL DEFAULT 'active',
    "createdById" TEXT NOT NULL,
    "createdByName" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,

    CONSTRAINT "SecuritySuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SecurityPatternDay" (
    "date" VARCHAR(10) NOT NULL,
    "outcome" "SecurityPatternOutcome" NOT NULL,
    "count" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityPatternDay_pkey" PRIMARY KEY ("date","outcome")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecurityPatternFlag_suppressionId_idx" ON "SecurityPatternFlag"("suppressionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecurityPatternFlag_createdAt_idx" ON "SecurityPatternFlag"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityPatternFlag_incidentId_code_evidenceEventId_key" ON "SecurityPatternFlag"("incidentId", "code", "evidenceEventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecuritySuppression_state_expiresAt_idx" ON "SecuritySuppression"("state", "expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecuritySuppression_zoneId_idx" ON "SecuritySuppression"("zoneId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecurityIncident_verdict_idx" ON "SecurityIncident"("verdict");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SecurityPatternFlag_incidentId_fkey' AND conrelid = '"SecurityPatternFlag"'::regclass) THEN
    ALTER TABLE "SecurityPatternFlag" ADD CONSTRAINT "SecurityPatternFlag_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "SecurityIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SecurityPatternFlag_suppressionId_fkey' AND conrelid = '"SecurityPatternFlag"'::regclass) THEN
    ALTER TABLE "SecurityPatternFlag" ADD CONSTRAINT "SecurityPatternFlag_suppressionId_fkey" FOREIGN KEY ("suppressionId") REFERENCES "SecuritySuppression"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SecuritySuppression_zoneId_fkey' AND conrelid = '"SecuritySuppression"'::regclass) THEN
    ALTER TABLE "SecuritySuppression" ADD CONSTRAINT "SecuritySuppression_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "SecurityZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── Hand-written CHECKs ─────────────────────────────────────────────────────

-- A verdict is explicit (brief §5: "verdict = unreviewed, not a null
-- verdictAt"): who, when, the first mark and the judged codes are all set iff
-- it is not unreviewed; the first mark is never after the latest.
ALTER TABLE "SecurityIncident" DROP CONSTRAINT IF EXISTS "SecurityIncident_verdict_shape";
ALTER TABLE "SecurityIncident" ADD CONSTRAINT "SecurityIncident_verdict_shape" CHECK (
  "verdictCodes" IS NOT NULL
  AND array_position("verdictCodes", NULL) IS NULL
  AND ("verdict" = 'unreviewed') = ("verdictAt" IS NULL)
  AND ("verdictAt" IS NULL) = ("verdictFirstAt" IS NULL)
  AND ("verdictAt" IS NULL) = ("verdictById" IS NULL)
  AND ("verdictById" IS NULL) = ("verdictByName" IS NULL)
  AND ("verdict" = 'unreviewed') = (cardinality("verdictCodes") = 0)
  AND ("verdictAt" IS NULL OR "verdictFirstAt" <= "verdictAt")
);

-- D9: the only (code, severity) pairs the rules produce — only a person
-- reaches alert, unusual_volume never does, long_dwell is judged for a person
-- only. A suppression id iff quietened. The key is the one the flag was
-- judged against, and its cameras hold the evidence camera (a camera key's are
-- exactly that camera): the DS-005 clauses of a flag's visibility read them.
ALTER TABLE "SecurityPatternFlag" DROP CONSTRAINT IF EXISTS "SecurityPatternFlag_shape";
ALTER TABLE "SecurityPatternFlag" ADD CONSTRAINT "SecurityPatternFlag_shape" CHECK (
  (("code" IN ('out_of_place', 'long_dwell') AND "severity" IN ('notice', 'alert'))
    OR ("code" = 'unusual_volume' AND "severity" IN ('info', 'notice')))
  AND ("severity" <> 'alert' OR "evidenceLabel" = 'person')
  AND ("code" <> 'long_dwell' OR "evidenceLabel" = 'person')
  AND ("effect" = 'suppressed') = ("suppressionId" IS NOT NULL)
  AND "evidenceCamera" ~ '^[a-zA-Z0-9_-]{1,64}$' AND "evidenceLabel" ~ '^[a-zA-Z0-9_-]{1,64}$'
  AND "zoneKey" ~ '^(area:[0-9a-f-]{36}|camera:[a-zA-Z0-9_-]{1,64})$'
  AND "keyCameras" IS NOT NULL AND cardinality("keyCameras") >= 1 AND array_position("keyCameras", NULL) IS NULL
  AND "evidenceCamera" = ANY ("keyCameras")
  AND ("zoneKey" NOT LIKE 'camera:%' OR "keyCameras" = ARRAY[substr("zoneKey", 8)]::text[])
  AND jsonb_typeof("detail") = 'object' AND "rulesetVersion" >= 3
);

-- D12/D13: expected activity names one target, a label, a window and 1–3
-- DISTINCT-by-zod pattern codes (never after_hours_presence, camera_offline or
-- threat_signal); lasts at most a year; `active` iff not ended, `removed` iff
-- a person ended it. A whole day starts at midnight: a 24-hour window belongs
-- to the day it opens, so one from 15:00 would quiet the wrong days while the
-- page says "All day". A duplicate code passes here (harmless to matching; zod
-- refuses it).
ALTER TABLE "SecuritySuppression" DROP CONSTRAINT IF EXISTS "SecuritySuppression_shape";
ALTER TABLE "SecuritySuppression" ADD CONSTRAINT "SecuritySuppression_shape" CHECK (
  ("targetKind" = 'area') = ("zoneId" IS NOT NULL)
  AND ("targetKind" = 'camera') = ("camera" IS NOT NULL)
  AND ("camera" IS NULL OR "camera" ~ '^[a-zA-Z0-9_-]{1,64}$')
  AND "label" ~ '^[a-zA-Z0-9_-]{1,64}$'
  AND "hourFrom" BETWEEN 0 AND 23 AND "hourCount" BETWEEN 1 AND 24
  AND ("hourCount" < 24 OR "hourFrom" = 0)
  AND "codes" IS NOT NULL AND array_position("codes", NULL) IS NULL
  AND cardinality("codes") BETWEEN 1 AND 3
  AND "codes" <@ ARRAY['out_of_place', 'unusual_volume', 'long_dwell']::"SecurityReasonCode"[]
  AND (NOT ('long_dwell' = ANY ("codes")) OR "label" = 'person')
  AND btrim("reason") <> '' AND btrim("createdByName") <> ''
  AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '365 days'
  AND ("state" = 'active') = ("endedAt" IS NULL)
  AND ("state" = 'removed') = ("endedById" IS NOT NULL)
);

ALTER TABLE "SecurityPatternDay" DROP CONSTRAINT IF EXISTS "SecurityPatternDay_shape";
ALTER TABLE "SecurityPatternDay" ADD CONSTRAINT "SecurityPatternDay_shape" CHECK (
  "date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "count" >= 0
);
