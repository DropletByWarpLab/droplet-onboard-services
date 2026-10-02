-- WARP-2896 (ADR-056 slice G) — the workshop's workspaces.
--
-- A workspace is a bare git repository on the sandbox's `workspace-git`
-- volume plus a working checkout; this table is the orchestrator's index of
-- them (owner, template, status, the last proposal tag). Named for the
-- surface: `Workspace` is the box's own singleton row (org, slug). The repository
-- itself never lives in Postgres — it is what device-backup.sh captures from
-- the volume — so a row here with no repository behind it is the "created
-- in the DB, sandbox call failed" case the route rolls back, never a state
-- the box runs in.
--
-- `AgentRun.workspaceId` binds a WORKSHOP run to the one workspace it may
-- touch. NULL is every ordinary run. The `/api/workspace/:id/*` routes read
-- the run named in the request and refuse when its workspaceId is not the
-- `:id` asked for — "run owns workspace" — so a prompt cannot steer a run
-- into another person's extension work. `ON DELETE SET NULL`, as the
-- schedule FK: deleting a workspace keeps the history of what ran in it.
--
-- RE-STAMPED, AND THEREFORE RE-RUNNABLE. This migration was written as
-- `20260920120000_warp_2896_workspace` and moved here immediately before
-- merge (Stefan 2026-09-23: re-stamp to sort after every migration already
-- on stage — `20260924000100_*` — so the history applies in the order it
-- was written). A box that ran the pre-merge build (.195, for the WARP-2896
-- live proof) holds a journal row under the OLD name, so `migrate deploy`
-- sees this folder as never applied and runs it again over a schema that
-- already has every object below. Every statement is therefore idempotent
-- (IF NOT EXISTS / DO … EXCEPTION / a pg_constraint check), the WARP-456
-- rename's pattern.
--
-- The OLD-NAME JOURNAL ROW IS LEFT IN PLACE ON PURPOSE — no journal-fix
-- migration, unlike WARP-484. The old folder's SQL is NOT idempotent, and
-- stacked branches still carry it until they merge stage (and .195 has run
-- those builds). Delete the old row and the next deploy of any such build
-- re-runs `CREATE TYPE "WorkshopWorkspaceStatus"` — P3018 / 42710, a failed
-- migration, a dark box. Keep it and every direction works. Proven against
-- pgvector/pg16 with Prisma 5.22: old build → this build → this build again →
-- back to the old build → this build again, all exit 0 with the data intact,
-- and `migrate status` from either codebase says "Database schema is up to
-- date!" (an applied migration with no local folder is not reported, so
-- migrate-and-start.sh's pending check stays quiet). The only trace is one
-- extra journal row on boxes that ran the pre-merge build, and `workspaceId`
-- sitting before WARP-2997's AgentRun columns there instead of after them
-- (physical column order only; nothing here addresses AgentRun by position).

-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "WorkshopWorkspaceStatus" AS ENUM ('active', 'proposed', 'archived');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkshopWorkspace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template" TEXT,
    "status" "WorkshopWorkspaceStatus" NOT NULL DEFAULT 'active',
    "proposedTag" TEXT,
    "proposedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkshopWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkshopWorkspace_userId_createdAt_idx" ON "WorkshopWorkspace"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkshopWorkspace_status_idx" ON "WorkshopWorkspace"("status");

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "workspaceId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRun_workspaceId_createdAt_idx" ON "AgentRun"("workspaceId", "createdAt" DESC);

-- One live run per workspace, held by the database and not by the route's
-- count-then-create: two starts racing through `POST /api/agent-runs` could
-- both see zero active runs and both land on one checkout — exactly the
-- "commit over each other" the route exists to prevent. Partial: a NULL
-- workspaceId is every ordinary run, and a run that ends (succeeded / failed
-- / cancelled) releases the workspace. The status list is
-- ACTIVE_AGENT_RUN_STATUSES in agent-run-worker.service.ts. Prisma has no
-- datamodel syntax for a WHERE-filtered unique index, so this lives in SQL
-- only — `PmCycle_projectId_active_key` is the precedent — and the drift
-- gate does not report partial indexes (schema-drift-baseline.sql, "NOT AN
-- ENTRY"). The route maps the P2002 this raises onto its own 409.
CREATE UNIQUE INDEX IF NOT EXISTS "AgentRun_workspaceId_active_key" ON "AgentRun"("workspaceId")
  WHERE "workspaceId" IS NOT NULL AND "status" IN ('queued', 'running', 'awaiting_confirmation');

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AgentRun_workspaceId_fkey'
    ) THEN
        ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "WorkshopWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
