-- ADR-003 + ADR-005: workspace_type — Home vs Business.
--
-- Singleton table (id = 1 always). Drives the dashboard's
-- WorkspaceProvider + the setup wizard's "pick your workspace" step
-- (Phase 4b). Owner-only POST to /api/settings/workspace flips it.
--
-- Defaults to HOME if the row doesn't exist yet — matches the
-- localStorage fallback already in
-- apps/web-dashboard/src/lib/workspace.tsx. We deliberately do NOT
-- seed a row here: the orchestrator's settings/workspace.ts returns
-- the HOME default on first read + upserts on first write. That way
-- an existing installation continues without an implicit "Business"
-- decision being made for it.

BEGIN;

CREATE TYPE "WorkspaceType" AS ENUM ('HOME', 'BUSINESS');

CREATE TABLE "Workspace" (
    "id"          INTEGER         NOT NULL DEFAULT 1,
    "type"        "WorkspaceType" NOT NULL DEFAULT 'HOME',
    "displayName" TEXT,
    "setBy"       TEXT,
    "setAt"       TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

COMMIT;
