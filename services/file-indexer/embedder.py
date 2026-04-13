"""gRPC client for the ai-gateway's EmbedText RPC.

Connects to the ai-gateway on the Docker network (default: ai-gateway:50051).
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Optional

import grpc

from config import AI_GATEWAY_GRPC_URL, EMBEDDING_MODEL

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
    _channel = grpc.insecure_channel(AI_GATEWAY_GRPC_URL)
    _stub = inference_pb2_grpc.InferenceServiceStub(_channel)
    logger.info("gRPC stub created for %s", AI_GATEWAY_GRPC_URL)
    return _stub


def embed_texts(texts: list[str], model: str = EMBEDDING_MODEL) -> list[list[float]]:
    """Call the ai-gateway to compute embeddings.

    Returns a list of float vectors, one per input text.
    Raises on gRPC failure so the caller can skip indexing that file.
    """
    if not texts:
        return []

    from grpc_generated import inference_pb2

    stub = _get_stub()
    request = inference_pb2.EmbedRequest(texts=texts, model=model)
    response = stub.EmbedText(request, timeout=60)

    return [list(arr.values) for arr in response.embeddings]
