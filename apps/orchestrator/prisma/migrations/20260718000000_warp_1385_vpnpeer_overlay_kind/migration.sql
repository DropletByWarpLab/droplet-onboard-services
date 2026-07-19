-- WARP-1385 (ADR-030 direct-punch overlay) — how each VpnPeer was provisioned.
--
-- Adds two EXPLICIT columns to VpnPeer (rule 10: persistent state is an explicit
-- enum-checked column, never inferred from another field's absence):
--
--   kind
--     'static'  (default) — a persistent peer minted by the owner via
--               POST /api/vpn/peers (the QR/.conf flow). EVERY existing row is
--               correctly 'static' via the column default — no data backfill
--               needed and static-peer behavior is byte-identical.
--     'overlay' — a direct-punch overlay peer installed/refreshed by the overlay
--               connect agent on each HQ session (ADR-030).
--
--   lastSessionAt
--     Last time the connect agent refreshed an overlay peer's endpoint from an HQ
--     session offer. NULL for static peers. The idle-expiry sweep filters on
--     `kind = 'overlay' AND lastSessionAt < cutoff`, so the NULL is never used to
--     DERIVE state — only overlay rows (which always set it) are considered.
--
-- Postgres 11+ fast default: adding a NOT-NULL column WITH a default does not
-- rewrite the table, so this is safe on a box with existing peers.
--
-- Re-runnable: `ADD COLUMN IF NOT EXISTS` no-ops if the column already exists,
-- the CHECK constraint add is wrapped in DO/EXCEPTION so a second run does not
-- error on the duplicate constraint, and the index uses IF NOT EXISTS. Running
-- this migration twice in dev leaves the schema (and any seeded rows) unchanged.

-- AlterTable — the default backfills every pre-1385 row to 'static' in the same
-- statement (fast default, no rewrite).
ALTER TABLE "VpnPeer" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'static';
ALTER TABLE "VpnPeer" ADD COLUMN IF NOT EXISTS "lastSessionAt" TIMESTAMP(3);

-- Enum-check the two legal `kind` values at the DB layer (mirrors the sibling
-- `mode` and `status` columns' contracts). Idempotent via DO/EXCEPTION.
DO $$ BEGIN
    ALTER TABLE "VpnPeer" ADD CONSTRAINT "VpnPeer_kind_check"
        CHECK ("kind" IN ('static', 'overlay'));
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- The overlay idle-expiry sweep scans (kind, status, lastSessionAt).
CREATE INDEX IF NOT EXISTS "VpnPeer_kind_idx" ON "VpnPeer"("kind");
