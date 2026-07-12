-- WARP-904: per-message provider/model audit trail.
--
-- `ChatSession.model`/`provider` only ever recorded the conversation's
-- ORIGINAL selection. Now that the chat composer supports a mid-conversation
-- quick-switch, the session-level columns can't tell you which model
-- actually produced any given turn once the user has switched. Add the
-- same two columns to `ChatMessage`, populated per-turn going forward.
--
-- Additive + idempotent (IF NOT EXISTS), same discipline as
-- 20260710000000_warp_1202_pairing_code_status. NULL on every
-- pre-existing row — never backfilled (the session-level value is the
-- best available inference for old rows, and this migration doesn't
-- guess; readers fall back to `ChatSession.model`/`provider` for rows
-- where these are NULL).

ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "provider" TEXT;
