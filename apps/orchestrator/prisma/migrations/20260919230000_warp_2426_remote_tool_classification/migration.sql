-- WARP-2426 (ADR-043 §2, ADR-056 I4) — the operator-owned classification
-- record for tools this box did not author.
--
-- Every remote MCP tool the box discovers lands here as a CONFIRMING WRITE
-- (requiresWrite + requiresConfirmation both true, denied false) through one
-- import path, whatever the wire claims the tool is. A person demotes it — to
-- a read, or to blocked — through the owner route, which is the only writer
-- of reviewedBy / reviewedAt. State is explicit: a missing row means "never
-- discovered" and the call policy refuses it with its own code; it is never
-- read as "allowed" or as "denied".
--
-- The column defaults mirror the service's import default so a row inserted
-- by hand (a migration, a seed, a psql session) is a confirming write too.
CREATE TABLE "RemoteToolClassification" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "requiresWrite" BOOLEAN NOT NULL DEFAULT true,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "denied" BOOLEAN NOT NULL DEFAULT false,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "wireDescription" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteToolClassification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RemoteToolClassification_serverId_toolName_key" ON "RemoteToolClassification"("serverId", "toolName");

CREATE INDEX "RemoteToolClassification_serverId_idx" ON "RemoteToolClassification"("serverId");
