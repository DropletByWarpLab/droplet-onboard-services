-- BUG-11 (email invites are broken): build a configurable outbound SMTP channel
-- and give every invite an explicit, queryable, retryable delivery state.
--
-- Two additive concerns, ordered AFTER #381's 20260601020000 migration:
--   1. InviteSendStatus enum + four delivery-state columns on UserInvite.
--      Per the no-guessing rule (CLAUDE.md): delivery is an EXPLICIT enum
--      column (`sendStatus`), never inferred from a null `sentAt`. A failed
--      send is a first-class state the dashboard filters + retries; it NEVER
--      rolls back the invite row.
--   2. EmailChannelSetting singleton + EmailChannelSecurity enum — the
--      operator-supplied SMTP relay config (host/port/username/from/security +
--      an at-rest-encrypted password blob). The appliance never runs its own
--      MTA; the owner brings their mail provider's SMTP. The password is
--      aes-256-gcm encrypted via encryption.service before it ever reaches this
--      column; nothing secret is tracked in the repo (rule 19).
--
-- IDEMPOTENCY (re-running on a converged DB is a no-op so row/enum counts stay
-- stable): every CREATE TYPE is guarded by a pg_type catalog check, every
-- ADD COLUMN uses IF NOT EXISTS, and the singleton seed uses
-- INSERT … ON CONFLICT DO NOTHING. No secret is seeded — the row ships disabled
-- with empty connection fields until the operator configures it.

-- ── 1 · InviteSendStatus enum ──────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InviteSendStatus') THEN
        CREATE TYPE "InviteSendStatus" AS ENUM ('pending', 'sent', 'failed');
    END IF;
END $$;

-- ── 2 · EmailChannelSecurity enum ──────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailChannelSecurity') THEN
        CREATE TYPE "EmailChannelSecurity" AS ENUM ('starttls', 'tls', 'none');
    END IF;
END $$;

-- ── 3 · UserInvite delivery-state columns ──────────────────────────────────
ALTER TABLE "UserInvite"
    ADD COLUMN IF NOT EXISTS "sendStatus"   "InviteSendStatus" NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS "sentAt"        TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "sendError"     TEXT,
    ADD COLUMN IF NOT EXISTS "sendAttempts"  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "UserInvite_sendStatus_idx" ON "UserInvite" ("sendStatus");

-- ── 4 · EmailChannelSetting singleton table ────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmailChannelSetting" (
    "id"           TEXT NOT NULL,
    "enabled"      BOOLEAN NOT NULL DEFAULT false,
    "host"         TEXT NOT NULL DEFAULT '',
    "port"         INTEGER NOT NULL DEFAULT 587,
    "username"     TEXT NOT NULL DEFAULT '',
    "passwordEnc"  TEXT NOT NULL DEFAULT '',
    "fromAddress"  TEXT NOT NULL DEFAULT '',
    "fromName"     TEXT NOT NULL DEFAULT 'Droplet',
    "security"     "EmailChannelSecurity" NOT NULL DEFAULT 'starttls',
    "lastError"    TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "updatedBy"    TEXT,
    CONSTRAINT "EmailChannelSetting_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row DISABLED with empty connection fields. ON CONFLICT
-- DO NOTHING keeps a second run from clobbering operator-entered config. The
-- service pins this same constant id on every upsert.
INSERT INTO "EmailChannelSetting" ("id", "enabled", "updatedAt")
VALUES ('singleton', false, NOW())
ON CONFLICT ("id") DO NOTHING;
