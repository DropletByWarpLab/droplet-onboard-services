-- ADR-055 (P4a) — when a door's position source last changed.
--
-- A door's position is read from its newest position event. After the owner
-- changes `doorPositionSource` (lock -> dp1, say), that event was reported
-- under the OLD wiring and says nothing about the door as it is wired now. The
-- doors service compares the event against this column and reports the
-- position as unknown until an event newer than the change arrives.
--
-- An explicit column, not a reading of `updatedAt`: a rename or a held-open
-- change also moves `updatedAt`, and must not blank the position.

-- AlterTable
ALTER TABLE "AccessPoint" ADD COLUMN IF NOT EXISTS "doorPositionSourceSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
