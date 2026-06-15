-- WARP-468 — DNS-blocked-query time-series for §2.6 Network page KPI strip.
--
-- One row per tick. A 60 s apscheduler tick in
-- services/routing/dns_block_meter.py reads the cumulative DNS
-- blocked-query counter via ubus (OpenWrt adblock / blocklist), diffs
-- against the previous sample, and POSTs the derived delta to
-- /api/network/dns-block-sample. The summary handler sums blockedCount
-- day-to-date for the "DNS blocked today" chip.
--
-- blockedCount is INTEGER (not BIGINT like throughput's bps): a single
-- 60 s window cannot accumulate > 2^31 blocked queries.
--
-- Idempotent: IF NOT EXISTS for the table + index. Same posture as the
-- WARP-456 / WARP-457 / WARP-460 / WARP-461 / WARP-467 / WARP-468
-- (off-LAN) / WARP-470 migrations.

CREATE TABLE IF NOT EXISTS "DnsBlockSample" (
    "ts"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockedCount"  INTEGER NOT NULL,

    CONSTRAINT "DnsBlockSample_pkey" PRIMARY KEY ("ts")
);

CREATE INDEX IF NOT EXISTS "DnsBlockSample_ts_idx"
    ON "DnsBlockSample"("ts" DESC);
