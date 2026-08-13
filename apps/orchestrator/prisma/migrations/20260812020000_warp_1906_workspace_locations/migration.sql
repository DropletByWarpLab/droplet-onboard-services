-- WARP-1906 — premade business locations (building + named conference room).
--
-- One row per room; the building is a grouping label, not its own table
-- (v1 has no building-level metadata). No workspace FK: the box is a
-- single-workspace appliance (Workspace id=1 singleton, WARP-1341), so
-- route auth is the scoping boundary.
--
-- Additive only — new table, no backfill, no seed rows (locations are
-- customer data an admin enters). IF NOT EXISTS makes a re-run a no-op, so
-- `migrate deploy` on a box that already has the table is safe.

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkspaceLocation" (
    "id" TEXT NOT NULL,
    "building" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceLocation_building_room_key" ON "WorkspaceLocation"("building", "room");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkspaceLocation_building_idx" ON "WorkspaceLocation"("building");
