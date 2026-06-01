-- PR #375 — TOTP 2FA + one-time recovery codes for the built-in
-- argon2id directory (stacks on ADR-012, migration
-- 20260531120000_adr_012_directory_argon2id).
--
-- Two additive tables, both keyed to "User"."id" with ON DELETE CASCADE:
--
--   1. "TotpCredential" — one row per user. Holds the Base32 TOTP secret
--      ENCRYPTED at rest ("secretEnc", aes-256-gcm via encryption.service,
--      DEVICE_SECRET_KEY). "confirmedAt" is the EXPLICIT "TOTP enabled"
--      column the login gate reads — enablement is never inferred from
--      row presence / IS NULL (project rule: state is an explicit column).
--
--   2. "RecoveryCode" — N rows per user. Each stores an argon2id hash
--      ("codeHash", reusing password.service); the plaintext is shown to
--      the user exactly once at generation. Single-use: "usedAt" is the
--      explicit consumption marker, so a replayed code matches no unused
--      row.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS + a guarded ADD
-- CONSTRAINT (Postgres has no ADD CONSTRAINT IF NOT EXISTS) so re-running
-- on a converged DB is a no-op. Same posture as the surrounding additive
-- migrations. GREENFIELD — no data backfill (no pre-existing rows).

BEGIN;

CREATE TABLE IF NOT EXISTS "TotpCredential" (
    "id"          TEXT         NOT NULL,
    "userId"      TEXT         NOT NULL,
    "secretEnc"   TEXT         NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TotpCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TotpCredential_userId_key"
    ON "TotpCredential"("userId");

CREATE TABLE IF NOT EXISTS "RecoveryCode" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "codeHash"  TEXT         NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RecoveryCode_userId_idx"
    ON "RecoveryCode"("userId");

-- Foreign keys — guarded so re-runs don't error (no ADD CONSTRAINT IF
-- NOT EXISTS in Postgres). Both cascade on user delete.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'TotpCredential_userId_fkey'
    ) THEN
        ALTER TABLE "TotpCredential"
            ADD CONSTRAINT "TotpCredential_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RecoveryCode_userId_fkey'
    ) THEN
        ALTER TABLE "RecoveryCode"
            ADD CONSTRAINT "RecoveryCode_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

COMMIT;
