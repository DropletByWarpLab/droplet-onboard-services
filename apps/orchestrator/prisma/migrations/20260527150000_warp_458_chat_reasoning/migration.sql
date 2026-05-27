-- WARP-458: per-turn reasoning trace on assistant messages.
--
-- Phase B kicks off the "thinking-out-loud" UX: the agent loop now detects
-- `<reasoning>…</reasoning>` segments in streamed model output (or the
-- model-native reasoning field on providers that surface it separately) and
-- emits them as discrete `reasoning_step` SSE blocks BEFORE any `text` block
-- on the same turn. The concatenated trace is persisted on the assistant
-- `ChatMessage.reasoning` column so a refresh / rehydrate of the
-- conversation can re-render the steps without re-running inference.
--
-- This migration adds a single nullable text column. It is idempotent
-- (`IF NOT EXISTS`) so re-running it on a converged DB is a no-op — same
-- posture as the WARP-485 nextcloudUsername migration and the WARP-488
-- userid backfill above. Nullable because the vast majority of historical
-- rows pre-WARP-458 do not carry reasoning content, and tool-only / system
-- / user rows never will.
--
-- Per the CLAUDE.md no-guessing rule: reasoning is its own column, not
-- derived from inspecting `content` for `<reasoning>` tags at read time.
-- The agent loop strips those tags from `content` and emits the reasoning
-- to this column verbatim; readers query `reasoning` directly.

ALTER TABLE "ChatMessage"
  ADD COLUMN IF NOT EXISTS "reasoning" TEXT;
