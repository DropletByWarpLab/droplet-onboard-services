-- WARP-565 — DB-level guard against duplicate active tunnel IPs.
--
-- The allocator (vpn.service.ts allocatePeerIp + routes/vpn.ts) reads the
-- set of taken IPs, picks the lowest free one, then INSERTs the peer. That
-- read-then-write is a race: two concurrent POST /api/vpn/peers requests can
-- both observe the same "free" IP and both assign it. The pre-existing
-- @@index([assignedIp]) is non-unique, so nothing stops the duplicate.
--
-- This partial unique index makes "at most one ACTIVE peer per assignedIp" a
-- database guarantee — the losing insert fails with a unique violation
-- (Prisma P2002), which the route's transactional retry loop catches and
-- re-allocates against the now-updated taken set. Revoked rows are tombstones
-- whose IPs are reusable, so the index is scoped to status = 'active' only.
--
-- NOTE: Prisma's schema language cannot express partial indexes, so this
-- lives only in SQL (mirrors the raw-SQL precedent of earlier data-shape
-- migrations, e.g. 20260610000000_resetjob_at_most_one_nonterminal).
-- Re-runnable via IF NOT EXISTS.

BEGIN;

-- A box that already hit the race this index closes may hold MORE than one
-- active row sharing an assignedIp, which would fail the index build. Keep the
-- oldest active row per IP as the gating one and revoke the duplicates
-- (honest: they are the losers of a race and their tunnel state is ambiguous).
UPDATE "VpnPeer" SET
    "status" = 'revoked',
    "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP)
WHERE "status" = 'active'
  AND "id" NOT IN (
      SELECT DISTINCT ON ("assignedIp") "id"
      FROM "VpnPeer"
      WHERE "status" = 'active'
      ORDER BY "assignedIp", "createdAt" ASC
  );

CREATE UNIQUE INDEX IF NOT EXISTS "VpnPeer_assignedIp_active_key"
    ON "VpnPeer"("assignedIp")
    WHERE "status" = 'active';

COMMIT;
