"""WARP-286 — Rerank gRPC handler.

The handler delegates to reranker.RerankerSingleton.compute_score(). We
mock the singleton in these tests so we don't load the real model
(~280 MB int8 ONNX from Hugging Face).

The handler is async and lives on `grpc_server.InferenceServicer` (not
`main.py`); these tests follow the same pattern as `test_grpc.py`.
"""

from __future__ import annotations

import asyncio
import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

try:
    import grpc  # noqa: F401
    _deps_available = True
except ImportError:
    _deps_available = False

pytestmark = pytest.mark.skipif(
    not _deps_available, reason="gRPC dependencies not installed"
)


def _install_proto_stubs() -> None:
    """Install fake `grpc_generated` modules in sys.modules.

    Mirrors test_grpc.py's helper but adds the RerankRequest / RerankResponse
    classes needed by the new handler.
    """
    pkg_name = "grpc_generated"
    pb2_name = f"{pkg_name}.inference_pb2"
    pb2_grpc_name = f"{pkg_name}.inference_pb2_grpc"

    pkg_mod = types.ModuleType(pkg_name)
    pkg_mod.__path__ = []  # type: ignore[attr-defined]

    pb2_mod = types.ModuleType(pb2_name)
    pb2_mod.ChatResponse = MagicMock(name="ChatResponse")
    pb2_mod.ChatChunk = MagicMock(name="ChatChunk")
    pb2_mod.ModelList = MagicMock(name="ModelList")
    pb2_mod.ModelInfo = MagicMock(name="ModelInfo")
    pb2_mod.Usage = MagicMock(name="Usage")
    pb2_mod.EmbedResponse = MagicMock(name="EmbedResponse")
    pb2_mod.FloatArray = MagicMock(name="FloatArray")
    # WARP-286 additions:
    pb2_mod.RerankRequest = MagicMock(name="RerankRequest")
    pb2_mod.RerankResponse = MagicMock(name="RerankResponse")

    pb2_grpc_mod = types.ModuleType(pb2_grpc_name)
    pb2_grpc_mod.InferenceServiceServicer = object
    pb2_grpc_mod.add_InferenceServiceServicer_to_server = lambda *a, **kw: None

    pkg_mod.inference_pb2 = pb2_mod  # type: ignore[attr-defined]
    pkg_mod.inference_pb2_grpc = pb2_grpc_mod  # type: ignore[attr-defined]

    sys.modules[pkg_name] = pkg_mod
    sys.modules[pb2_name] = pb2_mod
    sys.modules[pb2_grpc_name] = pb2_grpc_mod


@pytest.fixture(autouse=True)
def _patch_grpc_generated():
    """Install fake proto modules + drop cached grpc_server."""
    saved = {
        k: sys.modules[k]
        for k in (
            "grpc_generated",
            "grpc_generated.inference_pb2",
            "grpc_generated.inference_pb2_grpc",
            "grpc_server",
            "reranker",
        )
        if k in sys.modules
    }
    for k in list(saved):
        del sys.modules[k]
    _install_proto_stubs()
    try:
        yield
    finally:
        for k in (
            "grpc_generated",
            "grpc_generated.inference_pb2",
            "grpc_generated.inference_pb2_grpc",
            "grpc_server",
            "reranker",
        ):
            sys.modules.pop(k, None)
        sys.modules.update(saved)


def _make_servicer():
    """Build an InferenceServicer with mock router + scheduler."""
    from grpc_server import InferenceServicer

    router = MagicMock()
    router.chat = AsyncMock()
    scheduler = MagicMock()
    scheduler.enqueue = AsyncMock()
    scheduler.release = AsyncMock()
    return InferenceServicer(router, scheduler)


def _make_context():
    ctx = MagicMock()
    ctx.set_code = MagicMock()
    ctx.set_details = MagicMock()
    return ctx


def _make_request(query: str, passages, model: str = ""):
    """Build a fake RerankRequest. The real proto message has .query,
    .passages, .model attributes."""
    req = MagicMock()
    req.query = query
    req.passages = passages
    req.model = model
    return req


def _install_fake_reranker(scores):
    """Install a `reranker` module with a RerankerSingleton stub."""
    mod = types.ModuleType("reranker")
    inst = MagicMock()
    inst.compute_score = MagicMock(return_value=list(scores))

    class _Singleton:
        @classmethod
        def instance(cls):
            return inst

    mod.RerankerSingleton = _Singleton
    sys.modules["reranker"] = mod
    return inst


@pytest.mark.asyncio
async def test_rerank_returns_one_score_per_passage():
    """Happy path: 3 passages → 3 scores in the same order."""
    inst = _install_fake_reranker([0.92, 0.41, 0.78])
    servicer = _make_servicer()
    req = _make_request(
        query="budget for q4",
        passages=["q4 revenue forecast", "lunch menu", "q4 budget proposal"],
    )
    ctx = _make_context()

    # Patch the inference_pb2.RerankResponse constructor so we can capture
    # the scores= kwarg directly.
    captured = {}

    def _capture_response(**kwargs):
        captured.update(kwargs)
        return MagicMock(scores=kwargs.get("scores", []))

    import grpc_generated.inference_pb2 as pb2

    pb2.RerankResponse.side_effect = _capture_response

    await servicer.Rerank(req, ctx)
    assert captured["scores"] == [0.92, 0.41, 0.78]

    # Verify the singleton was called with the (query, passage) pairs.
    inst.compute_score.assert_called_once()
    call_pairs = inst.compute_score.call_args[0][0]
    assert call_pairs == [
        ["budget for q4", "q4 revenue forecast"],
        ["budget for q4", "lunch menu"],
        ["budget for q4", "q4 budget proposal"],
    ]


@pytest.mark.asyncio
async def test_rerank_empty_passages_returns_empty():
    """Empty passages list short-circuits the model call."""
    inst = _install_fake_reranker([])
    servicer = _make_servicer()
    req = _make_request(query="anything", passages=[])
    ctx = _make_context()

    captured = {}

    def _capture_response(**kwargs):
        captured.update(kwargs)
        return MagicMock()

    import grpc_generated.inference_pb2 as pb2

    pb2.RerankResponse.side_effect = _capture_response

    await servicer.Rerank(req, ctx)
    # Should have called RerankResponse(scores=[]) and never touched the model.
    assert captured["scores"] == []
    inst.compute_score.assert_not_called()


@pytest.mark.asyncio
async def test_rerank_rejects_unsupported_model():
    """Unknown model id → INVALID_ARGUMENT, model not called."""
    inst = _install_fake_reranker([1.0])
    servicer = _make_servicer()
    req = _make_request(
        query="x", passages=["y"], model="not-a-real-model"
    )
    ctx = _make_context()

    await servicer.Rerank(req, ctx)
    ctx.set_code.assert_called_once_with(grpc.StatusCode.INVALID_ARGUMENT)
    inst.compute_score.assert_not_called()


@pytest.mark.asyncio
async def test_rerank_model_error_returns_internal():
    """Model raising propagates as INTERNAL gRPC error."""
    mod = types.ModuleType("reranker")
    inst = MagicMock()
    inst.compute_score = MagicMock(side_effect=RuntimeError("ONNX session crashed"))

    class _Singleton:
        @classmethod
        def instance(cls):
            return inst

    mod.RerankerSingleton = _Singleton
    sys.modules["reranker"] = mod

    servicer = _make_servicer()
    req = _make_request(query="x", passages=["y"])
    ctx = _make_context()

    await servicer.Rerank(req, ctx)
    ctx.set_code.assert_called_once_with(grpc.StatusCode.INTERNAL)
