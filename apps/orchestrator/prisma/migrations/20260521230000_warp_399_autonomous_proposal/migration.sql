-- WARP-399 — autonomous-agent Tier-2 deferral inbox.
--
-- When an autonomous agent run (e.g. the smart-port adoption flow on
-- smart-port/event MQTT) picks a Tier-2 tool, the agent loop stages
-- the proposed dispatch here instead of executing it. The ops-console
-- inbox lists status=pending rows; operator click-to-approve flips
-- them to approved and re-runs the original tool through the normal
-- interactive path. The cron-runtime sweep marks anything past
-- expiresAt as expired (default 1h).
--
-- agentRunId references the CommandAuditLog row that captured the
-- autonomous run's full trace; the drawer renders the agent's
-- reasoning alongside the proposed action. Not a FK so we can write
-- the proposal row before the audit row commits (and so an audit-row
-- purge doesn't cascade-delete history out of the inbox).

BEGIN;

CREATE TABLE "AutonomousProposal" (
    "id"               TEXT         NOT NULL,
    "domain"           TEXT         NOT NULL,
    "entityId"         TEXT         NOT NULL,
    "toolName"         TEXT         NOT NULL,
    "toolArgs"         JSONB        NOT NULL,
    "tier"             INTEGER      NOT NULL,
    "status"           TEXT         NOT NULL DEFAULT 'pending',
    "resolvedByUserId" TEXT,
    "resolvedAt"       TIMESTAMP(3),
    "expiresAt"        TIMESTAMP(3) NOT NULL,
    "agentRunId"       TEXT         NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutonomousProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutonomousProposal_status_expiresAt_idx"
    ON "AutonomousProposal" ("status", "expiresAt");

CREATE INDEX "AutonomousProposal_domain_entityId_createdAt_idx"
    ON "AutonomousProposal" ("domain", "entityId", "createdAt");

COMMIT;
