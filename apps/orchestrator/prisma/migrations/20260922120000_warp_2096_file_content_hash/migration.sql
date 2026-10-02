-- WARP-2096: content hash + size on the File registry, for duplicate-upload
-- detection. Both nullable (existing rows have neither); the index is NOT
-- unique — two copies of the same bytes are legitimate files.
ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "sha256" TEXT;
ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "sizeBytes" BIGINT;
CREATE INDEX IF NOT EXISTS "File_ownerUserId_sha256_idx" ON "File"("ownerUserId", "sha256");
