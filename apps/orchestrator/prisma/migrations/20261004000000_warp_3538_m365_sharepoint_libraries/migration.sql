-- WARP-3538 — SharePoint document libraries on the Microsoft 365 connector, and
-- the first landing target for what the sync engine reads (ADR-041 §4).
--
-- 1. M365Connection.sharePointEnabled — the person's explicit opt-in (default
--    false, so every existing connection stays exactly as it was and is never
--    asked for the extra scope). M365Connection.sharePointLibrariesCapped — how
--    many libraries the last discovery that could say found beyond the
--    per-person cap and did not register; the card shows it, and nothing else
--    keeps it because a dropped library has no row.
--
-- 2. M365DriveItem — one row per file or folder of a person's OneDrive or of a
--    SharePoint library they can open. METADATA only. The human-readable
--    columns (name, URL, last modifier) are `dcv1:` blobs under their own
--    column-crypto label; ids, flags, sizes and timestamps stay clear because
--    the table is filtered, ordered and swept by them. `sweepPending` is the
--    explicit state of a full enumeration's sweep.
--
-- 3. M365SharePointLibrary — the identity and (encrypted) display names of a
--    discovered library, which the cursor alone cannot supply.
--
-- Neither table has a foreign key to a user, like every M365 table: disconnect,
-- a leaver's deletion and switching SharePoint off delete their rows by hand.
--
-- 4. The data reset below. OneDrive cursors that exist today already hold a
--    deltaLink from days of count-and-discard (`handlePage` was never wired).
--    Continuing one would land only FUTURE changes and never the files that
--    already exist — the person would see an empty OneDrive in search while the
--    card said "synced". Each is therefore sent back to a fresh enumeration
--    (RESYNC_REQUIRED, no delta link, no resume checkpoint), whose first page
--    marks and whose last page sweeps, so the table ends up holding exactly what
--    the drive holds.
--
--    Guarded on "this person has landed no OneDrive rows yet", which is what
--    makes it RE-RUNNABLE like the rest of this migration (the repo idiom:
--    branch migrations are re-stamped before merge): the tables are created just
--    above, so on the first run every `files` cursor qualifies, and a re-run
--    never restarts an enumeration that has already begun to land.
--
-- RE-RUNNABLE: columns, tables and indexes IF NOT EXISTS.

-- AlterTable
ALTER TABLE "M365Connection"
    ADD COLUMN IF NOT EXISTS "sharePointEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "sharePointLibrariesCapped" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "M365DriveItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workload" TEXT NOT NULL,
    "driveId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "parentItemId" TEXT,
    "isFolder" BOOLEAN NOT NULL,
    "nameEnc" TEXT NOT NULL,
    "webUrlEnc" TEXT,
    "lastModifiedByEnc" TEXT,
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "createdAtRemote" TIMESTAMP(3),
    "lastModifiedAtRemote" TIMESTAMP(3),
    "sweepPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365DriveItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "M365SharePointLibrary" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "driveId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "siteNameEnc" TEXT NOT NULL,
    "libraryNameEnc" TEXT NOT NULL,
    "webUrlEnc" TEXT NOT NULL,
    "followed" BOOLEAN NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365SharePointLibrary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "M365DriveItem_userId_workload_idx" ON "M365DriveItem"("userId", "workload");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "M365DriveItem_userId_lastModifiedAtRemote_idx" ON "M365DriveItem"("userId", "lastModifiedAtRemote");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "M365DriveItem_userId_driveId_itemId_key" ON "M365DriveItem"("userId", "driveId", "itemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "M365SharePointLibrary_userId_idx" ON "M365SharePointLibrary"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "M365SharePointLibrary_userId_driveId_key" ON "M365SharePointLibrary"("userId", "driveId");

-- Data: OneDrive starts over, so it actually lands (see point 4 above).
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
      FROM "M365DriveItem" AS i
      WHERE i."userId" = c."userId"
        AND i."workload" = 'files'
  );
