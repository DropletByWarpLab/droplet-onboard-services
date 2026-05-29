-- WARP-485: Add User.nextcloudUsername so the OCS auth fallback can map
-- the Nextcloud user id (e.g. `stefan-cruceru`) to a local User.id UUID.
-- Closes the self-action guard bypass that landed in WARP-480: pre-fix,
-- the OCS path set `req.user.id` to the Nextcloud username string, so
-- `req.params.id === req.user?.id` on /api/people/:id mutations always
-- returned false-negative and an owner authenticated via OCS could
-- DELETE themselves.
--
-- Nullable column — locally-minted rows that have never authenticated
-- via Nextcloud (service-only users, fresh invitees pre-first-login)
-- don't have a value. Unique index ensures two local rows can't both
-- map to the same OCS identity (which would be an authentication
-- ambiguity).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT
-- EXISTS so re-running the migration on a converged DB is a no-op.
-- Same posture as the WARP-455 local-directory and WARP-446 ApDevice
-- migrations.

ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "nextcloudUsername" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_nextcloudUsername_key"
    ON "User"("nextcloudUsername");
