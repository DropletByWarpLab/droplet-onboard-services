-- WARP-467 — Phase E1. Off-LAN allowlist channels.
--
-- One row per egress channel the operator can enable/disable. The
-- closed `OffLanChannelKey` enum is the contract between the dashboard,
-- the egress meter (WARP-468), and the ai-gateway / web.fetch refusal
-- middleware. Defaults are seeded by workspace-settings.service.ts.
--
-- Idempotent: enum CREATE wrapped in DO/EXCEPTION; table + index use
-- IF NOT EXISTS. Same posture as the WARP-456 / WARP-457 / WARP-460
-- / WARP-461 / WARP-470 migrations.

DO $$ BEGIN
    CREATE TYPE "OffLanChannelKey" AS ENUM (
        'software_updates',
        'cloud_model_escape',
        'outbound_email',
        'telemetry',
        'web_fetch'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "OffLanAllowlistChannel" (
    "key"            "OffLanChannelKey" NOT NULL,
    "enabled"        BOOLEAN            NOT NULL,
    "requiresAdmin"  BOOLEAN            NOT NULL DEFAULT true,
    "lastChangedBy"  TEXT,
    "lastChangedAt"  TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason"         TEXT,

    CONSTRAINT "OffLanAllowlistChannel_pkey" PRIMARY KEY ("key")
);
