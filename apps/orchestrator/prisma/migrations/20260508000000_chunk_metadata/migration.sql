-- WARP-214: free-form per-chunk metadata for breadcrumbs + source-channel badge.
ALTER TABLE "FileContentChunk"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;
