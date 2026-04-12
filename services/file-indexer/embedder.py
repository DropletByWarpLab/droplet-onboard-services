"""gRPC client for the ai-gateway's EmbedText RPC.

Connects to the ai-gateway on the Docker network (default: ai-gateway:50051).
Batches are sent synchronously — the file-indexer is a background daemon so
latency per call is acceptable.
"""

from __future__ import annotations

import logging
from typing import Optional

import grpc

from config import AI_GATEWAY_GRPC_URL, EMBEDDING_MODEL

logger = logging.getLogger(__name__)

# Lazy channel — created on first call.
_channel: Optional[grpc.Channel] = None
_stub = None


def _get_stub():
    global _channel, _stub
    if _stub is not None:
        return _stub

    try:
        # Try importing the proto-generated modules.
        # In Docker these are generated at build time; locally they may not exist.
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "grpc_generated"))
        from grpc_generated import inference_pb2, inference_pb2_grpc
    except ImportError:
        # Fallback: generate on the fly from the shared proto.
        logger.warning("grpc_generated not found — generating from proto/inference.proto")
        from grpc_tools import protoc
        protoc.main([
            "", "-I", "/app/proto",
            "--python_out=/app/grpc_generated",
            "--grpc_python_out=/app/grpc_generated",
            "/app/proto/inference.proto",
        ])
        from grpc_generated import inference_pb2, inference_pb2_grpc

    _channel = grpc.insecure_channel(AI_GATEWAY_GRPC_URL)
    _stub = inference_pb2_grpc.InferenceServiceStub(_channel)
    return _stub


def embed_texts(texts: list[str], model: str = EMBEDDING_MODEL) -> list[list[float]]:
    """Call the ai-gateway to compute embeddings.

    Returns a list of float vectors, one per input text.
    Raises on gRPC failure so the caller can skip indexing that file.
    """
    if not texts:
        return []

    try:
        from grpc_generated import inference_pb2
    except ImportError:
        _get_stub()
        from grpc_generated import inference_pb2

    stub = _get_stub()
    request = inference_pb2.EmbedRequest(texts=texts, model=model)
    response = stub.EmbedText(request, timeout=60)

    return [list(arr.values) for arr in response.embeddings]
