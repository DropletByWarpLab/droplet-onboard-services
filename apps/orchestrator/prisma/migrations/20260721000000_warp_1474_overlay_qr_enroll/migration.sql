-- WARP-1474 (ADR-030, epic WARP-1382) — dashboard-QR overlay device linking.
--
-- Adds the two staging tables for the "scan a QR to link a device to the
-- WireGuard overlay" flow + provenance columns on the overlay peer row:
--
--   OverlayLinkToken          — one row per minted QR link token (only the
--                               sha256 hash is stored; plaintext is never
--                               persisted). state: available | consumed | expired.
--   PendingOverlayEnrollment  — one row per redeemed-but-unapproved enrollment.
--                               state: pending | approved | denied | expired.
--   VpnPeer.linkToken* / enrolledAt — provenance stamped on approval.
--
-- Every `state` is an EXPLICIT enum-checked TEXT column (rule 10 — no state
-- derived from a NULL), pinned by a raw-SQL CHECK, mirroring the sibling
-- VpnPeer.status / .mode / .kind contracts.
--
-- Idempotent (same discipline as the sibling VpnPeer migrations): CREATE TABLE
-- / CREATE INDEX use IF NOT EXISTS, ADD COLUMN uses IF NOT EXISTS, and every
-- CHECK constraint add is wrapped in DO/EXCEPTION so a second run does not error
-- on the duplicate constraint. Running this migration twice in dev leaves the
-- schema (and any seeded rows) unchanged.

-- ── VpnPeer provenance columns (all nullable — additive, no rewrite) ──
ALTER TABLE "VpnPeer" ADD COLUMN IF NOT EXISTS "linkTokenEnrolledBy" TEXT;
ALTER TABLE "VpnPeer" ADD COLUMN IF NOT EXISTS "linkTokenId" TEXT;
ALTER TABLE "VpnPeer" ADD COLUMN IF NOT EXISTS "linkTokenLabel" TEXT;
ALTER TABLE "VpnPeer" ADD COLUMN IF NOT EXISTS "enrolledAt" TIMESTAMP(3);

-- ── OverlayLinkToken ──
CREATE TABLE IF NOT EXISTS "OverlayLinkToken" (
    "id"          TEXT          NOT NULL,
    "tokenHash"   TEXT          NOT NULL,
    "state"       TEXT          NOT NULL DEFAULT 'available',
    "expiresAt"   TIMESTAMP(3)  NOT NULL,
    "consumedAt"  TIMESTAMP(3),
    "createdBy"   TEXT          NOT NULL,
    "label"       TEXT,
    "boundSignFp" TEXT,
    "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverlayLinkToken_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "OverlayLinkToken" ADD CONSTRAINT "OverlayLinkToken_state_check"
        CHECK ("state" IN ('available', 'consumed', 'expired'));
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "OverlayLinkToken_tokenHash_key"
    ON "OverlayLinkToken"("tokenHash");
-- Single-active-per-owner supersession scans (createdBy, state).
CREATE INDEX IF NOT EXISTS "OverlayLinkToken_createdBy_state_idx"
    ON "OverlayLinkToken"("createdBy", "state");
-- Expiry sweeps / redeem classification scan (state, expiresAt).
CREATE INDEX IF NOT EXISTS "OverlayLinkToken_state_expiresAt_idx"
    ON "OverlayLinkToken"("state", "expiresAt");

-- ── PendingOverlayEnrollment ──
CREATE TABLE IF NOT EXISTS "PendingOverlayEnrollment" (
    "id"                 TEXT          NOT NULL,
    "linkTokenId"        TEXT          NOT NULL,
    "signKeyFingerprint" TEXT          NOT NULL,
    "signPublicKeyPem"   TEXT          NOT NULL,
    "wgPublicKey"        TEXT          NOT NULL,
    "label"              TEXT          NOT NULL,
    "presentedAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state"              TEXT          NOT NULL DEFAULT 'pending',
    "conflict"           BOOLEAN       NOT NULL DEFAULT false,
    "approvedBy"         TEXT,
    "enrolledAt"         TIMESTAMP(3),
    "hqDeviceRef"        TEXT,

    CONSTRAINT "PendingOverlayEnrollment_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "PendingOverlayEnrollment" ADD CONSTRAINT "PendingOverlayEnrollment_state_check"
        CHECK ("state" IN ('pending', 'approved', 'denied', 'expired'));
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "PendingOverlayEnrollment_state_idx"
    ON "PendingOverlayEnrollment"("state");
CREATE INDEX IF NOT EXISTS "PendingOverlayEnrollment_linkTokenId_idx"
    ON "PendingOverlayEnrollment"("linkTokenId");
CREATE INDEX IF NOT EXISTS "PendingOverlayEnrollment_wgPublicKey_idx"
    ON "PendingOverlayEnrollment"("wgPublicKey");
