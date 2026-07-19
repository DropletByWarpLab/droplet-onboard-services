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
