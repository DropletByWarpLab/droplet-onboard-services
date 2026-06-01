-- ADR-013: make the built-in argon2id directory the auth source of truth.
--
-- Two additive columns/indexes on "User":
--
--   1. "passwordHash" TEXT — the argon2id PHC string. POST /auth/login
--      verifies the supplied password against it locally (password.service)
--      instead of round-tripping Nextcloud OCS. Nextcloud is demoted to a
--      downstream-provisioned WebDAV account, no longer the authenticator.
--
--   2. UNIQUE index on "email" — email is the stable login key (the Aurora
--      login sends "Work email" as the identifier). The unique constraint
--      prevents two local rows from claiming the same login identity.
--
-- GREENFIELD — no data backfill. Per the ADR's accepted decision the single
-- live box is wiped + reflashed and new appliances onboard fresh, so there
-- are NO existing Nextcloud-keyed rows to migrate. There is deliberately no
-- UPDATE here: the directory is the source of truth from first boot and every
-- credential is written through /auth/setup + invite-accept after this
-- migration lands. The pre-existing local "User.id" UUID (WARP-485) stays the
-- canonical key in JWTs/Redis — untouched.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS so
-- re-running on a converged DB is a no-op. Same posture as the WARP-455
-- local-directory and WARP-485 nextcloudUsername migrations.

ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key"
    ON "User"("email");
