-- WARP-3538 — SharePoint document libraries on the Microsoft 365 connector, and
-- the first landing target for what the sync engine reads (ADR-041 §4): ONE
-- provider-agnostic cloud-file store, because Google Drive and Dropbox land into
-- the same tables right after this and are found by the same search tool.
--
-- 1. M365Connection.sharePointEnabled — the person's explicit opt-in (default
--    false, so every existing connection stays exactly as it was and is never
--    asked for the extra scope). M365Connection.sharePointLibrariesCapped — how
--    many libraries the last discovery that could say found beyond the
--    per-person cap and did not register; the card shows it, and nothing else
--    keeps it because a dropped library has no row.
--
-- 2. CloudFileProvider / CloudFileSourceKind — the two closed vocabularies. One
--    provider today (M365) and two kinds (ONEDRIVE, SHAREPOINT_LIBRARY); the
--    connectors that follow add theirs with an additive ALTER TYPE, each in the
--    change that writes it.
--
-- 3. CloudFileSource — a container a person's sync reads: their OneDrive or one
--    SharePoint library. The identity and (encrypted) display names a cursor,
--    which knows only a drive id, cannot supply.
--
-- 4. CloudFileItem — one row per file or folder. METADATA only. The
--    human-readable columns (name, URL, last modifier) are `dcv1:` blobs under
--    their own column-crypto label; ids, flags, sizes and timestamps stay clear
--    because the table is filtered, ordered and swept by them. `sweepPending` is
--    the explicit state of a full enumeration's sweep.
--
-- Neither table has a foreign key to a user, like every cloud-connector table:
-- disconnect, a leaver's deletion and switching SharePoint off delete their rows
-- by hand.
--
-- 5. The data reset below. OneDrive cursors that exist today already hold a
--    deltaLink from days of count-and-discard (`handlePage` was never wired).
--    Continuing one would land only FUTURE changes and never the files that
--    already exist — the person would see an empty OneDrive in search while the
--    card said "synced". Each is therefore sent back to a fresh enumeration
--    (RESYNC_REQUIRED, no delta link, no resume checkpoint), whose first page
--    marks and whose last page sweeps, so the table ends up holding exactly what
--    the drive holds.
--
--    Guarded on "this person has landed no Microsoft 365 rows yet", which is what
--    makes it RE-RUNNABLE like the rest of this migration (the repo idiom: branch
--    migrations are re-stamped before merge): the tables are created just above,
--    so on the first run every `files` cursor qualifies, and a re-run never
--    restarts an enumeration that has already begun to land.
--
-- RE-RUNNABLE: enums in DO blocks that swallow duplicate_object, columns, tables
-- and indexes IF NOT EXISTS.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "CloudFileProvider" AS ENUM ('M365');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "CloudFileSourceKind" AS ENUM ('ONEDRIVE', 'SHAREPOINT_LIBRARY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "M365Connection"
    ADD COLUMN IF NOT EXISTS "sharePointEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "sharePointLibrariesCapped" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CloudFileSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "CloudFileProvider" NOT NULL,
    "kind" "CloudFileSourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "siteId" TEXT,
    "siteNameEnc" TEXT,
    "nameEnc" TEXT NOT NULL,
    "webUrlEnc" TEXT,
    "followed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudFileSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CloudFileItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "CloudFileProvider" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "isFolder" BOOLEAN NOT NULL,
    "nameEnc" TEXT NOT NULL,
    "webUrlEnc" TEXT,
    "lastModifiedByEnc" TEXT,
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "remoteCreatedAt" TIMESTAMP(3),
    "remoteModifiedAt" TIMESTAMP(3),
    "sweepPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudFileItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CloudFileSource_userId_idx" ON "CloudFileSource"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CloudFileSource_userId_provider_sourceId_key" ON "CloudFileSource"("userId", "provider", "sourceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CloudFileItem_userId_provider_sourceId_parentExternalId_idx" ON "CloudFileItem"("userId", "provider", "sourceId", "parentExternalId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CloudFileItem_userId_remoteModifiedAt_idx" ON "CloudFileItem"("userId", "remoteModifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CloudFileItem_userId_provider_sourceId_externalId_key" ON "CloudFileItem"("userId", "provider", "sourceId", "externalId");

-- Data: OneDrive starts over, so it actually lands (see point 5 above).
-- `lastError` is cleared with the rest: a resync is a normal transition, not a
-- failure (delta-cursor.service.ts does the same when Graph answers 410).
UPDATE "M365DeltaCursor" AS c
SET "deltaLink" = NULL,
    "resumeLink" = NULL,
    "state" = 'RESYNC_REQUIRED',
    "consecutiveFailures" = 0,
    "nextAttemptAt" = NULL,
    "lastError" = NULL
WHERE c."workload" = 'files'
  AND NOT EXISTS (
      SELECT 1
      FROM "CloudFileItem" AS i
      WHERE i."userId" = c."userId"
        AND i."provider" = 'M365'
  );
