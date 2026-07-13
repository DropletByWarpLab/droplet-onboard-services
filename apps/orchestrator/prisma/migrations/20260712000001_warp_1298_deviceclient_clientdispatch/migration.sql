-- WARP-1298: DeviceClient client-dispatched-actions metadata + ed25519 client key.
--
-- Foundation schema for the desktop tool-host (ADR-014 §37–39, §③; WARP-350
-- epic). Romain chose this shape (Option B on WARP-352) on 2026-07-12. The
-- original WARP-352 model had NO column for the client public key, which was
-- the concrete blocker Romain hit on WARP-353 (signature-verify has nothing to
-- verify against). The WS bridge, signature verification, and tool catalog that
-- consume these columns land in WARP-353/354 — this migration is schema only.
--
-- Pure additive: every new column is nullable or defaulted, so existing rows
-- backfill cleanly (lastSeenWsAt/clientKind/clientPublicKey → NULL, toolConsent
-- → '{}', toolCapabilities → '[]'). No data migration, no downtime.

-- AlterTable
ALTER TABLE "DeviceClient" ADD COLUMN     "lastSeenWsAt" TIMESTAMP(3),
ADD COLUMN     "toolConsent" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "clientKind" TEXT,
ADD COLUMN     "toolCapabilities" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "clientPublicKey" TEXT;

-- CreateIndex
-- ed25519 client public key is the client identity (VpnPeer.publicKey
-- precedent): unique across all rows so a revoked client can't re-pair its key.
CREATE UNIQUE INDEX "DeviceClient_clientPublicKey_key" ON "DeviceClient"("clientPublicKey");

-- CreateIndex
-- WARP-354 catalog membership query: this user's rows whose last WS heartbeat
-- is within 90s.
CREATE INDEX "DeviceClient_userId_lastSeenWsAt_idx" ON "DeviceClient"("userId", "lastSeenWsAt");
