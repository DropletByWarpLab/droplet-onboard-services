-- WARP-456: signed append-only activity log (`ActivityRow`).
--
-- Canonical audit trail of every observable event on the device — chat
-- turns, MCP tool calls, file indexing, camera writes, network ops,
-- smart-home commands, email sends, auth events, scheduled tool runs,
-- system events. Each row carries an HMAC-SHA256 `signature` over its
-- own content plus the `prevSignatureHash` of the row before it,
-- forming a strict hash chain. Tamper-evident across the whole device
-- history; exportable as a sealed JSON-Lines bundle for offline
-- verification (`POST /api/activity/export`).
--
-- `kind` and `severity` are explicit enums per CLAUDE.md "no guessing,
-- ever" — same pattern as WARP-218's `BrainMemoryItemStatus`.
--
-- Re-runnable: every CREATE uses `DO/EXCEPTION` (enums) or
-- `IF NOT EXISTS` (table/indexes). Re-running on a populated db must
-- not change row counts and must not double-create the enums.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "ActivityKind" AS ENUM (
        'chat',
        'tool_call',
        'file',
        'camera',
        'network',
        'smart_home',
        'email',
        'auth',
        'tool_run',
        'system'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ActivitySeverity" AS ENUM (
        'ok',
        'warn',
        'err',
        'info'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Table ──

CREATE TABLE IF NOT EXISTS "ActivityRow" (
    "id"                BIGSERIAL              NOT NULL,
    "at"                TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "severity"          "ActivitySeverity"     NOT NULL,
    "sourceIcon"        TEXT                   NOT NULL,
    "what"              TEXT                   NOT NULL,
    "sub"               TEXT,
    "kind"              "ActivityKind"         NOT NULL,
    "refs"              JSONB,
    -- Base64-url HMAC-SHA256, no padding. Per-row, covers content + prevSignatureHash.
    "signature"         TEXT                   NOT NULL,
    -- Hash of the immediately-preceding row's signature, base64-url.
    -- Empty string for the genesis row.
    "prevSignatureHash" TEXT                   NOT NULL,

    CONSTRAINT "ActivityRow_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ──
-- Composite covers `GET /api/activity?kind=&from=&to=` ordered by `at` DESC
-- within a kind filter. The bare `at` index covers the unfiltered range
-- query and the exporter's chronological scan.
CREATE INDEX IF NOT EXISTS "ActivityRow_at_kind_idx"
    ON "ActivityRow"("at", "kind");
CREATE INDEX IF NOT EXISTS "ActivityRow_at_idx"
    ON "ActivityRow"("at");
