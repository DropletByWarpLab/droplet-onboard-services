-- WARP-3193 PERF-15 — index FileIndexStatus.ncFileId.
--
-- The filing orphan sweep (src/services/filing/maintenance.ts) asks "does a
-- status row still exist for these files?" with `WHERE "ncFileId" IN (…)`.
-- The table's keys are (userId, path), (userId, status) and
-- (extractStatus, updatedAt), so that lookup was a sequential scan of every
-- indexed file on the box, once per nightly batch.
--
-- An index only: services/file-indexer/db.py INSERTs this table naming its
-- columns explicitly, and an index changes nothing it writes.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FileIndexStatus_ncFileId_idx" ON "FileIndexStatus"("ncFileId");
