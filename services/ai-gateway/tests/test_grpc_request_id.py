"""WARP-108 — gRPC handlers self-seed a fresh request id per call.

Verifies each of the 6 InferenceServicer RPC methods seeds a fresh
request id (via `set_request_id(new_request_id())`) as the first thing
it does, so gRPC log lines are grouped under a real id instead of the
`no-request-context` marker. Cross-service gRPC propagation is out of
scope — this only covers per-call self-seeding on the gateway side.

Reuses the proto-stub/mocking machinery from `tests/test_grpc.py`
(`_install_proto_stubs`, `_patch_grpc_generated`, `_make_mock_router`,
`_make_mock_scheduler`, `_make_mock_context`).
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from request_context import get_request_id, request_id_var

from tests.test_grpc import (
    _make_mock_context,
    _make_mock_router,
    _make_mock_scheduler,
    _patch_grpc_generated,  # noqa: F401 (autouse fixture)
)


@pytest.mark.asyncio
async def test_list_models_seeds_fresh_request_id():
    """ListModels (a representative unary handler) seeds a UUIDv4-shaped id."""
    from grpc_server import InferenceServicer

    request_id_var.set(None)
    assert get_request_id() is None

    servicer = InferenceServicer(_make_mock_router(), _make_mock_scheduler())
    await servicer.ListModels(MagicMock(), _make_mock_context())

    rid = get_request_id()
    assert rid is not None
    assert len(rid) >= 8


@pytest.mark.asyncio
async def test_list_models_seeds_a_different_id_each_call():
    """Two successive calls each seed a fresh id, not a cached/reused one."""
    from grpc_server import InferenceServicer

    request_id_var.set(None)

    servicer = InferenceServicer(_make_mock_router(), _make_mock_scheduler())

    await servicer.ListModels(MagicMock(), _make_mock_context())
    first = get_request_id()

    await servicer.ListModels(MagicMock(), _make_mock_context())
    second = get_request_id()

    assert first is not None
    assert second is not None
    assert first != second
