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

-- CreateEnum
CREATE TYPE "WorkshopWorkspaceStatus" AS ENUM ('active', 'proposed', 'archived');

-- CreateTable
CREATE TABLE "WorkshopWorkspace" (
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
CREATE INDEX "WorkshopWorkspace_userId_createdAt_idx" ON "WorkshopWorkspace"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WorkshopWorkspace_status_idx" ON "WorkshopWorkspace"("status");

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "workspaceId" TEXT;

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_createdAt_idx" ON "AgentRun"("workspaceId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "WorkshopWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
