"""GW-08: provider/LiteLLM error text must NOT be echoed to the client.

The HTTP chat endpoints (and the gRPC Chat/StreamChat paths) used to return
``f"Provider error: {str(e)}"`` / ``set_details(f"Inference error: {str(e)}")``,
which leaks upstream provider error bodies, request URLs, and model names. These
tests assert the client now gets a generic message plus a correlation id, while
the sensitive text stays server-side (logged).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

import main


_SECRET = "https://api.openai.com/v1/chat sk-LEAKED-UPSTREAM-secret-body"


async def _ensure_chat_globals():
    """Initialise + start the module globals the chat path needs (the plain
    ASGI test transport doesn't run the app lifespan, so these are None)."""
    if main.provider_router is None:
        from router import ProviderRouter

        main.provider_router = ProviderRouter()
    if main.inference_scheduler is None:
        from scheduler import InferenceScheduler

        main.inference_scheduler = InferenceScheduler()
        await main.inference_scheduler.start()


class TestHttpProviderErrorDisclosure:
    async def test_chat_does_not_leak_provider_error(self, client):
        """A provider exception → 502 with a generic, correlation-id'd message,
        not the raw upstream text."""
        await _ensure_chat_globals()
        # The scheduler grants a slot, then provider_router.chat raises the
        # leaky error — the handler must NOT forward it to the client.
        with patch.object(
            main.provider_router, "chat", AsyncMock(side_effect=RuntimeError(_SECRET))
        ):
            resp = await client.post(
                "/ai/chat",
                json={
                    "model": "llama3:8b",
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": False,
                },
            )
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert _SECRET not in detail
        assert "sk-LEAKED" not in detail
        assert "Upstream provider error" in detail
        assert "ref:" in detail

    async def test_session_chat_does_not_leak_provider_error(
        self, client_with_sessions
    ):
        # Create a session first.
        created = await client_with_sessions.post(
            "/ai/sessions", json={"model": "llama3:8b"}
        )
        session_id = created.json()["id"]

        with patch.object(
            main.provider_router, "chat", AsyncMock(side_effect=RuntimeError(_SECRET))
        ):
            resp = await client_with_sessions.post(
                f"/ai/sessions/{session_id}/chat",
                json={"message": "hi", "stream": False},
            )
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert _SECRET not in detail
        assert "Upstream provider error" in detail
        assert "ref:" in detail


def test_grpc_provider_error_detail_is_generic():
    """The gRPC helper returns a generic, correlation-id'd detail string and
    never embeds the raw exception text."""
    from grpc_server import _provider_error_detail

    detail = _provider_error_detail(RuntimeError(_SECRET), "gRPC Chat error")
    assert _SECRET not in detail
    assert "Upstream provider error" in detail
    assert "ref:" in detail


def test_http_provider_error_detail_is_generic():
    from main import _provider_error_detail

    detail = _provider_error_detail(RuntimeError(_SECRET), "Chat error")
    assert _SECRET not in detail
    assert "Upstream provider error" in detail
    assert "ref:" in detail
