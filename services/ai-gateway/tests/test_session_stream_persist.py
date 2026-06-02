"""GW-07: a streamed session reply must be persisted even when the stream is
cut short (client disconnect / mid-stream upstream error), not only after the
generator fully drains.

Before the fix, the assistant turn was saved on the line *after* the
``async for`` loop, so a disconnect (GeneratorExit) or an upstream error left
the user turn stored with no assistant reply — silent history loss. These tests
drive the real ``/ai/sessions/{id}/chat`` streaming endpoint and assert the
assistant message lands in all three cases.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

import main


def _sse(text: str) -> str:
    # Minimal OpenAI-style streaming SSE frame carrying a content delta.
    return 'data: {"choices":[{"delta":{"content":"%s"}}]}\n\n' % text


async def _make_session(client, model: str = "llama3:8b") -> str:
    resp = await client.post("/ai/sessions", json={"model": model})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _assistant_messages(session_id: str) -> list[str]:
    session = await main.session_store.get(session_id)
    return [m.content for m in session.messages if m.role == "assistant"]


class TestSessionStreamPersistence:
    async def test_full_stream_persists_assistant_reply(self, client_with_sessions):
        """Happy path still works: a fully-drained stream saves the joined text."""
        session_id = await _make_session(client_with_sessions)

        async def gen():
            yield _sse("Hello")
            yield _sse(" world")
            yield "data: [DONE]\n\n"

        with patch.object(main.provider_router, "chat", AsyncMock(return_value=gen())):
            resp = await client_with_sessions.post(
                f"/ai/sessions/{session_id}/chat",
                json={"message": "hi", "stream": True},
            )
            # Drain the streaming response fully.
            body = (await resp.aread()).decode()

        assert "Hello" in body
        assert await _assistant_messages(session_id) == ["Hello world"]

    async def test_midstream_error_persists_partial_reply(self, client_with_sessions):
        """An upstream error after some deltas → the partial reply is saved,
        not silently dropped."""
        session_id = await _make_session(client_with_sessions)

        async def gen():
            yield _sse("Partial")
            raise RuntimeError("upstream blew up mid-stream")

        with patch.object(main.provider_router, "chat", AsyncMock(return_value=gen())):
            try:
                async with client_with_sessions.stream(
                    "POST",
                    f"/ai/sessions/{session_id}/chat",
                    json={"message": "hi", "stream": True},
                ) as resp:
                    async for _ in resp.aiter_raw():
                        pass
            except BaseException:
                # The transport surfaces the mid-stream upstream error (possibly
                # inside an exception group); that's fine — we only care that the
                # partial reply was persisted by stream_and_save's finally.
                pass

        assert await _assistant_messages(session_id) == ["Partial"]

    async def test_client_disconnect_persists_partial_reply(
        self, client_with_sessions
    ):
        """A client disconnect closes the response body iterator with
        GeneratorExit mid-stream (exactly what Starlette does). We reproduce
        that deterministically by grabbing the StreamingResponse's
        ``body_iterator``, pulling a couple of chunks, then ``aclose()``-ing it —
        and assert the partial reply was still persisted by the finally."""
        from main import session_chat
        from schemas import SessionChatRequest

        session_id = await _make_session(client_with_sessions)

        async def gen():
            yield _sse("Early")
            yield _sse(" bytes")
            yield _sse(" then gone")
            yield "data: [DONE]\n\n"

        with patch.object(main.provider_router, "chat", AsyncMock(return_value=gen())):
            response = await session_chat(
                session_id,
                SessionChatRequest(message="hi", stream=True),
            )
            it = response.body_iterator
            # Consume the first two content frames, then simulate the client
            # going away: close the iterator → GeneratorExit into the finally.
            await it.__anext__()
            await it.__anext__()
            await it.aclose()

        # The finally must have persisted whatever was collected before the
        # disconnect — the assistant turn must NOT be silently absent.
        msgs = await _assistant_messages(session_id)
        assert len(msgs) == 1
        assert msgs[0].startswith("Early")
        # Only the consumed deltas were collected (not " then gone").
        assert "then gone" not in msgs[0]
