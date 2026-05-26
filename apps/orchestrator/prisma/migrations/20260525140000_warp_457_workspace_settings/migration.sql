-- WARP-457: A3 settings CRUD — workspace settings registry.
--
-- Adds the `WorkspaceSetting` table + `SettingSection` and `SettingType`
-- enums. Persistent CRUD layer for the dashboard's Settings surface;
-- replaces the .env-only knobs in config.ts for surfaces the household
-- is expected to tune from the UI. `.env` continues to own infra-level
-- secrets (DATABASE_URL, JWT_SECRET, OLLAMA_URL) — settings here are
-- additive, not a replacement.
--
-- `section` and `type` are explicit enums per CLAUDE.md "no guessing,
-- ever" — same pattern as WARP-218's BrainMemoryItemStatus and WARP-456's
-- ActivityKind/ActivitySeverity. The route layer validates `valueJson`
-- against `type` before write/read.
--
-- Idempotent: every CREATE uses `DO/EXCEPTION` (enums) or `IF NOT EXISTS`
-- (table/index) so re-running the migration on a converged DB is a no-op
-- and row counts stay stable. The seeder in workspace-settings.service.ts
-- is also insert-or-skip so it never overwrites user values.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "SettingSection" AS ENUM (
        'workspace',
        'memory_privacy',
        'off_lan',
        'hardware',
        'appearance'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "SettingType" AS ENUM (
        'string',
        'number',
        'bool',
        'duration_seconds',
        'enum',
        'json'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Table ──

CREATE TABLE IF NOT EXISTS "WorkspaceSetting" (
    "id"        TEXT             NOT NULL,
    "key"       TEXT             NOT NULL,
    "section"   "SettingSection" NOT NULL,
    "type"      "SettingType"    NOT NULL,
    "valueJson" JSONB            NOT NULL,
    "createdAt" TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "WorkspaceSetting_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ──
-- Unique on `key` enforces "one row per setting key" — the seeder
-- relies on this for its INSERT … ON CONFLICT DO NOTHING idempotency
-- clause (defined in workspace-settings.service.ts, not in this file).
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceSetting_key_key"
    ON "WorkspaceSetting"("key");

-- Composite on `section` keeps GET /api/settings's section-grouped
-- query plan stable as the row count grows.
CREATE INDEX IF NOT EXISTS "WorkspaceSetting_section_idx"
    ON "WorkspaceSetting"("section");
