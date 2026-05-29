-- WARP-474 — Phase G2. Smart-home scene + ordered scene actions.
--
-- One Scene row per operator-created scene ("Movie night", "Goodnight").
-- SceneAction is an ordered list of Matter commands; the run-handler
-- walks them by ascending `idx` and dispatches via sendMatterCommand
-- per action. Per-action failures are tolerated (logged + surfaced in
-- the run result) so a dead bulb mid-scene doesn't abort the rest.
--
-- ON DELETE CASCADE on SceneAction.sceneId — deleting the parent Scene
-- removes its actions atomically. Same posture as ChatMessage→ChatSession.
--
-- Idempotent: IF NOT EXISTS on tables and indexes. Same posture as the
-- WARP-456 / WARP-457 / WARP-460 / WARP-461 / WARP-467 / WARP-468 /
-- WARP-470 / WARP-473 migrations.

CREATE TABLE IF NOT EXISTS "Scene" (
    "id"        TEXT         NOT NULL,
    "name"      TEXT         NOT NULL,
    "icon"      TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scene_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Scene_createdAt_idx"
    ON "Scene"("createdAt");

CREATE TABLE IF NOT EXISTS "SceneAction" (
    "id"           TEXT    NOT NULL,
    "sceneId"      TEXT    NOT NULL,
    "idx"          INTEGER NOT NULL,
    "deviceNodeId" TEXT    NOT NULL,
    "command"      TEXT    NOT NULL,
    "args"         JSONB,

    CONSTRAINT "SceneAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SceneAction_sceneId_idx_idx"
    ON "SceneAction"("sceneId", "idx");

-- Wrap the FK in DO/EXCEPTION so the migration is idempotent across
-- re-applications. Postgres has no IF NOT EXISTS for constraints.
DO $$ BEGIN
    ALTER TABLE "SceneAction"
        ADD CONSTRAINT "SceneAction_sceneId_fkey"
        FOREIGN KEY ("sceneId") REFERENCES "Scene"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
