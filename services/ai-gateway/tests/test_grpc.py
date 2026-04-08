"""Structural tests for the gRPC InferenceServicer.

Since proto stubs (grpc_generated/) may not be available in the test
environment, these tests verify that InferenceServicer can be
instantiated with mocked dependencies and that its public methods
exist and handle errors gracefully.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Skip all tests if full AI gateway dependencies are not installed
try:
    import grpc  # noqa: F401
    import cryptography  # noqa: F401
    _deps_available = True
except ImportError:
    _deps_available = False

pytestmark = pytest.mark.skipif(not _deps_available, reason="gRPC dependencies not installed")

# Mock the proto-generated modules before importing grpc_server
_mock_pb2 = MagicMock()
_mock_pb2.ChatResponse = MagicMock
_mock_pb2.ChatChunk = MagicMock
_mock_pb2.ModelList = MagicMock
_mock_pb2.ModelInfo = MagicMock
_mock_pb2.Usage = MagicMock

_mock_pb2_grpc = MagicMock()
_mock_pb2_grpc.InferenceServiceServicer = object  # base class for servicer


@pytest.fixture(autouse=True)
def _patch_grpc_generated():
    """Patch proto-generated modules so grpc_server can be imported without stubs."""
    import sys
    with patch.dict(sys.modules, {
        "grpc_generated": MagicMock(),
        "grpc_generated.inference_pb2": _mock_pb2,
        "grpc_generated.inference_pb2_grpc": _mock_pb2_grpc,
    }):
        yield


def _make_mock_router():
    """Create a mock ProviderRouter."""
    router = MagicMock()
    router.chat = AsyncMock(return_value={
        "choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}],
        "model": "test-model",
        "usage": {"prompt_tokens": 5, "completion_tokens": 3},
    })
    router.list_all_models = AsyncMock(return_value=[])
    return router


def _make_mock_scheduler():
    """Create a mock InferenceScheduler."""
    scheduler = MagicMock()
    future: asyncio.Future = asyncio.get_event_loop().create_future()
    future.set_result(None)
    scheduler.enqueue = AsyncMock(return_value=future)
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
        assert asyncio.iscoroutinefunction(servicer.Chat)

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
        assert asyncio.iscoroutinefunction(servicer.ListModels)


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
