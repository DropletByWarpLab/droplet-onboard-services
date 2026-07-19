-- WARP-242: per-document DEKs + crypto-shred deletion path.

-- 1) DocumentEncryptionKey — versioned keying (keyId, version) per the
--    rotation design. Rotation (follow-up slice) mints version N+1 and
--    re-encrypts chunks in the background before deleting version N; today
--    every row is version 1 and readers take the latest version.
--    Crypto-shred deletes ALL versions for a keyId.
ALTER TABLE "DocumentEncryptionKey"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "DocumentEncryptionKey"
  DROP CONSTRAINT "DocumentEncryptionKey_pkey";
ALTER TABLE "DocumentEncryptionKey"
  ADD CONSTRAINT "DocumentEncryptionKey_pkey" PRIMARY KEY ("keyId", "version");

-- 2) text_tsv — NULL the lexical tsvector for encrypted (sensitive) chunks.
--    A tsvector generated over dcv1 ciphertext would index base64 garbage,
--    and keeping a plaintext-derived tsvector would leak a stemmed positional
--    bag-of-words of the document into every pg_dump, gutting crypto-shred.
--    Postgres cannot ALTER a generated expression in place — drop + re-add
--    (STORED → one-time table rewrite; the GIN index is dropped with the
--    column and re-created below).
ALTER TABLE "FileContentChunk" DROP COLUMN "text_tsv";
ALTER TABLE "FileContentChunk"
  ADD COLUMN "text_tsv" tsvector
  GENERATED ALWAYS AS (
    CASE
      WHEN "sensitivity" = 'sensitive'::"ChunkSensitivity" THEN NULL
      ELSE setweight(to_tsvector('english', coalesce("text", '')), 'A')
    END
  ) STORED;
CREATE INDEX "FileContentChunk_text_tsv_idx"
  ON "FileContentChunk" USING GIN ("text_tsv");

-- NOTE: encrypting pre-existing brain chunks is NOT done in SQL (the DEK
-- wrap/unwrap is app-side HKDF/AES-GCM). Run the idempotent backfill after
-- this migration applies, inside the orchestrator container:
--   node dist/scripts/encrypt-existing-brain-chunks.js        # apply
--   node dist/scripts/encrypt-existing-brain-chunks.js --dry  # report only
