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

# Embedding model (must match the pgvector column dimension — 384 for MiniLM)
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")

# Chunking params
CHUNK_SIZE_TOKENS = int(os.environ.get("CHUNK_SIZE_TOKENS", "512"))
CHUNK_OVERLAP_RATIO = float(os.environ.get("CHUNK_OVERLAP_RATIO", "0.2"))

# WARP-1140: shared "Household" groupfolder support. Groupfolder content
# physically lives under {NEXTCLOUD_DATA_ROOT}/__groupfolders/<id>/..., never
# under a user home, so the watcher indexes it under the HOUSEHOLD_USER_ID
# sentinel with a "/<SHARED_FOLDER_NAME>/..." display path — the path each
# household member sees in their own WebDAV home. Both values must match the
# orchestrator (DROPLET_SHARED_FOLDER_NAME in config.ts; HOUSEHOLD_INDEX_USER
# in routes/files.ts).
SHARED_FOLDER_NAME = os.environ.get("DROPLET_SHARED_FOLDER_NAME", "Household")
HOUSEHOLD_USER_ID = "__household__"
