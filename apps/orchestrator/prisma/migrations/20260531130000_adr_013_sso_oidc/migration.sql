-- ADR-013 (SSO OIDC): external-IdP sign-in (Google Workspace + Microsoft
-- Entra) via the orchestrator as an OIDC relying party.
--
-- Two additive tables. Nothing on "User" changes except a back-relation
-- (relations are not columns — no ALTER on "User" here), so there is no
-- backfill and no risk to existing rows. Per-provider CONFIG (issuer /
-- clientId / clientSecret / redirect) lives in env (config.ts
-- DROPLET_SSO_*), NOT the DB — so there is deliberately no "SsoConnection"
-- table.
--
--   1. "SsoIdentity" — links an IdP identity (provider + 'sub') to a LOCAL
--      "User".id. UNIQUE(provider, subject) so one IdP identity resolves to
--      exactly one local user. FK to "User"(id) with ON DELETE CASCADE so
--      deleting a user removes their linked identities. The "User".id UUID
--      (WARP-485) stays the canonical key — SSO links to it, never replaces
--      it.
--
--   2. "SsoLoginState" — server-side single-use, time-bound state + nonce +
--      PKCE verifier persisted between /authorize and /callback. UNIQUE on
--      "state". "consumedAt" enforces single-use (same idiom as
--      UserInvite.acceptedAt); "expiresAt" time-bounds the flow. No secret
--      or token is stored on this row.
--
-- GREENFIELD + idempotent: CREATE TABLE IF NOT EXISTS + CREATE UNIQUE INDEX
-- IF NOT EXISTS + a DO-guarded FK so re-running on a converged DB is a no-op.
-- Same posture as the ADR-013 directory and WARP-613 migrations. No UPDATE
-- against "User" — existing credentials are never touched.

CREATE TABLE IF NOT EXISTS "SsoIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SsoLoginState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "returnTo" TEXT NOT NULL DEFAULT '/',
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoLoginState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SsoIdentity_provider_subject_key"
    ON "SsoIdentity"("provider", "subject");

CREATE INDEX IF NOT EXISTS "SsoIdentity_userId_idx"
    ON "SsoIdentity"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "SsoLoginState_state_key"
    ON "SsoLoginState"("state");

CREATE INDEX IF NOT EXISTS "SsoLoginState_expiresAt_idx"
    ON "SsoLoginState"("expiresAt");

-- FK added via a DO-guard because Postgres < 9.6 has no
-- `ADD CONSTRAINT IF NOT EXISTS`; the guard makes the migration re-runnable
-- on a converged DB without erroring on the already-present constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SsoIdentity_userId_fkey'
    ) THEN
        ALTER TABLE "SsoIdentity"
            ADD CONSTRAINT "SsoIdentity_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
