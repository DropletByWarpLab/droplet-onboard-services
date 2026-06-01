-- PR #377 (WARP-___): FIDO2/WebAuthn passkeys.
--
-- Phishing-resistant, passwordless sign-in alongside the argon2id directory
-- login (ADR-013 / PR #374). Two tables + one enum:
--
--   1. "WebAuthnCredential" — a registered credential (passkey / roaming key)
--      keyed to a directory "User". Stores the authenticator's public key,
--      base64url credential id, the rolling signature counter (clone
--      detection), and the optional transports hint. The private key never
--      leaves the authenticator and is never stored here.
--
--   2. "WebAuthnChallenge" — single-use, time-bound ceremony challenges
--      (replay defence). The verify step looks a row up by "challenge",
--      checks "expiresAt", and DELETEs it. "userId" is non-null for the
--      registration ceremony and null for the passwordless authenticate
--      ceremony. "WebAuthnChallengeType" keeps the two challenge pools from
--      cross-contaminating.
--
-- GREENFIELD — no data backfill (same posture as the ADR-013 migration: the
-- single live box is wiped + reflashed, new appliances onboard fresh). There
-- are no existing credentials to migrate.
--
-- Idempotent: CREATE TYPE is guarded by a DO-block that swallows
-- duplicate_object, and every table / index uses IF NOT EXISTS, so re-running
-- this migration on a converged DB is a no-op (row count stable). Same posture
-- as the WARP-218 BrainMemoryItemStatus and ADR-013 migrations.

DO $$ BEGIN
    CREATE TYPE "WebAuthnChallengeType" AS ENUM (
        'REGISTRATION',
        'AUTHENTICATION'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "WebAuthnCredential" (
    "id"           TEXT         NOT NULL,
    "userId"       TEXT         NOT NULL,
    "credentialId" TEXT         NOT NULL,
    "publicKey"    BYTEA        NOT NULL,
    "counter"      INTEGER      NOT NULL DEFAULT 0,
    "transports"   TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt"   TIMESTAMP(3),

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebAuthnCredential_credentialId_key"
    ON "WebAuthnCredential"("credentialId");

CREATE INDEX IF NOT EXISTS "WebAuthnCredential_userId_idx"
    ON "WebAuthnCredential"("userId");

CREATE TABLE IF NOT EXISTS "WebAuthnChallenge" (
    "id"        TEXT                    NOT NULL,
    "challenge" TEXT                    NOT NULL,
    "type"      "WebAuthnChallengeType" NOT NULL,
    "userId"    TEXT,
    "expiresAt" TIMESTAMP(3)            NOT NULL,
    "createdAt" TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebAuthnChallenge_challenge_key"
    ON "WebAuthnChallenge"("challenge");

CREATE INDEX IF NOT EXISTS "WebAuthnChallenge_expiresAt_idx"
    ON "WebAuthnChallenge"("expiresAt");

CREATE INDEX IF NOT EXISTS "WebAuthnChallenge_userId_idx"
    ON "WebAuthnChallenge"("userId");

-- FKs added separately so a re-run that found the tables already present
-- still converges the constraints. Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS, so guard each in a DO-block that swallows duplicate_object.
DO $$ BEGIN
    ALTER TABLE "WebAuthnCredential"
        ADD CONSTRAINT "WebAuthnCredential_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "WebAuthnChallenge"
        ADD CONSTRAINT "WebAuthnChallenge_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
