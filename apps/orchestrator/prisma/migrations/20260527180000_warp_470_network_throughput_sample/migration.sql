-- WARP-470 — 24 h WAN throughput time-series for §2.6 Network page (Phase F2).
--
-- Idempotent: IF NOT EXISTS for the table + index. Same posture as the
-- WARP-456 / WARP-457 / WARP-460 / WARP-461 migrations.

CREATE TABLE IF NOT EXISTS "NetworkThroughputSample" (
    "ts"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wanDownBps"  BIGINT NOT NULL,
    "wanUpBps"    BIGINT NOT NULL,

    CONSTRAINT "NetworkThroughputSample_pkey" PRIMARY KEY ("ts")
);

CREATE INDEX IF NOT EXISTS "NetworkThroughputSample_ts_idx"
    ON "NetworkThroughputSample"("ts" DESC);
