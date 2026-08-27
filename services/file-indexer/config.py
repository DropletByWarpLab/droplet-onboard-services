"""Configuration from environment variables."""

import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://droplet:droplet@localhost:5432/droplet",
)


def derive_nextcloud_db_url(url: str) -> str:
    """Swap only the database name (the URL path) for ``nextcloud``.

    WARP-1327: a plain ``url.replace("/droplet", "/nextcloud")`` also rewrites
    the USERNAME (``//droplet:`` matches too), producing a role that doesn't
    exist. Only the path component is the db name; credentials and query
    params (``?sslmode=require``, WARP-233) must survive untouched.
    """
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url)
    return urlunsplit(parts._replace(path="/nextcloud"))


# Nextcloud shares the Postgres instance; its DB holds oc_storages/
# oc_filecache for file-id resolution. Overridable so a dedicated read-only
# role (WARP-1328) can be injected without deriving from the app URL.
NEXTCLOUD_DATABASE_URL = os.environ.get(
    "NEXTCLOUD_DATABASE_URL"
) or derive_nextcloud_db_url(DATABASE_URL)

MQTT_BROKER = os.environ.get("MQTT_BROKER", "mqtt://localhost:1883")

# Where Nextcloud stores user files (read-only bind mount from nextcloud-data volume)
NEXTCLOUD_DATA_ROOT = os.environ.get("NEXTCLOUD_DATA_ROOT", "/data/nextcloud/data")

# ai-gateway gRPC endpoint for embedding
AI_GATEWAY_GRPC_URL = os.environ.get("AI_GATEWAY_GRPC_URL", "localhost:50051")

# WARP-242: doc-KEK master keyfile (raw 32 bytes, minted by setup.sh as
# data/secrets/doc-kek.key and single-file bind-mounted read-only). The KEK
# that wraps per-document DEKs derives from this file — never from .env,
# which travels inside restic snapshots (see column_crypto.py).
DOC_KEK_PATH = os.environ.get("DOC_KEK_PATH", "/data/secrets/doc-kek.key")

# Embedding model. Must be a key of embedding_models.EMBEDDING_MODELS — the
# registry carries the Hub repo, the context window and the output width, none
# of which are derivable from the id.
#
# WARP-2196: was `all-MiniLM-L6-v2`, whose `max_seq_length` is 256 while
# CHUNK_SIZE_TOKENS is 512 — the embedder dropped the back half of every
# full-size chunk. `bge-small-en-v1.5` is MIT, has a 512-token window and the
# same 384 dimensions, so `FileContentChunk.embedding` stays `vector(384)` and
# its index is untouched. Changing this value REQUIRES a full corpus re-embed:
# see docs/RAG_RE_EMBED_RUNBOOK.md. Vectors from two different
# models are not comparable even at equal width.
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "bge-small-en-v1.5")

# Chunking params. CHUNK_SIZE_TOKENS is the WHOLE per-chunk embedder budget —
# body text plus the WARP-435 contextual header — not the body alone.
CHUNK_SIZE_TOKENS = int(os.environ.get("CHUNK_SIZE_TOKENS", "512"))
CHUNK_OVERLAP_RATIO = float(os.environ.get("CHUNK_OVERLAP_RATIO", "0.2"))

# WARP-2191: tokens reserved out of CHUNK_SIZE_TOKENS for the contextual
# header `format_chunk_with_header` prepends AFTER splitting. Without the
# reservation the header is pure overrun — the splitter has already spent the
# full budget on body text by the time the header is added.
#
# 64 is measured, not guessed. Header token counts under the bge tokenizer
# across 905 realistic (filename, section_path) pairs — every `docs/**.md`
# filename crossed with 1-4 levels of its own real headings, plus the eval
# fixture filenames: median 37, p90 57, p95 64, p99 77, max 142. 64 leaves
# every header in 95% of that corpus intact and costs 12.5% of the window;
# deeper breadcrumbs lose their trailing entries (see
# `format_chunk_with_header`), never their document name.
CHUNK_HEADER_BUDGET_TOKENS = int(os.environ.get("CHUNK_HEADER_BUDGET_TOKENS", "64"))

# Max texts per EmbedText RPC. The ai-gateway caps a single request at
# MAX_BATCH_SIZE (providers/embeddings.py, 256) to bound peak memory on
# constrained hardware and REJECTS anything larger outright — it does not
# split for us. Keep this at or below the gateway's cap; embedder.py splits
# oversized calls into this many texts per request.
EMBED_MAX_BATCH = int(os.environ.get("EMBED_MAX_BATCH", "256"))

# WARP-1140: shared "Household" groupfolder support. Groupfolder content
# physically lives under {NEXTCLOUD_DATA_ROOT}/__groupfolders/<id>/..., never
# under a user home, so the watcher indexes it under the HOUSEHOLD_USER_ID
# sentinel with a "/<SHARED_FOLDER_NAME>/..." display path — the path each
# household member sees in their own WebDAV home. Both values must match the
# orchestrator (DROPLET_SHARED_FOLDER_NAME in config.ts; HOUSEHOLD_INDEX_USER
# in routes/files.ts).
SHARED_FOLDER_NAME = os.environ.get("DROPLET_SHARED_FOLDER_NAME", "Household")
HOUSEHOLD_USER_ID = "__household__"
