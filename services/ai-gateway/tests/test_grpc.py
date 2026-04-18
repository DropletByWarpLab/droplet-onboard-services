"""Structural tests for the gRPC InferenceServicer.

Since proto stubs (grpc_generated/) may not be available in the test
environment, these tests verify that InferenceServicer can be
instantiated with mocked dependencies and that its public methods
exist and handle errors gracefully.
"""

from __future__ import annotations

import asyncio
import inspect
import sys
import types
from unittest.mock import AsyncMock, MagicMock

import pytest

# Skip all tests if full AI gateway dependencies are not installed.
# Only gRPC is dep-gated — everything else in the fixture set (cryptography,
# pydantic, etc.) is already covered by the broader test suite's requirements.
try:
    import grpc  # noqa: F401
    _deps_available = True
except ImportError:
    _deps_available = False

pytestmark = pytest.mark.skipif(not _deps_available, reason="gRPC dependencies not installed")


def _install_proto_stubs() -> None:
    """Install fake `grpc_generated` modules in sys.modules.

    `grpc_generated/` ships only an __init__.py in the repo; the real
    pb2 modules are produced by protoc at build time. We install stand-in
    modules so `from grpc_generated import inference_pb2, inference_pb2_grpc`
    in grpc_server.py resolves without requiring the generated stubs.

    We use real `types.ModuleType` objects (not MagicMock) because Python's
    `from pkg import sub` resolution reaches into `sys.modules[pkg.sub]` and
    calls `getattr(pkg, sub)` — a bare MagicMock for `pkg` silently returns
    an auto-generated child Mock rather than the `pkg.sub` we registered,
    which makes class inheritance (`class X(pb2_grpc.InferenceServiceServicer)`)
    silently produce a MagicMock class instead of a real one.
    """
    pkg_name = "grpc_generated"
    pb2_name = f"{pkg_name}.inference_pb2"
    pb2_grpc_name = f"{pkg_name}.inference_pb2_grpc"

    # Real package module with __path__ so Python treats it as a package.
    pkg_mod = types.ModuleType(pkg_name)
    pkg_mod.__path__ = []  # type: ignore[attr-defined]

    pb2_mod = types.ModuleType(pb2_name)
    # Message classes can be plain MagicMock-returning callables; grpc_server
    # only instantiates them and passes fields through.
    pb2_mod.ChatResponse = MagicMock(name="ChatResponse")
    pb2_mod.ChatChunk = MagicMock(name="ChatChunk")
    pb2_mod.ModelList = MagicMock(name="ModelList")
    pb2_mod.ModelInfo = MagicMock(name="ModelInfo")
    pb2_mod.Usage = MagicMock(name="Usage")
    pb2_mod.EmbedResponse = MagicMock(name="EmbedResponse")
    pb2_mod.FloatArray = MagicMock(name="FloatArray")

    pb2_grpc_mod = types.ModuleType(pb2_grpc_name)
    # The servicer base must be a real class so `class InferenceServicer(Base)`
    # produces a real class with real async methods.
    pb2_grpc_mod.InferenceServiceServicer = object
    pb2_grpc_mod.add_InferenceServiceServicer_to_server = lambda *a, **kw: None

    pkg_mod.inference_pb2 = pb2_mod  # type: ignore[attr-defined]
    pkg_mod.inference_pb2_grpc = pb2_grpc_mod  # type: ignore[attr-defined]

    sys.modules[pkg_name] = pkg_mod
    sys.modules[pb2_name] = pb2_mod
    sys.modules[pb2_grpc_name] = pb2_grpc_mod


@pytest.fixture(autouse=True)
def _patch_grpc_generated():
    """Install fake proto modules for the duration of each test.

    Also force a fresh import of grpc_server so the fake `inference_pb2_grpc`
    is bound on this test run — without this, a cached grpc_server module
    from a previous test file could hold a stale reference.
    """
    saved = {
        k: sys.modules[k]
        for k in ("grpc_generated", "grpc_generated.inference_pb2", "grpc_generated.inference_pb2_grpc", "grpc_server")
        if k in sys.modules
    }
    for k in list(saved):
        del sys.modules[k]
    _install_proto_stubs()
    try:
        yield
    finally:
        for k in ("grpc_generated", "grpc_generated.inference_pb2", "grpc_generated.inference_pb2_grpc", "grpc_server"):
            sys.modules.pop(k, None)
        sys.modules.update(saved)


def _make_mock_router():
    """Create a mock ProviderRouter with async methods."""
    router = MagicMock()
    router.chat = AsyncMock(return_value={
        "choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}],
        "model": "test-model",
        "usage": {"prompt_tokens": 5, "completion_tokens": 3},
    })
    router.list_all_models = AsyncMock(return_value=[])
    return router


