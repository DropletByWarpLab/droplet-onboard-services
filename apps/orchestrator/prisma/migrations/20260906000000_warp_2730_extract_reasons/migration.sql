-- WARP-2730 (ADR-048 slice 2) — two reasons the worker discovered it needs.
--
-- 🔴 ALONE IN ITS OWN MIGRATION FILE, and that is not tidiness. Postgres runs
-- each Prisma migration in a transaction, and `ALTER TYPE ... ADD VALUE` cannot
-- be used by a statement in the SAME transaction that added it. Slice 1 split
-- `20260905000100_warp_2729_extracted_origin` out for exactly this reason; the
-- rule is the same here even though nothing in this file uses the new values,
-- because the next migration that does would inherit the failure.
--
-- `no_text`            The file is indexed but has no readable body: the
--                      extractor chain produced nothing (the Office-MIME skip
--                      is a known one), or every chunk was header. NOT a
--                      failure — there is nothing to read, so nothing to retry.
--
-- `encrypted_content`  WARP-233: at least one chunk is `sensitivity = sensitive`
--                      and holds a `dcv1:` ciphertext blob rather than text.
--                      Only chat-attached brain items are marked that way today
--                      and those carry `ncFileId = 0`, so this is a guard
--                      against a future widening — but extracting from base64
--                      would produce confident nonsense, and "we cannot read it"
--                      is the honest answer.
--
-- Both map to `not_needed`, not `failed`: nothing is broken, there is simply
-- nothing here to file. See `STATUS_FOR` in services/filing/worker.ts.

ALTER TYPE "ExtractReason" ADD VALUE IF NOT EXISTS 'no_text';
ALTER TYPE "ExtractReason" ADD VALUE IF NOT EXISTS 'encrypted_content';
