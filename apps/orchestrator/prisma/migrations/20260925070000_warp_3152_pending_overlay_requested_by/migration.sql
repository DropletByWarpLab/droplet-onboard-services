-- WARP-3152 — who asked for a device enrolled while owner review is on.
--
-- A signed-in enrollment staged for review used to carry no account, so the
-- approved peer landed under the synthetic `overlay` user: invisible in the
-- member's own device list and revocable only by an admin. The username is
-- stored at staging time and becomes the peer's owner at approval.
--
-- Nullable, no backfill: QR-linked rows have no requesting account, and rows
-- staged before this migration keep today's behaviour (admin-only peer).
ALTER TABLE "PendingOverlayEnrollment" ADD COLUMN IF NOT EXISTS "requestedBy" TEXT;
