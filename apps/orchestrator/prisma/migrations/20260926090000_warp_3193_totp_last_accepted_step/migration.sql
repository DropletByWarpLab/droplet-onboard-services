-- WARP-3193 SEC-AUTH-10 — TOTP replay protection.
--
-- The RFC 6238 time step of the last accepted code. A code is accepted only
-- through a conditional update (`WHERE "lastAcceptedStep" < step`), so a code
-- can be used at most once within its ±1-step window. 0 means no code has
-- been accepted yet (explicit value, not a NULL-derived state).
--
-- Additive, no backfill: existing rows start at 0, so their next valid code
-- is accepted exactly as before. Re-runnable (IF NOT EXISTS).
ALTER TABLE "TotpCredential"
  ADD COLUMN IF NOT EXISTS "lastAcceptedStep" INTEGER NOT NULL DEFAULT 0;
