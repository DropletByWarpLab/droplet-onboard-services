"""gRPC client for the ai-gateway's EmbedText RPC.

Connects to the ai-gateway on the Docker network (default: ai-gateway:50051).
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Optional

import grpc

from config import AI_GATEWAY_GRPC_URL, EMBED_MAX_BATCH, EMBEDDING_MODEL

logger = logging.getLogger(__name__)

# Ensure grpc_generated is importable — the Dockerfile generates the stubs
# there at build time, and the directory is at /app/grpc_generated.
_grpc_gen_path = os.path.join(os.path.dirname(__file__), "grpc_generated")
if _grpc_gen_path not in sys.path:
    sys.path.insert(0, _grpc_gen_path)

_channel: Optional[grpc.Channel] = None
_stub = None


def _get_stub():
    global _channel, _stub
    if _stub is not None:
        # Check channel health — recreate if the ai-gateway restarted.
        try:
            state = _channel.check_connectivity_state(True) if _channel else None
            if state == grpc.ChannelConnectivity.SHUTDOWN:
                logger.info("gRPC channel in SHUTDOWN state, reconnecting...")
                _channel = None
                _stub = None
        except Exception:
            _channel = None
            _stub = None

    if _stub is not None:
        return _stub

    from grpc_generated import inference_pb2_grpc
    _channel = _create_channel()
    _stub = inference_pb2_grpc.InferenceServiceStub(_channel)
    logger.info("gRPC stub created for %s", AI_GATEWAY_GRPC_URL)
    return _stub


def _create_channel() -> grpc.Channel:
    """WARP-1061 (hop 16, client half): dial ai-gateway :50051 per the
    internal-mTLS contract. DROPLET_INTERNAL_TLS=1 → secure channel
    presenting this service's /data/service-tls bundle with trust pinned to
    the internal CA (the server REQUIRES the client cert); unset/0 → the
    historical insecure channel, byte-identical to before."""
    from _shared.internal_tls import enabled, grpc_channel_credentials

    if enabled():
        return grpc.secure_channel(AI_GATEWAY_GRPC_URL, grpc_channel_credentials())
    return grpc.insecure_channel(AI_GATEWAY_GRPC_URL)


def embed_texts(texts: list[str], model: str = EMBEDDING_MODEL) -> list[list[float]]:
    """Call the ai-gateway to compute embeddings.

    Returns a list of float vectors, one per input text, in input order.
    Raises on gRPC failure so the caller can skip indexing that file.

    Requests are split into batches of at most ``EMBED_MAX_BATCH``. The
    gateway enforces its own MAX_BATCH_SIZE and fails the whole RPC with
    INTERNAL "Batch size N exceeds maximum 256" rather than splitting, and
    the caller hands us every chunk of a document in one call — so before
    this split, any document over ~256 chunks failed to index *entirely*.
    That failure scaled with document size, which meant the largest and
    most information-dense files were precisely the ones that never
    reached the index, while small ones indexed fine and made the RAG look
    healthy.
    """
    if not texts:
        return []

    from grpc_generated import inference_pb2

    batch_size = max(1, EMBED_MAX_BATCH)
    stub = _get_stub()
    vectors: list[list[float]] = []

    for start in range(0, len(texts), batch_size):
        batch = texts[start:start + batch_size]
        request = inference_pb2.EmbedRequest(texts=batch, model=model)
        response = stub.EmbedText(request, timeout=60)
        vectors.extend(list(arr.values) for arr in response.embeddings)

    return vectors
