-- Native SSO handoff (RFC 8252) for the native Windows client, which has no
-- WebView to carry the browser flow's `droplet_sso_state` cookie.
--
-- The box stays the confidential OIDC client and the IdP still redirects to
-- the box's own /api/sso/oidc/callback, so the IdP-registered redirect URI
-- does not change (ADR-016). A NATIVE login-state row carries the app's own
-- redirect (http://127.0.0.1:<port>/<path>, http://[::1]:<port>/<path> or
-- droplet://sso/callback) and the app's PKCE S256 challenge. On a successful
-- callback the box shows a consent page carrying a single-use consent value
-- (only its sha256 is parked on the row, `nativeConsentHash`); only the
-- person's Continue (POST /api/sso/oidc/native/consent) mints the one-time
-- handoff code (sha256 only, 60 s) and redirects to the app, and
-- POST /api/sso/oidc/native/token redeems it once against the verifier.
--
-- `flowKind` is an EXPLICIT enum column (CLAUDE.md "No guessing, ever"): the
-- callback's branch is never derived from `nativeRedirectUri IS NULL`. The
-- CHECK pins that a NATIVE row always has its redirect and challenge.
-- Existing rows take the BROWSER default, which is what they are.
--
-- Additive and idempotent (sibling-migration discipline): the enum and the
-- CHECK are DO/EXCEPTION-guarded, columns use ADD COLUMN IF NOT EXISTS, the
-- index uses IF NOT EXISTS. No UPDATE or DELETE against existing rows.

DO $$ BEGIN
    CREATE TYPE "SsoFlowKind" AS ENUM ('BROWSER', 'NATIVE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "SsoLoginState"
    ADD COLUMN IF NOT EXISTS "flowKind" "SsoFlowKind" NOT NULL DEFAULT 'BROWSER',
    ADD COLUMN IF NOT EXISTS "nativeRedirectUri" TEXT,
    ADD COLUMN IF NOT EXISTS "nativeCodeChallenge" TEXT,
    ADD COLUMN IF NOT EXISTS "nativeConsentHash" TEXT,
    ADD COLUMN IF NOT EXISTS "handoffCodeHash" TEXT,
    ADD COLUMN IF NOT EXISTS "handoffUserId" TEXT,
    ADD COLUMN IF NOT EXISTS "handoffExpiresAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "handoffConsumedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "SsoLoginState_nativeConsentHash_key"
    ON "SsoLoginState"("nativeConsentHash");

CREATE UNIQUE INDEX IF NOT EXISTS "SsoLoginState_handoffCodeHash_key"
    ON "SsoLoginState"("handoffCodeHash");

DO $$ BEGIN
    ALTER TABLE "SsoLoginState" ADD CONSTRAINT "SsoLoginState_native_fields_check"
        CHECK (
            "flowKind" <> 'NATIVE'
            OR (
                "nativeRedirectUri" IS NOT NULL
                AND "nativeCodeChallenge" IS NOT NULL
            )
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
