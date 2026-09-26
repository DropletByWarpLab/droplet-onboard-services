-- WARP-2979 (ADR-059 P4, spec §4–§5 folder 2) — Droplet's AI in Security:
-- where a link came from and who set it (with Droplet's evidence), one
-- settings row for what Droplet may do on its own, a second source on an
-- incident reason, and the incident's "Summary by Droplet" columns.
--
-- Additive only. This folder carries EVERY P4 schema change (spec §11 S0):
-- the later P4 PRs add no migration. The enum VALUES it names ('proposed',
-- 'rejected', 'camera_offline_during_activity') were appended by
-- 20260926000000_warp_2979_security_ai_values, stamped just before this one:
-- PostgreSQL will not let one transaction use an enum value it added, and the
-- CHECKs below compare against them.
--
-- LINKS. There was never a `linkedBy` column to migrate (the brief's sketch
-- was not built). Two explicit enums say who: `origin` — who created the row,
-- immutable — and `stateSetBy` — who set its current state. Every existing
-- row came from a person through route 12, so both are backfilled `person`
-- by a column DEFAULT, and the defaults are then DROPPED so every future
-- writer has to name both (schema.prisma has none either). Neither is ever
-- inferred from a NULL `decidedById`. PostgreSQL 16 backfills an ADD COLUMN
-- with a constant DEFAULT without rewriting the table.
--
-- SUMMARIES. Every existing incident starts at `narrativeState = 'none'`:
-- nothing is narrated retroactively (D32). Nothing in PR-1 moves it.
--
-- No seed rows. SecurityAiSettings is created lazily with INSERT … ON
-- CONFLICT DO NOTHING (createMany + skipDuplicates) and then a read — never
-- upsert({update:{}}), which Prisma 5 runs as read-then-insert — and its
-- column defaults satisfy its CHECK.
--
-- RE-RUNNABLE (the repo idiom, WARP-2896's, WARP-2804's and WARP-2978's):
-- a folder re-stamped while unmerged is applied again under its new name on a
-- dev box that took the old one, so every statement is a no-op the second
-- time:
--   · the types are created in DO blocks that swallow duplicate_object;
--   · columns are ADD COLUMN IF NOT EXISTS (a re-run keeps the stored values;
--     the DROP DEFAULT after the link backfill is a no-op the second time);
--   · the table and indexes use IF NOT EXISTS;
--   · the hand-written CHECKs are DROP IF EXISTS + ADD, so a box holding an
--     older definition gets this one (a guard on the name alone would keep
--     the old text). Re-adding re-validates the rows; these tables are small.
--
-- The CHECKs are invisible to `prisma migrate diff`, so check-schema-drift
-- cannot see them; the WARP-2979 pg lane pins each one
-- (security-ai-schema.pg.test.ts).
--
-- NULL discipline (p2b-spec §14.4): a CHECK whose expression evaluates to
-- NULL PASSES. Every operand below is a boolean over a NOT NULL column or an
-- IS [NOT] NULL, and every comparison on a nullable column sits behind an
-- `IS NULL OR`, so no NULL can wave a row through.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecurityLinkActor" AS ENUM ('person', 'droplet');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecurityAiLinking" AS ENUM ('link_and_suggest', 'suggest_only', 'off');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecurityAiSummaries" AS ENUM ('on', 'off');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "SecurityNarrativeState" AS ENUM ('none', 'pending', 'written', 'failed', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable — links. Every P2b row came from a person through route 12:
-- backfilled `person` by the DEFAULT, which is then dropped so every future
-- writer names both columns.
ALTER TABLE "SecurityZoneLink"
  ADD COLUMN IF NOT EXISTS "origin"       "SecurityLinkActor" NOT NULL DEFAULT 'person',
  ADD COLUMN IF NOT EXISTS "stateSetBy"   "SecurityLinkActor" NOT NULL DEFAULT 'person',
  ADD COLUMN IF NOT EXISTS "evidence"     JSONB,
  ADD COLUMN IF NOT EXISTS "confidence"   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "rulesVersion" SMALLINT,
  ADD COLUMN IF NOT EXISTS "evidenceAt"   TIMESTAMP(3);
ALTER TABLE "SecurityZoneLink" ALTER COLUMN "origin" DROP DEFAULT, ALTER COLUMN "stateSetBy" DROP DEFAULT;

-- AlterTable — the incident's "Summary by Droplet". Existing incidents: `none`.
ALTER TABLE "SecurityIncident"
  ADD COLUMN IF NOT EXISTS "narrativeState"         "SecurityNarrativeState" NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "narrative"              VARCHAR(700),
  ADD COLUMN IF NOT EXISTS "narrativeModel"         VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "narrativePromptVersion" SMALLINT,
  ADD COLUMN IF NOT EXISTS "narratedAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "narrativeAudience"      JSONB,
  ADD COLUMN IF NOT EXISTS "narrativeAttempts"      SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "narrativeAttemptAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "narrativeError"         VARCHAR(64);

-- AlterTable — a reason's second source (camera_offline_during_activity:
-- where the person was seen; PR-4: a lock reading).
ALTER TABLE "SecurityIncidentReason"
  ADD COLUMN IF NOT EXISTS "relatedCamera" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "relatedLock"   BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SecurityAiSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "linking" "SecurityAiLinking" NOT NULL DEFAULT 'link_and_suggest',
    "summaries" "SecurityAiSummaries" NOT NULL DEFAULT 'on',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityAiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecurityZoneLink_state_origin_idx" ON "SecurityZoneLink"("state", "origin");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SecurityIncident_narrativeState_severity_lastActivityAt_idx" ON "SecurityIncident"("narrativeState", "severity", "lastActivityAt");

-- ── Hand-written CHECKs ─────────────────────────────────────────────────────

-- Provenance (D2) in the database. Droplet's evidence, confidence, rules
-- version and evidence time exist exactly on a row Droplet created. `droplet`
-- sets a state only on its own rows, and only `proposed` or `active`; a
-- suggestion is always Droplet's own and Droplet-set. The last two lines put
-- "Droplet never removes or rejects" here: `rejected` (a person said no to
-- Droplet) and `removed` (a person unlinked it) are set by a person, always.
ALTER TABLE "SecurityZoneLink" DROP CONSTRAINT IF EXISTS "SecurityZoneLink_origin_shape";
ALTER TABLE "SecurityZoneLink" ADD CONSTRAINT "SecurityZoneLink_origin_shape" CHECK (
  -- One equality per column: `(droplet) = (all four set)` alone would let a
  -- person's row carry a stray confidence (false = false).
  ("origin" = 'droplet') = ("evidence" IS NOT NULL)
  AND ("origin" = 'droplet') = ("confidence" IS NOT NULL)
  AND ("origin" = 'droplet') = ("rulesVersion" IS NOT NULL)
  AND ("origin" = 'droplet') = ("evidenceAt" IS NOT NULL)
  AND ("evidence" IS NULL OR jsonb_typeof("evidence") = 'object')
  AND ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1))
  AND ("rulesVersion" IS NULL OR "rulesVersion" >= 1)
  AND ("stateSetBy" = 'person' OR ("origin" = 'droplet' AND "state" IN ('proposed', 'active')))
  AND ("state" <> 'proposed' OR ("origin" = 'droplet' AND "stateSetBy" = 'droplet'))
  AND ("state" <> 'rejected' OR ("origin" = 'droplet' AND "stateSetBy" = 'person'))
  AND ("state" <> 'removed' OR "stateSetBy" = 'person')
);

