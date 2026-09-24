-- WARP-2978 (ADR-059 P3, §3.5, §3.7) — incidents, reason codes, alert routing
-- and acknowledgement.
--
-- Additive only. The Prisma-generated half (12 CREATE TYPE, 7 CREATE TABLE,
-- indexes, FKs) comes first; the hand-written CHECKs and the append-only
-- trigger follow. Both are invisible to `prisma migrate diff`, so
-- check-schema-drift cannot see them — the WARP-2978 pg-lane tests pin them.
--
-- MEMBERSHIP. An event's incident is recorded in SecurityEventTriage (one row
-- per event, which is also the engine's exactly-once marker), never as a
-- column on SecurityEvent. SecurityEvent becomes append-only in the database:
-- a BEFORE UPDATE trigger refuses every UPDATE. DELETE (the 30-day retention)
-- and TRUNCATE (factory reset) are unaffected.
--
-- No seed rows. SecurityIncidentEngineState is created by the engine's first
-- tick and the owners' SecurityAlertRecipient rows lazily, both with
-- INSERT … ON CONFLICT DO NOTHING (createMany + skipDuplicates) and then a
-- read — never upsert({update:{}}), which Prisma 5 runs as read-then-insert.
--
-- NULL discipline (p2b-spec §14.4): a CHECK whose expression evaluates to NULL
-- PASSES. Every CHECK below compares nullable columns with IS [NOT] NULL only,
-- and every array column a CHECK reads is itself required to be NOT NULL (a
-- NULL array would make cardinality() NULL and wave the row through).

-- CreateEnum
CREATE TYPE "SecurityIncidentScope" AS ENUM ('area', 'camera', 'site_threat', 'site_camera_system');

-- CreateEnum
CREATE TYPE "SecurityIncidentGrouping" AS ENUM ('collecting', 'closed');

-- CreateEnum
CREATE TYPE "SecurityIncidentState" AS ENUM ('no_action', 'open', 'acknowledged', 'resolved');

-- CreateEnum
CREATE TYPE "SecurityIncidentNotify" AS ENUM ('not_needed', 'pending', 'done', 'module_off', 'failed');

-- CreateEnum
CREATE TYPE "SecurityIncidentEvents" AS ENUM ('kept', 'partly_removed', 'removed');

-- CreateEnum
CREATE TYPE "SecurityReasonCode" AS ENUM ('after_hours_presence', 'camera_offline', 'threat_signal');

-- CreateEnum
CREATE TYPE "SecurityTriageOutcome" AS ENUM ('grouped', 'low', 'context', 'failed');

-- CreateEnum
CREATE TYPE "SecurityIncidentAckAction" AS ENUM ('acknowledge', 'resolve');

-- CreateEnum
CREATE TYPE "SecurityAlertRecipientState" AS ENUM ('receiving', 'not_receiving');

-- CreateEnum
CREATE TYPE "SecurityAlertRecipientOrigin" AS ENUM ('owner_default', 'chosen');

-- CreateEnum
CREATE TYPE "SecurityNoticeReason" AS ENUM ('routed', 'fallback_owner');

-- CreateEnum
CREATE TYPE "SecurityNoticeOutcome" AS ENUM ('queued', 'sent', 'not_sent', 'outcome_unknown', 'skipped_no_access', 'skipped_not_visible', 'skipped_capped', 'skipped_no_address');

