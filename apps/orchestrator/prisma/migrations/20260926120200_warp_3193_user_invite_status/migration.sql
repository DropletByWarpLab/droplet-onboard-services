-- WARP-3193 QUAL-3 — explicit UserInvite lifecycle status.
--
-- Invite state was derived from nullable timestamps: pending meant
-- `acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > now()`, and each
-- reader (accept route, resend route, owner-invite sweep, access-role delete
-- and its hand-built complement, the dashboard pill) repeated its own copy.
-- CLAUDE.md "no guessing"; WARP-218 BrainMemoryItemStatus and WARP-1202
-- PairingCodeStatus are the precedents.
--
-- Idempotent: the enum CREATE is duplicate_object-guarded, DDL uses
-- IF [NOT] EXISTS, and every backfill UPDATE either re-writes the value it
-- already wrote or is guarded on `status = 'pending'`.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "InviteStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Column ──

ALTER TABLE "UserInvite"
    ADD COLUMN IF NOT EXISTS "status" "InviteStatus" NOT NULL DEFAULT 'pending';

-- ── Backfill from the timestamps ──
-- Revoked first. The revoke route never checked acceptedAt, so a row can
-- carry both stamps; every old reader tested revokedAt first (the accept
-- route 404'd it, the dashboard showed "Revoked"), so it stays revoked.
-- Expired last, and only for rows still pending: past expiresAt with neither
-- stamp. Everything else keeps the 'pending' default.

UPDATE "UserInvite" SET "status" = 'revoked'
    WHERE "revokedAt" IS NOT NULL;

UPDATE "UserInvite" SET "status" = 'accepted'
    WHERE "acceptedAt" IS NOT NULL AND "status" = 'pending';

UPDATE "UserInvite" SET "status" = 'expired'
    WHERE "expiresAt" < now() AND "status" = 'pending';

-- ── Index ──

CREATE INDEX IF NOT EXISTS "UserInvite_status_idx" ON "UserInvite"("status");
