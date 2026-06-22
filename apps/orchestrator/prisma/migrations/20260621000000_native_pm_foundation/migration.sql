-- CreateEnum
CREATE TYPE "PmStateGroup" AS ENUM ('backlog', 'unstarted', 'started', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "PmPriority" AS ENUM ('urgent', 'high', 'medium', 'low', 'none');

-- CreateEnum
CREATE TYPE "PmCycleStatus" AS ENUM ('draft', 'active', 'completed');

-- CreateEnum
CREATE TYPE "PmModuleStatus" AS ENUM ('backlog', 'planned', 'in_progress', 'paused', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "PmPropertyType" AS ENUM ('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'member');

-- CreateTable
CREATE TABLE "PmWorkspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "leadId" TEXT,
    "seqCounter" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmState" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" "PmStateGroup" NOT NULL DEFAULT 'backlog',
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmLabel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmWorkItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sequenceId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "descriptionHtml" TEXT,
    "stateId" TEXT,
    "priority" "PmPriority" NOT NULL DEFAULT 'none',
    "parentId" TEXT,
    "cycleId" TEXT,
    "createdById" TEXT,
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "sortOrder" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmWorkItemAssignee" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmWorkItemAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmWorkItemLabel" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,

    CONSTRAINT "PmWorkItemLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmComment" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "authorId" TEXT,
    "commentHtml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmCycle" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" "PmCycleStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmModule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "leadId" TEXT,
    "status" "PmModuleStatus" NOT NULL DEFAULT 'backlog',
    "startDate" TIMESTAMP(3),
    "targetDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmModuleWorkItem" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,

    CONSTRAINT "PmModuleWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmCustomProperty" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PmPropertyType" NOT NULL,
    "options" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmCustomProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmWorkItemPropertyValue" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmWorkItemPropertyValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmAttachment" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmActivity" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "actorId" TEXT,
    "verb" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PmWorkspace_slug_key" ON "PmWorkspace"("slug");

-- CreateIndex
CREATE INDEX "PmProject_workspaceId_sortOrder_idx" ON "PmProject"("workspaceId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PmProject_workspaceId_identifier_key" ON "PmProject"("workspaceId", "identifier");

-- CreateIndex
CREATE INDEX "PmState_projectId_sortOrder_idx" ON "PmState"("projectId", "sortOrder");

-- CreateIndex
CREATE INDEX "PmLabel_projectId_idx" ON "PmLabel"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PmLabel_projectId_name_key" ON "PmLabel"("projectId", "name");

-- CreateIndex
CREATE INDEX "PmWorkItem_projectId_stateId_sortOrder_idx" ON "PmWorkItem"("projectId", "stateId", "sortOrder");

-- CreateIndex
CREATE INDEX "PmWorkItem_projectId_updatedAt_idx" ON "PmWorkItem"("projectId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "PmWorkItem_parentId_idx" ON "PmWorkItem"("parentId");

-- CreateIndex
CREATE INDEX "PmWorkItem_cycleId_idx" ON "PmWorkItem"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "PmWorkItem_projectId_sequenceId_key" ON "PmWorkItem"("projectId", "sequenceId");

-- CreateIndex
CREATE INDEX "PmWorkItemAssignee_userId_idx" ON "PmWorkItemAssignee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PmWorkItemAssignee_workItemId_userId_key" ON "PmWorkItemAssignee"("workItemId", "userId");

-- CreateIndex
CREATE INDEX "PmWorkItemLabel_labelId_idx" ON "PmWorkItemLabel"("labelId");

-- CreateIndex
CREATE UNIQUE INDEX "PmWorkItemLabel_workItemId_labelId_key" ON "PmWorkItemLabel"("workItemId", "labelId");

-- CreateIndex
CREATE INDEX "PmComment_workItemId_createdAt_idx" ON "PmComment"("workItemId", "createdAt");

-- CreateIndex
CREATE INDEX "PmCycle_projectId_idx" ON "PmCycle"("projectId");

-- CreateIndex
CREATE INDEX "PmModule_projectId_idx" ON "PmModule"("projectId");

-- CreateIndex
CREATE INDEX "PmModuleWorkItem_workItemId_idx" ON "PmModuleWorkItem"("workItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PmModuleWorkItem_moduleId_workItemId_key" ON "PmModuleWorkItem"("moduleId", "workItemId");

-- CreateIndex
CREATE INDEX "PmCustomProperty_projectId_sortOrder_idx" ON "PmCustomProperty"("projectId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PmCustomProperty_projectId_name_key" ON "PmCustomProperty"("projectId", "name");

-- CreateIndex
CREATE INDEX "PmWorkItemPropertyValue_propertyId_idx" ON "PmWorkItemPropertyValue"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "PmWorkItemPropertyValue_workItemId_propertyId_key" ON "PmWorkItemPropertyValue"("workItemId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "PmAttachment_storageKey_key" ON "PmAttachment"("storageKey");

-- CreateIndex
CREATE INDEX "PmAttachment_workItemId_idx" ON "PmAttachment"("workItemId");

-- CreateIndex
CREATE INDEX "PmActivity_workItemId_createdAt_idx" ON "PmActivity"("workItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "PmProject" ADD CONSTRAINT "PmProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "PmWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmState" ADD CONSTRAINT "PmState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmLabel" ADD CONSTRAINT "PmLabel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItem" ADD CONSTRAINT "PmWorkItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItem" ADD CONSTRAINT "PmWorkItem_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "PmState"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItem" ADD CONSTRAINT "PmWorkItem_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "PmWorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItem" ADD CONSTRAINT "PmWorkItem_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "PmCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItemAssignee" ADD CONSTRAINT "PmWorkItemAssignee_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItemLabel" ADD CONSTRAINT "PmWorkItemLabel_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItemLabel" ADD CONSTRAINT "PmWorkItemLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "PmLabel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmComment" ADD CONSTRAINT "PmComment_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmCycle" ADD CONSTRAINT "PmCycle_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmModule" ADD CONSTRAINT "PmModule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmModuleWorkItem" ADD CONSTRAINT "PmModuleWorkItem_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "PmModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmModuleWorkItem" ADD CONSTRAINT "PmModuleWorkItem_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmCustomProperty" ADD CONSTRAINT "PmCustomProperty_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItemPropertyValue" ADD CONSTRAINT "PmWorkItemPropertyValue_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWorkItemPropertyValue" ADD CONSTRAINT "PmWorkItemPropertyValue_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "PmCustomProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmAttachment" ADD CONSTRAINT "PmAttachment_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmActivity" ADD CONSTRAINT "PmActivity_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

