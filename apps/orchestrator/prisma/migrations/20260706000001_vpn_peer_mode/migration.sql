-- Hybrid remote-access P1 — how each WireGuard peer reaches the box.
--
-- Adds an EXPLICIT `mode` column to VpnPeer (rule 10: persistent state is an
-- explicit enum-checked column, never inferred from another field's absence):
--
--   'away' (default) — dials the box from OUTSIDE the home LAN via the public
--           FQDN / relay endpoint. This is the pre-hybrid behavior, so EVERY
--           existing row is correctly 'away' via the column default — no data
--           backfill needed and away-mode output is byte-identical.
--   'home' — dials the box DIRECTLY at its home-facing LAN IP (split-tunnel to
--           the box, no public inbound). The .conf's Endpoint is the LAN IP and
--           DNS points at the split-horizon resolver so the per-device FQDN
--           resolves over the tunnel (ADR-023 §3.4).
--
-- Postgres 11+ fast default: adding a NOT-NULL column WITH a default does not
-- rewrite the table, so this is safe on a box with existing peers.
--
-- Re-runnable: `ADD COLUMN IF NOT EXISTS` no-ops if the column already exists,
-- and the CHECK constraint add is wrapped in DO/EXCEPTION so a second run does
-- not error on the duplicate constraint. Running this migration twice in dev
-- leaves the schema (and any seeded rows) unchanged.

-- AlterTable — the default backfills every pre-hybrid row to 'away' in the same
-- statement (fast default, no rewrite).
ALTER TABLE "VpnPeer" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'away';

-- Enum-check the two legal values at the DB layer (mirrors the sibling `status`
-- column's "active" | "revoked" contract). Idempotent via DO/EXCEPTION so a
-- re-run doesn't fail on the already-present constraint.
DO $$ BEGIN
    ALTER TABLE "VpnPeer" ADD CONSTRAINT "VpnPeer_mode_check"
        CHECK ("mode" IN ('home', 'away'));
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
