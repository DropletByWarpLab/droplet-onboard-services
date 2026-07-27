"""WARP-1333 — gpt-oss's harmony parser intermittently 500s on tool calls.

Ollama returns `500 /v1/chat/completions` when the model emits a tool call
whose function name is polluted with channel tokens
(`harmonyparser.go:494 "no reverse mapping found for function name"`), and
the identical retry succeeds. Observed across three staging-suite runs at a
~30% per-completion kill rate — including MID-AGENT-LOOP completions, which
is why the retry lives here at the provider layer (every loop step passes
through `chat()`), not in the orchestrator.

Policy under test: on a 500 with tools present, retry the POST (bounded,
re-acquiring the semaphore per attempt); without tools, or once the budget
is spent, raise as before. 503 keeps its existing appliance-overload path.

WARP-1606 extends that policy to the STREAMING path (the shipped dashboard
path since WARP-1442) with one extra rule: a retry is only legal before the
first frame has been yielded. A stream that dies MID-flight must surface as-is
— replaying it would re-emit deltas the caller already has.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from providers.ollama_local import OllamaLocalProvider
from schemas import ChatMessage, ToolDefinition, ToolFunction

TEST_BASE_URL = "http://test-ollama:8002/proxy"
TEST_CHAT_URL = "http://test-ollama:8002/proxy/v1/chat/completions"

pytestmark = pytest.mark.anyio


@pytest.fixture
async def provider():
    p = OllamaLocalProvider(base_url=TEST_BASE_URL)
    yield p
    await p.close()


def _stub_limits(provider: OllamaLocalProvider) -> None:
    provider._limits.num_parallel = 1
    provider._limits._last_refresh = time.monotonic()
    provider._sema = asyncio.Semaphore(1)
    provider._sema_size = 1


def _tool() -> ToolDefinition:
    return ToolDefinition(function=ToolFunction(name="get_x", description="x"))


_OK = httpx.Response(
    200, json={"choices": [{"message": {"role": "assistant", "content": "hi"}}]}
)


@respx.mock
async def test_transient_500_with_tools_is_retried(provider):
    """500, 500, 200 → the caller sees the 200; three POSTs on the wire."""
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(
        side_effect=[httpx.Response(500, text="harmony boom"),
                     httpx.Response(500, text="harmony boom"),
                     _OK]
    )
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()) as slept:
        result = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            tools=[_tool()],
        )
    assert result["choices"][0]["message"]["content"] == "hi"
    assert route.call_count == 3
    assert slept.await_count == 2  # backoff between attempts, no busy-loop


@respx.mock
async def test_persistent_500_raises_after_retry_budget(provider):
    """Always-500 must still surface, not loop forever: 1 try + 2 retries."""
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(
        return_value=httpx.Response(500, text="harmony boom")
    )
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()):
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await provider.chat(
                messages=[ChatMessage(role="user", content="hi")],
                model="gpt-oss:20b",
                tools=[_tool()],
            )
    assert exc_info.value.response.status_code == 500
    assert route.call_count == 3


@respx.mock
async def test_500_without_tools_raises_immediately(provider):
    """No tools → no harmony tool-call path → treat 500 as a real error."""
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(
        return_value=httpx.Response(500, text="genuine server error")
    )
    with pytest.raises(httpx.HTTPStatusError):
        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
        )
    assert route.call_count == 1


@respx.mock
async def test_503_path_is_unchanged_by_the_retry(provider):
    """Appliance overload keeps its own semantics: no 500-retry, bubbles up."""
    _stub_limits(provider)
    provider._limits._refresh_min_interval = 0.0
    respx.get("http://test-ollama:8002/health").mock(
        return_value=httpx.Response(200, json={"limits": {"num_parallel": 1}})
    )
    route = respx.post(TEST_CHAT_URL).mock(
        return_value=httpx.Response(503, headers={"Retry-After": "30"}, text="full")
    )
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            tools=[_tool()],
        )
    assert exc_info.value.response.status_code == 503
    assert route.call_count == 1


# ---------------------------------------------------------------------------
# WARP-1606 — the same retry on the STREAMING path, and its hard boundary
# ---------------------------------------------------------------------------

# Two content deltas + the terminal [DONE], as the provider yields them.
_SSE_BODY = (
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
    "data: [DONE]\n\n"
)
_SSE_FRAMES = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
]


async def _stream_chat(provider: OllamaLocalProvider, tools: bool = True):
    return await provider.chat(
        messages=[ChatMessage(role="user", content="hi")],
        model="gpt-oss:20b",
        stream=True,
        **({"tools": [_tool()]} if tools else {}),
    )


@respx.mock
async def test_streaming_transient_500_with_tools_is_retried(provider):
    """500, 500, 200 → the caller sees ONE clean stream; three POSTs on the wire."""
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(
        side_effect=[httpx.Response(500, text="harmony boom"),
                     httpx.Response(500, text="harmony boom"),
                     httpx.Response(200, text=_SSE_BODY)]
    )
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()) as slept:
        gen = await _stream_chat(provider)
        frames = [f async for f in gen]

    # The retried attempts contributed nothing: exactly one copy of each delta.
    assert frames == _SSE_FRAMES
    assert route.call_count == 3
    assert slept.await_count == 2  # backoff between attempts, no busy-loop
    # The semaphore slot is released after every attempt, not leaked per retry.
    assert provider._sema._value == 1


@respx.mock
async def test_streaming_persistent_500_raises_after_retry_budget(provider):
    """Always-500 must still surface, not loop forever: 1 try + 2 retries."""
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(
        return_value=httpx.Response(500, text="harmony boom")
    )
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()):
        gen = await _stream_chat(provider)
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            async for _ in gen:
                pass
    assert exc_info.value.response.status_code == 500
    assert route.call_count == 3


@respx.mock
async def test_streaming_500_without_tools_raises_immediately(provider):
    """No tools → no harmony tool-call path → treat 500 as a real error."""
    _stub_limits(provider)
    route = respx.post(TEST_CHAT_URL).mock(
        return_value=httpx.Response(500, text="genuine server error")
    )
    gen = await _stream_chat(provider, tools=False)
    with pytest.raises(httpx.HTTPStatusError):
        async for _ in gen:
            pass
    assert route.call_count == 1


@respx.mock
async def test_streaming_midstream_failure_is_never_retried(provider):
    """THE boundary: once a delta is out, a failure must NOT replay the request.

    The first attempt returns 200 and yields one frame, then the body dies.
    Retrying here would hand the caller "Hel" twice, so the error surfaces
    instead — one POST on the wire, one copy of the delta, no [DONE].
    """
    _stub_limits(provider)

    async def _dies_after_first_frame():
        yield b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
        raise httpx.RemoteProtocolError("peer closed the connection mid-stream")

    route = respx.post(TEST_CHAT_URL).mock(
        side_effect=lambda request: httpx.Response(
            200, content=_dies_after_first_frame()
        )
    )

    frames: list[str] = []
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()) as slept:
        gen = await _stream_chat(provider)
        with pytest.raises(httpx.RemoteProtocolError):
            async for frame in gen:
                frames.append(frame)

    assert frames == [_SSE_FRAMES[0]]  # emitted once, never duplicated
    assert route.call_count == 1  # no replay of an already-started stream
    assert slept.await_count == 0  # and no backoff was even scheduled


@respx.mock
async def test_streaming_503_is_not_swallowed_by_the_500_retry(provider):
    """Appliance overload keeps its own semantics on the streaming path too."""
    _stub_limits(provider)
    provider._limits._refresh_min_interval = 0.0
    respx.get("http://test-ollama:8002/health").mock(
        return_value=httpx.Response(200, json={"limits": {"num_parallel": 1}})
    )
    route = respx.post(TEST_CHAT_URL).mock(
        return_value=httpx.Response(503, headers={"Retry-After": "30"}, text="full")
    )
    gen = await _stream_chat(provider)
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        async for _ in gen:
            pass
    assert exc_info.value.response.status_code == 503
    assert route.call_count == 1
