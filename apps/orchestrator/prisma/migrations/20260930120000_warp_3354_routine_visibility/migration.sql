-- WARP-3354 — a routine is private to its creator unless shared with the
-- Workspace. EXPLICIT enum column on ToolSpec, never derived from ownerId or
-- the unread free-text `share` column (CLAUDE.md "no guessing").
CREATE TYPE "ToolSpecVisibility" AS ENUM ('PRIVATE', 'WORKSPACE');

-- The default exists only so ADD COLUMN can fill the rows already there; it is
-- dropped below so every creator has to say which visibility it wants.
ALTER TABLE "ToolSpec"
  ADD COLUMN "visibility" "ToolSpecVisibility" NOT NULL DEFAULT 'WORKSPACE';

-- Backfill. Live routines and mined suggestions stay WORKSPACE: until now every
-- member saw them and teams may already run them or have them scheduled, so
-- nothing may vanish on upgrade. Drafts become PRIVATE: a draft is its author's
-- unfinished work (names, step arguments, code) and was never meant for anyone
-- else; owners and admins still see it, and they can share it.
UPDATE "ToolSpec" SET "visibility" = 'PRIVATE' WHERE "status" = 'draft';

ALTER TABLE "ToolSpec" ALTER COLUMN "visibility" DROP DEFAULT;
