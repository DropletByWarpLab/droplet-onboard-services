-- feat/scene-schedules — recurring cadence for a saved Scene (routine).
--
-- One SceneSchedule row binds a Scene to an RRULE cadence. The
-- scene-schedule-ticker (60s interval, pg advisory lock) scans rows
-- where `enabled = true AND nextFireAt <= now()`, runs the parent Scene
-- via the shared executeScene path (triggeredBy="scheduler"), then
-- advances `nextFireAt` from the RRULE. EXACT clone of the WARP-463
-- ToolSchedule pattern.
--
-- State is the explicit `enabled` column + `nextFireAt` — never derived
-- from a NULL. `lastFiredAt` is provenance (NULL = never fired yet), not
-- state: a malformed RRULE or a deleted parent flips `enabled = false`.
--
-- ON DELETE CASCADE on SceneSchedule.sceneId — deleting the parent Scene
-- removes its schedules atomically. Same posture as SceneAction→Scene.
--
-- Idempotent: IF NOT EXISTS on the table and indexes; the FK is wrapped
-- in DO/EXCEPTION (Postgres has no IF NOT EXISTS for constraints). Same
-- posture as the WARP-462 (ToolSchedule) and WARP-474 (Scene) migrations,
-- so a re-apply is a no-op.

CREATE TABLE IF NOT EXISTS "SceneSchedule" (
    "id"          TEXT         NOT NULL,
    "sceneId"     TEXT         NOT NULL,
    "rrule"       TEXT         NOT NULL,
    "nextFireAt"  TIMESTAMP(3) NOT NULL,
    "enabled"     BOOLEAN      NOT NULL DEFAULT true,
    "createdBy"   TEXT,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SceneSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SceneSchedule_nextFireAt_idx"
    ON "SceneSchedule"("nextFireAt");
CREATE INDEX IF NOT EXISTS "SceneSchedule_sceneId_idx"
    ON "SceneSchedule"("sceneId");

-- Wrap the FK in DO/EXCEPTION so re-applying the migration is a no-op.
-- Postgres has no IF NOT EXISTS for constraints.
DO $$ BEGIN
    ALTER TABLE "SceneSchedule"
        ADD CONSTRAINT "SceneSchedule_sceneId_fkey"
        FOREIGN KEY ("sceneId") REFERENCES "Scene"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
