"""Configuration from environment variables."""

import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://droplet:droplet@localhost:5432/droplet",
)

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