def _make_mock_scheduler():
    """Create a mock InferenceScheduler.

    `enqueue` is async and returns a Future. We return an AsyncMock that,
    when awaited, yields a ready Future (already has result set). The
    Future is created lazily so this helper does not require a running
    event loop — a plain asyncio.Future() constructed without a loop
    argument is fine in Python 3.10+ and becomes associated with the
    running loop when first awaited.
    """
    scheduler = MagicMock()

    async def _enqueue(*args, **kwargs):
        fut: asyncio.Future = asyncio.Future()
        fut.set_result(None)
        return fut

    scheduler.enqueue = AsyncMock(side_effect=_enqueue)
    scheduler.release = AsyncMock()
    return scheduler


def _make_mock_context():
    """Create a mock gRPC context."""
    ctx = MagicMock()
    ctx.set_code = MagicMock()
    ctx.set_details = MagicMock()
    ctx.set_trailing_metadata = MagicMock()
    return ctx


class TestInferenceServicerInstantiation:
    """Verify the servicer can be created with mocked dependencies."""

    def test_instantiation(self):
        """InferenceServicer accepts a ProviderRouter and InferenceScheduler."""
        from grpc_server import InferenceServicer

        router = _make_mock_router()
        scheduler = _make_mock_scheduler()

        servicer = InferenceServicer(router, scheduler)

        assert servicer._router is router
        assert servicer._scheduler is scheduler


class TestInferenceServicerMethods:
    """Verify expected gRPC methods exist and are callable."""

    def test_chat_method_exists(self):
        """Chat method exists and is a coroutine function."""
        from grpc_server import InferenceServicer

        servicer = InferenceServicer(_make_mock_router(), _make_mock_scheduler())
        assert hasattr(servicer, "Chat")
        assert inspect.iscoroutinefunction(servicer.Chat)

    def test_stream_chat_method_exists(self):
        """StreamChat method exists and is callable."""
        from grpc_server import InferenceServicer

        servicer = InferenceServicer(_make_mock_router(), _make_mock_scheduler())
        assert hasattr(servicer, "StreamChat")
        assert callable(servicer.StreamChat)

    def test_list_models_method_exists(self):
        """ListModels method exists and is a coroutine function."""
        from grpc_server import InferenceServicer

        servicer = InferenceServicer(_make_mock_router(), _make_mock_scheduler())
        assert hasattr(servicer, "ListModels")
        assert inspect.iscoroutinefunction(servicer.ListModels)


class TestChatErrorHandling:
    """Verify Chat handles errors from the scheduler and router."""

    @pytest.mark.asyncio
    async def test_chat_scheduler_queue_full(self):
        """Chat should set RESOURCE_EXHAUSTED when the scheduler rejects."""
        from scheduler import QueueFullError
        from grpc_server import InferenceServicer

        router = _make_mock_router()
        scheduler = _make_mock_scheduler()
        scheduler.enqueue = AsyncMock(
            side_effect=QueueFullError("Queue full", queue_depth=20, retry_after=5),
        )

        servicer = InferenceServicer(router, scheduler)
        request = MagicMock(priority=0)
        context = _make_mock_context()

        await servicer.Chat(request, context)

        context.set_code.assert_called_once()
        context.set_details.assert_called_once()

    @pytest.mark.asyncio
    async def test_chat_router_error(self):
        """Chat should set INTERNAL when the router raises."""
        from grpc_server import InferenceServicer

        router = _make_mock_router()
        router.chat = AsyncMock(side_effect=RuntimeError("provider down"))
        scheduler = _make_mock_scheduler()

        servicer = InferenceServicer(router, scheduler)

        request = MagicMock(priority=0, messages=[], model="test", temperature=0.7)
        request.HasField = MagicMock(return_value=False)
        context = _make_mock_context()

        await servicer.Chat(request, context)

        context.set_code.assert_called_once()
        context.set_details.assert_called_once()
        # Scheduler slot should be released even on error
        scheduler.release.assert_awaited_once()


class TestListModelsErrorHandling:
    """Verify ListModels handles errors gracefully."""

    @pytest.mark.asyncio
    async def test_list_models_router_error(self):
        """ListModels should set INTERNAL when the router raises."""
        from grpc_server import InferenceServicer

        router = _make_mock_router()
        router.list_all_models = AsyncMock(side_effect=RuntimeError("no providers"))
        scheduler = _make_mock_scheduler()

        servicer = InferenceServicer(router, scheduler)

        request = MagicMock()
        context = _make_mock_context()

        await servicer.ListModels(request, context)

        context.set_code.assert_called_once()
        context.set_details.assert_called_once()
