-- KAN-6 — internal one-shot marker table for runtime data migrations.
--
-- The legacy SceneSchedule timezone backfill (convert pre-KAN-6 UTC-hour rows
-- to the box's local zone) cannot run as pure SQL: it needs the box's local
-- IANA zone, which only the Node runtime can resolve (Intl / process.env.TZ).
-- It therefore runs as a guarded startup backfill and records completion here
-- so it executes exactly once, no matter how many times the orchestrator boots.
--
-- This is NOT a user-facing setting — no route enumerates it (unlike
-- WorkspaceSetting). State is the presence of an explicit marker row, never an
-- IS-NULL derived from domain data.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS so a re-apply (e.g. a reflash that
-- replays migrations) is a no-op. Same posture as the WARP-112 / scene /
-- timezone-column migrations.

CREATE TABLE IF NOT EXISTS "SystemFlag" (
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemFlag_pkey" PRIMARY KEY ("key")
);
