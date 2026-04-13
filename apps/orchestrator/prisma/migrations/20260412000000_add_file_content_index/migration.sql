-- Phase 4: AI file content indexing with pgvector.
--
-- The file-indexer watches Nextcloud's data volume, extracts text from
-- documents (PDF, DOCX, XLSX, HTML, plaintext), chunks it into ~512-token
-- windows, computes embeddings via the ai-gateway's EmbedText gRPC, and
-- stores them here for cosine-similarity search.

-- Enable pgvector extension (idempotent).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "FileContentChunk" (
    "id"        BIGSERIAL    NOT NULL,
    "userId"    TEXT         NOT NULL,
    "ncFileId"  INTEGER      NOT NULL,
    "path"      TEXT         NOT NULL,
    "chunkIdx"  INTEGER      NOT NULL,
    "text"      TEXT         NOT NULL,
    "embedding" vector(384)  NOT NULL,
    "indexedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileContentChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FileContentChunk_ncFileId_chunkIdx_key"
    ON "FileContentChunk"("ncFileId", "chunkIdx");

CREATE INDEX "FileContentChunk_userId_idx"
    ON "FileContentChunk"("userId");

-- IVFFlat index for fast approximate nearest-neighbor search.
-- lists=100 is a good default for datasets up to ~100K chunks.
-- Rebuild with more lists if the dataset grows beyond that.
CREATE INDEX "FileContentChunk_embedding_idx"
    ON "FileContentChunk"
    USING ivfflat ("embedding" vector_cosine_ops)
    WITH (lists = 100);
