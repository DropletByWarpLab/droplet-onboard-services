-- WARP-890: tamper-proof reconcile clock — add EmailDraft.claimedAt.
--
-- The stale-sending reconcile (both the orchestrator cron added in this ticket
-- and the email-indexer's inline tick) sweeps drafts stranded in `sending` past
-- a grace window. It originally keyed off `updatedAt { lt: cutoff }`, but Prisma
-- `@updatedAt` resets on ANY row write — a concurrent edit to an unrelated field
-- would silently reset the grace window and strand the draft in `sending`
-- forever. We record an explicit, additive, NULLABLE `claimedAt` wall-clock when
-- a draft is claimed (queued→sending) and key the reconcile cutoff off THAT
-- column instead (no-incidental-state rule: an explicit column, never derived
-- state).
--
-- Additive + nullable: every existing draft (and every draft that has never been
-- claimed) is NULL, so this is a non-breaking, zero-backfill change. Idempotent:
-- `ADD COLUMN IF NOT EXISTS` so a re-run (reflash) is a no-op.

ALTER TABLE "EmailDraft" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
