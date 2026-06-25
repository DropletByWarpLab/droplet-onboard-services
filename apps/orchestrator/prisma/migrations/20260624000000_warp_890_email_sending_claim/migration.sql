-- WARP-890: idempotent outbound email — add a transient `sending` claim state.
--
-- The email-indexer's outbound poller previously SMTP-sent a `queued` draft and
-- only THEN PATCHed the orchestrator to `sent`/`failed`. If that PATCH failed
-- (orchestrator down/restarting/non-2xx), the row stayed `queued` and the next
-- 10s tick re-selected and RE-SENT the identical message (duplicate delivery).
--
-- The fix is an atomic claim: the indexer flips queued -> sending via a
-- conditional `updateMany WHERE status='queued'` (the WARP-564 pairing-claim
-- pattern, also used by ClaimCode) BEFORE the SMTP send, so a re-tick can never
-- re-select an in-flight draft. A draft stranded in `sending` (claimed but the
-- terminal callback never landed) is swept to `failed` past a grace window — it
-- is never re-queued, because the send may have completed.
--
-- This migration only EXTENDS the EmailDraftStatus enum with `sending`. The
-- value is appended (Postgres orders members by physical declaration and
-- `ALTER TYPE … ADD VALUE` only appends cheaply); nothing reads the enum's
-- declaration order. Idempotent: guarded by a pg_enum catalog check, because
-- `ALTER TYPE … ADD VALUE` has no transaction-safe `IF NOT EXISTS` on every
-- supported PG and re-adding an existing value errors — same pattern as PR #373
-- (20260601000000_warp_onb_claim_step).

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'EmailDraftStatus' AND e.enumlabel = 'sending'
    ) THEN
        ALTER TYPE "EmailDraftStatus" ADD VALUE 'sending';
    END IF;
END $$;