-- CreateTable
CREATE TABLE "SecurityIncident" (
    "id" TEXT NOT NULL,
    "scope" "SecurityIncidentScope" NOT NULL,
    "zoneId" TEXT,
    "zoneName" VARCHAR(60),
    "zoneKind" "SecurityZoneKind",
    "zoneLinkIds" TEXT[],
    "scopeCamera" VARCHAR(64),
    "openedInMode" "SecurityMode" NOT NULL,
    "grouping" "SecurityIncidentGrouping" NOT NULL DEFAULT 'collecting',
    "state" "SecurityIncidentState" NOT NULL DEFAULT 'no_action',
    "severity" "SecuritySeverity" NOT NULL DEFAULT 'info',
    "reasonCodes" "SecurityReasonCode"[],
    "notifyState" "SecurityIncidentNotify" NOT NULL DEFAULT 'not_needed',
    "notifyAttempts" SMALLINT NOT NULL DEFAULT 0,
    "rulesetVersion" SMALLINT NOT NULL,
    "firstActivityAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "lastArrivalAt" TIMESTAMP(3) NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "countsByCamera" JSONB NOT NULL,
    "cameras" TEXT[],
    "spanByCamera" JSONB NOT NULL,
    "eventsKept" "SecurityIncidentEvents" NOT NULL DEFAULT 'kept',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateChangedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityIncidentReason" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "code" "SecurityReasonCode" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "rulesetVersion" SMALLINT NOT NULL,
    "evidenceEventId" BIGINT NOT NULL,
    "evidenceCamera" VARCHAR(64),
    "evidenceSource" "SecurityEventSource" NOT NULL,
    "evidenceKind" "SecurityEventKind" NOT NULL,
    "evidenceLabel" VARCHAR(64),
    "evidenceAt" TIMESTAMP(3) NOT NULL,
    "evidenceSummary" VARCHAR(500) NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityIncidentReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEventTriage" (
    "eventId" BIGINT NOT NULL,
    "outcome" "SecurityTriageOutcome" NOT NULL,
    "incidentId" TEXT,
    "matchedLinkIds" TEXT[],
    "alsoZoneIds" TEXT[],
    "rulesetVersion" SMALLINT NOT NULL,
    "error" VARCHAR(500),
    "triagedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEventTriage_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "SecurityIncidentAck" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "action" "SecurityIncidentAckAction" NOT NULL,
    "byUserId" TEXT NOT NULL,
    "byName" VARCHAR(120) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" VARCHAR(64),
    "sessionChecked" BOOLEAN NOT NULL DEFAULT false,
    "client" VARCHAR(120),
    "viaNotificationId" VARCHAR(64),
    "note" VARCHAR(280) NOT NULL DEFAULT '',

    CONSTRAINT "SecurityIncidentAck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityIncidentNotice" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" VARCHAR(120) NOT NULL,
    "reason" "SecurityNoticeReason" NOT NULL,
    "outcome" "SecurityNoticeOutcome" NOT NULL,
    "notificationLogId" VARCHAR(64),
    "channels" VARCHAR(32) NOT NULL DEFAULT '',
    "pushOutcome" "PushOutcome",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "SecurityIncidentNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityAlertRecipient" (
    "userId" TEXT NOT NULL,
    "state" "SecurityAlertRecipientState" NOT NULL,
    "origin" "SecurityAlertRecipientOrigin" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "setById" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAlertRecipient_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "SecurityIncidentEngineState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "startedAtId" BIGINT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triageFloor" BIGINT NOT NULL,
    "floorCandidate" BIGINT NOT NULL,
    "floorCandidateAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityIncidentEngineState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityIncident_grouping_scope_zoneId_scopeCamera_idx" ON "SecurityIncident"("grouping", "scope", "zoneId", "scopeCamera");

-- CreateIndex
CREATE INDEX "SecurityIncident_state_lastActivityAt_idx" ON "SecurityIncident"("state", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SecurityIncident_lastActivityAt_idx" ON "SecurityIncident"("lastActivityAt");

-- CreateIndex
CREATE INDEX "SecurityIncident_zoneId_lastActivityAt_idx" ON "SecurityIncident"("zoneId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SecurityIncident_notifyState_idx" ON "SecurityIncident"("notifyState");

-- CreateIndex
CREATE INDEX "SecurityIncidentReason_incidentId_idx" ON "SecurityIncidentReason"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityIncidentReason_incidentId_code_evidenceEventId_key" ON "SecurityIncidentReason"("incidentId", "code", "evidenceEventId");

-- CreateIndex
CREATE INDEX "SecurityEventTriage_incidentId_idx" ON "SecurityEventTriage"("incidentId");

-- CreateIndex
CREATE INDEX "SecurityEventTriage_outcome_triagedAt_idx" ON "SecurityEventTriage"("outcome", "triagedAt");

-- CreateIndex
CREATE INDEX "SecurityIncidentAck_incidentId_at_idx" ON "SecurityIncidentAck"("incidentId", "at");

-- CreateIndex
CREATE INDEX "SecurityIncidentNotice_userId_createdAt_idx" ON "SecurityIncidentNotice"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityIncidentNotice_outcome_createdAt_idx" ON "SecurityIncidentNotice"("outcome", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityIncidentNotice_incidentId_userId_key" ON "SecurityIncidentNotice"("incidentId", "userId");

-- AddForeignKey
ALTER TABLE "SecurityIncident" ADD CONSTRAINT "SecurityIncident_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "SecurityZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityIncidentReason" ADD CONSTRAINT "SecurityIncidentReason_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "SecurityIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEventTriage" ADD CONSTRAINT "SecurityEventTriage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "SecurityEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEventTriage" ADD CONSTRAINT "SecurityEventTriage_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "SecurityIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityIncidentAck" ADD CONSTRAINT "SecurityIncidentAck_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "SecurityIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityIncidentNotice" ADD CONSTRAINT "SecurityIncidentNotice_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "SecurityIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityAlertRecipient" ADD CONSTRAINT "SecurityAlertRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The retention leg's second count (§6.10): "last removed N events and M incidents".
ALTER TABLE "SecurityIngestState" ADD COLUMN "retentionIncidentsDeleted" INTEGER NOT NULL DEFAULT 0;

-- ── Hand-written CHECKs ─────────────────────────────────────────────────────

-- The scope's own columns, and only those: an area snapshot iff scope = area,
-- a camera iff scope = camera (a Frigate name).
ALTER TABLE "SecurityIncident" ADD CONSTRAINT "SecurityIncident_scope_shape" CHECK (
  "zoneLinkIds" IS NOT NULL AND "cameras" IS NOT NULL AND "reasonCodes" IS NOT NULL
  AND ("scope" = 'area') = ("zoneId" IS NOT NULL AND "zoneName" IS NOT NULL AND "zoneKind" IS NOT NULL)
  AND ("scope" = 'area' OR cardinality("zoneLinkIds") = 0)
  AND ("scope" = 'camera') = ("scopeCamera" IS NOT NULL)
  AND ("scopeCamera" IS NULL OR "scopeCamera" ~ '^[a-zA-Z0-9_-]{1,64}$')
);

-- State follows the codes: info iff no_action iff no code; resolved only once
-- sealed; closedAt iff closed; resolvedAt/By iff resolved; alert iff
-- notifyState left not_needed iff alertedAt.
ALTER TABLE "SecurityIncident" ADD CONSTRAINT "SecurityIncident_state_shape" CHECK (
  ("severity" = 'info') = ("state" = 'no_action')
  AND ("severity" = 'info') = (cardinality("reasonCodes") = 0)
  AND ("state" <> 'resolved' OR "grouping" = 'closed')
  AND ("grouping" = 'closed') = ("closedAt" IS NOT NULL)
  AND ("state" = 'resolved') = ("resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL)
  AND ("severity" = 'alert') = ("notifyState" <> 'not_needed')
  AND ("severity" = 'alert') = ("alertedAt" IS NOT NULL)
);

-- The span map is a JSON object (camera -> {first, last}): route 16 orders a
-- camera-limited viewer's list with jsonb_each over it (review R1).
ALTER TABLE "SecurityIncident" ADD CONSTRAINT "SecurityIncident_span" CHECK (
  "lastActivityAt" >= "firstActivityAt"
  AND jsonb_typeof("spanByCamera") = 'object'
  AND "eventCount" >= 1
  AND "rulesetVersion" >= 1
  AND "notifyAttempts" BETWEEN 0 AND 10
);

-- D18: severity comes from the code, and only after_hours_presence alerts in
-- P3. P4/P5 migrations widen this as their codes land.
ALTER TABLE "SecurityIncidentReason" ADD CONSTRAINT "SecurityIncidentReason_code_severity" CHECK (
  ("code" = 'after_hours_presence' AND "severity" = 'alert')
  OR ("code" IN ('camera_offline', 'threat_signal') AND "severity" = 'notice')
);

ALTER TABLE "SecurityIncidentReason" ADD CONSTRAINT "SecurityIncidentReason_camera" CHECK (
  "evidenceCamera" IS NULL OR "evidenceCamera" ~ '^[a-zA-Z0-9_-]{1,64}$'
);

-- A member iff grouped; an error iff failed; link and area lists only on a member.
ALTER TABLE "SecurityEventTriage" ADD CONSTRAINT "SecurityEventTriage_shape" CHECK (
  "matchedLinkIds" IS NOT NULL AND "alsoZoneIds" IS NOT NULL
  AND ("outcome" = 'grouped') = ("incidentId" IS NOT NULL)
  AND ("outcome" = 'failed') = ("error" IS NOT NULL)
  AND ("outcome" = 'grouped' OR (cardinality("matchedLinkIds") = 0 AND cardinality("alsoZoneIds") = 0))
);

-- A note belongs to a resolve.
ALTER TABLE "SecurityIncidentAck" ADD CONSTRAINT "SecurityIncidentAck_note" CHECK (
  "action" = 'resolve' OR "note" = ''
);

-- The live-session check can only have run for a token that carried a sign-in id.
ALTER TABLE "SecurityIncidentAck" ADD CONSTRAINT "SecurityIncidentAck_session" CHECK (
  NOT "sessionChecked" OR "sessionId" IS NOT NULL
);

-- A NotificationLog row iff one was written (queued/sent/not_sent/outcome_unknown);
-- settled iff not queued; transport snapshots only on a transported notice
-- (an outcome_unknown notice has none: its stamp is what was lost).
ALTER TABLE "SecurityIncidentNotice" ADD CONSTRAINT "SecurityIncidentNotice_shape" CHECK (
  ("outcome" IN ('queued', 'sent', 'not_sent', 'outcome_unknown')) = ("notificationLogId" IS NOT NULL)
  AND ("outcome" = 'queued') = ("settledAt" IS NULL)
  AND ("outcome" IN ('sent', 'not_sent') OR ("channels" = '' AND "pushOutcome" IS NULL))
);

-- One row; the floor never passes its candidate, and never drops below where
-- the engine started.
ALTER TABLE "SecurityIncidentEngineState" ADD CONSTRAINT "SecurityIncidentEngineState_shape" CHECK (
  "id" = 'singleton'
  AND "startedAtId" <= "triageFloor"
  AND "triageFloor" <= "floorCandidate"
);

-- ── SecurityEvent is append-only (ADR-059 §3.3; closes p2b-spec §2) ────────

CREATE FUNCTION "security_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SecurityEvent is append-only (ADR-059 §3.3): % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER "SecurityEvent_append_only" BEFORE UPDATE ON "SecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION "security_event_append_only"();
