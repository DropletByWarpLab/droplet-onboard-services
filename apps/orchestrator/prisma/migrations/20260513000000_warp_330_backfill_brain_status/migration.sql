-- WARP-330: backfill BrainMemoryItem.status for rows the synchronous
-- brain_ingest path left stuck at status='indexing'.
--
-- Bug: services/file-indexer/brain_ingest.py called mark_brain_item_indexed
-- which only wrote indexedAt + extractorWarnings, never the new
-- BrainMemoryItemStatus column added in WARP-218. Every chat-attached file
-- ingested between 2026-05-08 (WARP-218 land) and the WARP-330 fix sits at
-- status='indexing' even though it's fully indexed (chunks exist,
-- indexedAt is set, MQTT 'ready' was published to the dashboard at the
-- time). The /context page's pipeline-health card filters on
-- status='ready', so those rows show "never reached ready" indefinitely.
--
-- This migration reconciles persistent state with what the pipeline
-- already observed. The mapping mirrors the WARP-218 initial backfill
-- convention (indexedAt IS NOT NULL → 'ready') but adds a refinement
-- that the failure paths in brain_ingest tag rows with known
-- extractorWarnings — those rows should land at 'failed', not 'ready'.
--
-- Three buckets per the historical brain_ingest paths:
--   1. indexedAt set + warnings contain a brain_ingest failure marker
--      ('extractor_unavailable' | 'empty_extraction' | 'no_chunks')
--        → status='failed', failureReason=<that marker>
--   2. indexedAt set + no failure marker → status='ready', clear retry-window
--   3. indexedAt NULL → leave untouched (genuinely still indexing, or
--      claim_attempt-tracked retries owned by the daily worker).
--
-- Idempotent: every UPDATE is constrained to rows that still match the
-- "stuck" pattern; re-running on a converged db is a no-op.

BEGIN;

-- Bucket 1: failure paths that DID call mark_brain_item_indexed but were
-- mis-classified as 'indexing'. The extractorWarnings array tells us
-- which failure reason to record.
UPDATE "BrainMemoryItem"
   SET "status"             = 'failed',
       "failureReason"      = 'extractor_unavailable'
 WHERE "status"      = 'indexing'
   AND "indexedAt"   IS NOT NULL
   AND 'extractor_unavailable' = ANY("extractorWarnings");

UPDATE "BrainMemoryItem"
   SET "status"             = 'failed',
       "failureReason"      = 'empty_extraction'
 WHERE "status"      = 'indexing'
   AND "indexedAt"   IS NOT NULL
   AND 'empty_extraction' = ANY("extractorWarnings");

UPDATE "BrainMemoryItem"
   SET "status"             = 'failed',
       "failureReason"      = 'no_chunks'
 WHERE "status"      = 'indexing'
   AND "indexedAt"   IS NOT NULL
   AND 'no_chunks' = ANY("extractorWarnings");

-- Bucket 2: success paths (no failure marker in warnings; includes the
-- common case with empty warnings AND the 'image_only' success warning).
-- Clear retry-window fields the same way update_item_status('ready') does.
UPDATE "BrainMemoryItem"
   SET "status"                       = 'ready',
       "failureReason"                = NULL,
       "recentAttemptCount"           = 0,
       "recentAttemptWindowStartedAt" = NULL
 WHERE "status"    = 'indexing'
   AND "indexedAt" IS NOT NULL;

COMMIT;
