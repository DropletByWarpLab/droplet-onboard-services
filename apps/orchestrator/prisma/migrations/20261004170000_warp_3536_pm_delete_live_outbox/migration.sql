-- WARP-3536: keep an ID-only transactional tombstone when deleting a work
-- item so pm-live can notify readers after the ordinary activity cascade.

ALTER TABLE "PmActivity"
  ALTER COLUMN "workItemId" DROP NOT NULL,
  ADD COLUMN "deletedProjectId" TEXT,
  ADD COLUMN "deletedWorkItemId" TEXT,
  ADD COLUMN "deletedGuestUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "PmActivity" ADD CONSTRAINT "PmActivity_deletedProjectId_fkey"
  FOREIGN KEY ("deletedProjectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ordinary history remains attached to a work item and keeps cascading as
-- before. Only `deleted` rows may detach; they carry IDs, never item content.
ALTER TABLE "PmActivity" ADD CONSTRAINT "PmActivity_deleted_tombstone_shape"
  CHECK (
    (
      "verb" = 'deleted'
      AND "workItemId" IS NULL
      AND "deletedProjectId" IS NOT NULL
      AND "deletedWorkItemId" IS NOT NULL
      AND "notifyStatus" = 'not_needed'
      AND "notifiedAt" IS NULL
    )
    OR
    (
      "verb" <> 'deleted'
      AND "workItemId" IS NOT NULL
      AND "deletedProjectId" IS NULL
      AND "deletedWorkItemId" IS NULL
      AND cardinality("deletedGuestUserIds") = 0
    )
  );
