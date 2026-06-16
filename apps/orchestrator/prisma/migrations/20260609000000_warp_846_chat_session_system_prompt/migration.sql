-- WARP-844: persist the caller-supplied system prompt per conversation.
--
-- The dashboard's system-prompt textarea was plain client state — lost on
-- reload, so a conversation held under a persona silently continued
-- without it after a refresh. This column is the EXPLICIT persistent
-- signal (project no-guessing rule): the orchestrator writes the
-- request's system message here on every turn (latest wins), and
-- GET /api/llm/conversations/:id returns it so the dashboard restores
-- the textarea on load.
--
-- NULLABLE with no default: NULL means "no custom prompt", which is the
-- correct backfill for every existing row.
--
-- GREENFIELD + idempotent: ADD COLUMN IF NOT EXISTS; re-running on a
-- converged DB is a no-op.

ALTER TABLE "ChatSession"
    ADD COLUMN IF NOT EXISTS "systemPrompt" TEXT;
