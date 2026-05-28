-- WARP-468 — Phase E2. Off-LAN egress byte counter time-series.
--
-- One row per (ts, channel). A 60 s apscheduler tick in
-- services/routing/scheduler.py reads OpenWrt nftables byte counters
-- (one chain per channel under the `droplet_offlan_*` prefix), diffs
-- against the previous sample, and POSTs the derived delta to
-- /api/network/off-lan-sample.
--
-- Reuses the existing OffLanChannelKey enum from the WARP-467 migration
-- (CREATE TYPE … IF NOT EXISTS is not valid Postgres; the migration is
-- ordered so 20260527190000_warp_467_off_lan_allowlist runs first).
--
-- Idempotent: IF NOT EXISTS for the table + index. Same posture as the
-- WARP-456 / WARP-457 / WARP-460 / WARP-461 / WARP-467 / WARP-470 migrations.

CREATE TABLE IF NOT EXISTS "OffLanEgressSample" (
    "ts"      TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" "OffLanChannelKey" NOT NULL,
    "bytes"   BIGINT             NOT NULL,

    CONSTRAINT "OffLanEgressSample_pkey" PRIMARY KEY ("ts", "channel")
);

CREATE INDEX IF NOT EXISTS "OffLanEgressSample_channel_ts_idx"
    ON "OffLanEgressSample"("channel", "ts" DESC);
