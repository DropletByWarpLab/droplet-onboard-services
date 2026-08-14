-- WARP-1749 (ADR-036 Phase 2) — rollback journal for the model-id migration.
--
-- PURELY ADDITIVE, AND DELIBERATELY DATA-FREE.
--
-- Two new tables, both created EMPTY. No column is added to and no row is
-- touched in any existing table. Running this migration changes the behaviour
-- of the appliance in exactly no way — which is the point: `migrate deploy`
-- runs on every container start (apps/orchestrator/scripts/migrate-and-start.sh),
-- so anything in here would run on boot, and the model-id rewrite must NOT.
--
-- The rewrite itself lives in `npm run model-id-migrate`, is an explicit
-- operator step, and is ordered relative to the INFERENCE_RUNTIME flip — see
-- docs/MODEL_ID_MIGRATION.md for the ordering and what breaks if it is done
-- backwards. This migration only gives that command somewhere to record what
-- it did so it can be undone.
--
-- WHY A JOURNAL AND NOT A REVERSED TABLE
-- --------------------------------------
-- The Ollama→OCI map is many-to-one: `gemma4:26b` and `gemma4:31b` both map to
-- `ai/gemma4`, `qwen3-vl:8b` and `qwen3-vl:32b` both map to `ai/qwen3-vl`
-- (apps/orchestrator/src/services/model-id-map.ts). Inverting that by lookup is
-- impossible — `ai/gemma4` cannot tell you which tier the row used to name. A
-- record of the actual before-value can, and nothing else can.
--
-- STATE IS AN EXPLICIT COLUMN (CLAUDE.md rule 10). `ModelIdMigrationBatch.state`
-- is `applied` | `reverted`, written as a real value. Rollback does NOT infer
-- "this batch is still live" from the absence of a later row.
--
-- Re-runnable: every statement uses IF NOT EXISTS and no row is seeded, so a
-- second `migrate deploy` is a no-op with no row-count to drift.

-- ── ModelIdMigrationBatch ──

CREATE TABLE IF NOT EXISTS "ModelIdMigrationBatch" (
    "id"             TEXT         NOT NULL,
    -- 'forward' (Ollama→OCI) | 'backward' (the revert).
    "direction"      TEXT         NOT NULL,
    -- 'applied' | 'reverted'. A 'backward' batch is born 'applied' and is
    -- never itself reverted; re-running forward creates a NEW forward batch.
    "state"          TEXT         NOT NULL,
    -- Provenance, not state: on a 'backward' batch, the forward batch it undid.
    "revertsBatchId" TEXT,
    -- Operator's --note, so a box can say why this was run.
    "note"           TEXT,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelIdMigrationBatch_pkey" PRIMARY KEY ("id")
);

-- Rollback's lookup: "the most recent forward batch that is still applied".
CREATE INDEX IF NOT EXISTS "ModelIdMigrationBatch_direction_state_startedAt_idx"
    ON "ModelIdMigrationBatch" ("direction", "state", "startedAt");

-- ── ModelIdMigrationEntry ──

CREATE TABLE IF NOT EXISTS "ModelIdMigrationEntry" (
    "id"          TEXT NOT NULL,
    "batchId"     TEXT NOT NULL,
    -- 'workspace_setting' | 'chat_session' | 'chat_message'
    "site"        TEXT NOT NULL,
    -- Primary key of the rewritten row, or the WorkspaceSetting `key`.
    "rowKey"      TEXT NOT NULL,
    -- 'valueJson' | 'model'
    "column"      TEXT NOT NULL,
    -- Stored VERBATIM, not normalised. Rollback re-checks the row still holds
    -- `afterValue` before restoring `beforeValue`, so a row edited by hand in
    -- between is skipped and reported instead of clobbered.
    "beforeValue" TEXT NOT NULL,
    "afterValue"  TEXT NOT NULL,

    CONSTRAINT "ModelIdMigrationEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModelIdMigrationEntry_batchId_idx"
    ON "ModelIdMigrationEntry" ("batchId");

CREATE INDEX IF NOT EXISTS "ModelIdMigrationEntry_site_rowKey_idx"
    ON "ModelIdMigrationEntry" ("site", "rowKey");

-- Cascade: dropping a batch drops its entries. There is no application path
-- that deletes a batch — this exists so a manual cleanup cannot strand rows.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ModelIdMigrationEntry_batchId_fkey'
    ) THEN
        ALTER TABLE "ModelIdMigrationEntry"
            ADD CONSTRAINT "ModelIdMigrationEntry_batchId_fkey"
            FOREIGN KEY ("batchId") REFERENCES "ModelIdMigrationBatch" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
