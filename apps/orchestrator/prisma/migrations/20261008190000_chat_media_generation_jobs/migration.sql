CREATE TYPE "MediaGenerationStatus" AS ENUM ('running', 'saving', 'succeeded', 'failed', 'cancelled');
CREATE TABLE "MediaGenerationJob" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "status" "MediaGenerationStatus" NOT NULL DEFAULT 'running',
  "result" JSONB,
  "error" TEXT,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MediaGenerationJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaGenerationJob_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MediaGenerationJob_ownerUserId_createdAt_idx" ON "MediaGenerationJob"("ownerUserId", "createdAt");
CREATE INDEX "MediaGenerationJob_status_deadlineAt_idx" ON "MediaGenerationJob"("status", "deadlineAt");
-- One offline worker globally, including during an orchestrator restart or
-- concurrent submitters. The API returns busy instead of queuing user bytes.
CREATE UNIQUE INDEX "MediaGenerationJob_active_slot_key" ON "MediaGenerationJob" ((TRUE)) WHERE "status" IN ('running', 'saving');