-- The summary's columns move together: text, model, prompt version, time and
-- audience are all set or all NULL. `written` has text; plain activity (info)
-- is never narrated; `failed` says why; the audience is a JSON object.
-- `pending` may keep the previous text: a Regenerate leaves the old summary
-- visible until the new one is written.
ALTER TABLE "SecurityIncident" DROP CONSTRAINT IF EXISTS "SecurityIncident_narrative_shape";
ALTER TABLE "SecurityIncident" ADD CONSTRAINT "SecurityIncident_narrative_shape" CHECK (
  ("narrative" IS NULL) = ("narrativeModel" IS NULL)
  AND ("narrative" IS NULL) = ("narrativePromptVersion" IS NULL)
  AND ("narrative" IS NULL) = ("narratedAt" IS NULL)
  AND ("narrative" IS NULL) = ("narrativeAudience" IS NULL)
  AND ("narrativeAudience" IS NULL OR jsonb_typeof("narrativeAudience") = 'object')
  AND ("narrativeState" <> 'written' OR "narrative" IS NOT NULL)
  AND ("severity" <> 'info' OR ("narrativeState" = 'none' AND "narrative" IS NULL))
  AND ("narrativeState" <> 'failed' OR "narrativeError" IS NOT NULL)
  AND "narrativeAttempts" BETWEEN 0 AND 10
  AND ("narrativePromptVersion" IS NULL OR "narrativePromptVersion" >= 1)
);

-- A reason's second source belongs to camera_offline_during_activity only,
-- and is a Frigate camera name.
ALTER TABLE "SecurityIncidentReason" DROP CONSTRAINT IF EXISTS "SecurityIncidentReason_related";
ALTER TABLE "SecurityIncidentReason" ADD CONSTRAINT "SecurityIncidentReason_related" CHECK (
  ("relatedCamera" IS NULL OR "relatedCamera" ~ '^[a-zA-Z0-9_-]{1,64}$')
  AND ("code" = 'camera_offline_during_activity' OR ("relatedCamera" IS NULL AND "relatedLock" = false))
);

-- D18 widened (P3's CHECK, re-added with one more arm): severity still comes
-- from the code, and camera_offline_during_activity is always an alert.
ALTER TABLE "SecurityIncidentReason" DROP CONSTRAINT IF EXISTS "SecurityIncidentReason_code_severity";
ALTER TABLE "SecurityIncidentReason" ADD CONSTRAINT "SecurityIncidentReason_code_severity" CHECK (
  ("code" = 'after_hours_presence' AND "severity" = 'alert')
  OR ("code" IN ('camera_offline', 'threat_signal') AND "severity" = 'notice')
  OR ("code" = 'camera_offline_during_activity' AND "severity" = 'alert')
);

-- One row.
ALTER TABLE "SecurityAiSettings" DROP CONSTRAINT IF EXISTS "SecurityAiSettings_singleton";
ALTER TABLE "SecurityAiSettings" ADD CONSTRAINT "SecurityAiSettings_singleton" CHECK (
  "id" = 'singleton' AND "version" >= 0
);
