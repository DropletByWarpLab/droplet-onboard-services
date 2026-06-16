-- WARP-824: admin-created users get a temporary password + a forced change on
-- first login.
--
-- This migration adds the EXPLICIT persistent signal that drives that gate:
-- "User"."mustChangePassword" BOOLEAN, DEFAULT false.
--
-- Why an explicit column (project no-guessing rule): the forced-change state
-- must NOT be derived from password age, a null/sentinel "passwordHash", or a
-- "this row was created by an admin" inference. It is a first-class lifecycle
-- flag, exactly like "directoryStatus" (ADR-013 SCIM) and
-- "TotpCredential"."confirmedAt". Set true at admin create-user (and at an
-- admin password reset), cleared to false when the user picks their own
-- password via POST /auth/change-password.
--
-- The DEFAULT false backfills every existing row at ADD COLUMN time — there is
-- NO separate UPDATE and existing credentials/rows are otherwise untouched
-- (same greenfield posture as the ADR-013 directory + directoryStatus
-- migrations). Self-service signup paths (/auth/setup, invite-accept) leave it
-- false, so only admin-minted accounts are gated.
--
-- GREENFIELD + idempotent: ADD COLUMN IF NOT EXISTS with a DEFAULT. Re-running
-- on a converged DB is a no-op (verified by applying twice in dev). No UPDATE
-- against existing "User" rows.

ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
