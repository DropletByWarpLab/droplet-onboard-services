-- Files: per-user folder colours (Finder-tag-style palette).
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces:
--   - FolderColor enum (red, orange, yellow, green, blue, purple, gray)
--   - FileFolderColor table, unique on (userId, ncFileId)
--
-- Keyed on `ncFileId` (oc:fileid) so a colour SURVIVES a rename/move, and on
-- the LOCAL User.id UUID because colours are personal: one user's palette is
-- invisible to every other user. "No colour" has no enum member — clearing a
-- colour deletes the row, so `color` is the row's single state. Same
-- no-FK-to-User shape as FileTag / FileComment (WARP-881).
--
-- Per the repo idiom: CREATE TYPE is duplicate_object guarded, CREATE TABLE
-- and CREATE INDEX use IF NOT EXISTS. This migration seeds NO rows.

DO $$ BEGIN
    CREATE TYPE "FolderColor" AS ENUM ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "FileFolderColor" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "ncFileId"  INTEGER NOT NULL,
    "color"     "FolderColor" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FileFolderColor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FileFolderColor_userId_ncFileId_key"
    ON "FileFolderColor" ("userId", "ncFileId");

CREATE INDEX IF NOT EXISTS "FileFolderColor_userId_idx"
    ON "FileFolderColor" ("userId");
