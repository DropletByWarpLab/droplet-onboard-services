-- WARP-844: thumbs up/down rating on assistant chat messages.
--
-- Explicit nullable enum column (project no-guessing rule): NULL means
-- "unrated", never derived from a side table or absence signal. On a
-- self-hosted appliance this primarily feeds the admin's retrieval-eval
-- loop (admin-rag-eval / admin-retrieval-eval) rather than RLHF.
--
-- GREENFIELD + idempotent: guarded enum create + ADD COLUMN IF NOT
-- EXISTS; re-running on a converged DB is a no-op. Existing rows
-- backfill to NULL (unrated) implicitly.

DO $$ BEGIN
    CREATE TYPE "ChatMessageFeedback" AS ENUM ('up', 'down');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ChatMessage"
    ADD COLUMN IF NOT EXISTS "feedback" "ChatMessageFeedback";
