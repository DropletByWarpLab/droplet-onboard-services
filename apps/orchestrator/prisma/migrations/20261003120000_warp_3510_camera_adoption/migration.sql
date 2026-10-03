-- WARP-3510: Camera.adoption, whether a row is a real camera or a discovery
-- candidate.
--
-- A Camera row has meant two different things and nothing said which: a camera
-- the operator has in Frigate, or a device camera-discovery merely found on the
-- LAN. `enabled` is an operator toggle (POST /cameras/:name/disable writes it on
-- a working camera) and `autoDiscovered` records who first created the row;
-- neither says "this camera is in Frigate and belongs to the operator".
-- CLAUDE.md "no guessing": the state is an explicit enum, never inferred from
-- either column.
--
--   CANDIDATE  found on the network, not yet in Frigate. A placeholder:
--              discovery may rename, merge or delete it.
--   ADOPTED    in Frigate and owned by the operator. Discovery never renames,
--              merges away or prunes it.
--
-- Backfill. Existing rows take the column default (CANDIDATE) and the single
-- UPDATE below promotes the real cameras. The rule: a CANDIDATE is a discovery
-- placeholder, and until now a placeholder was always written
-- `enabled = false` AND `autoDiscovered = true` (a camera discovery had verified
-- and committed to Frigate is created enabled, accepting a candidate sets
-- enabled = true, and a camera the operator added has autoDiscovered = false).
-- Every other row is an operator-owned camera, so a row is ADOPTED when
-- `enabled = true OR autoDiscovered = false`.
--
-- Known limit of that rule: an auto-discovered camera the operator has since
-- disabled is the same pair of columns as a placeholder, so no existing column
-- can tell the two apart and it backfills as CANDIDATE.
--
-- Idempotent: CREATE TYPE is duplicate_object guarded, ADD COLUMN IF NOT EXISTS,
-- and a re-run of the backfill changes nothing: it only touches CANDIDATE rows
-- and the rule is deterministic, so the first run already moved every row it
-- applies to.

DO $$ BEGIN
    CREATE TYPE "CameraAdoption" AS ENUM ('CANDIDATE', 'ADOPTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Camera"
    ADD COLUMN IF NOT EXISTS "adoption" "CameraAdoption" NOT NULL DEFAULT 'CANDIDATE';

UPDATE "Camera"
SET "adoption" = 'ADOPTED'
WHERE "adoption" = 'CANDIDATE'
  AND ("enabled" = true OR "autoDiscovered" = false);
