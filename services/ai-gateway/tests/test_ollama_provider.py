"""Tests for the Ollama provider helpers and resilience plumbing."""

from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest
import respx

from providers.ollama_local import OllamaLocalProvider, _LimitsCache, prettify_ollama_name
from schemas import ChatMessage, ToolDefinition, ToolFunction


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("llama3.1:8b", "Llama 3.1 8B"),
        ("llama3.2:3b", "Llama 3.2 3B"),
        ("qwen2.5:3b-instruct", "Qwen 2.5 3B Instruct"),
        ("mistral:7b", "Mistral 7B"),
        ("phi3.5:3.8b", "Phi 3.5 3.8B"),
        ("gemma2:9b-instruct-q4_0", "Gemma 2 9B Instruct Q4_0"),
        # No tag: just title-case the base.
        ("llama3", "Llama 3"),
        # Already pretty / oddly-shaped inputs: don't over-mangle.
        ("codellama:latest", "Codellama LATEST"),
    ],
)
def test_prettify_ollama_name(raw: str, expected: str) -> None:
    assert prettify_ollama_name(raw) == expected


# ---------------------------------------------------------------------------
# Test fixtures and constants
# ---------------------------------------------------------------------------

# Use a base_url that is NOT the conftest's JETSON_OLLAMA_URL — the provider
# under test takes an explicit override, and we want a /proxy suffix here so
# the health_url derivation is exercised.
TEST_BASE_URL = "http://test-jetson:8002/proxy"
TEST_HEALTH_URL = "http://test-jetson:8002/health"
TEST_CHAT_URL = "http://test-jetson:8002/proxy/v1/chat/completions"


def _limits_payload(
    num_parallel: int = 1, max_queue: int = 16, max_loaded_models: int = 1
) -> dict:
    return {
        "limits": {
            "num_parallel": num_parallel,
            "max_queue": max_queue,
            "max_loaded_models": max_loaded_models,
        }
    }


@pytest.fixture
async def provider():
    """Provider with a closed httpx client at end-of-test."""
    p = OllamaLocalProvider(base_url=TEST_BASE_URL)
    yield p
    await p.close()


# ---------------------------------------------------------------------------
# _LimitsCache
# ---------------------------------------------------------------------------


class TestLimitsCache:
    """Unit tests for the appliance-limits cache."""

    def test_health_url_strips_proxy_suffix(self):
        cache = _LimitsCache("http://jetson:8002/proxy")
        assert cache.health_url == "http://jetson:8002/health"

    def test_health_url_no_proxy_suffix_left_alone(self):
        # removesuffix is a no-op when the suffix isn't present.
        cache = _LimitsCache("http://jetson:8002")
        assert cache.health_url == "http://jetson:8002/health"

    def test_initial_defaults(self):
        cache = _LimitsCache(TEST_BASE_URL)
        assert cache.num_parallel == 1
        assert cache.max_queue == 16
        assert cache.max_loaded_models == 1
        assert cache._last_refresh == 0.0

    @respx.mock
    async def test_refresh_success_parses_limits(self):
        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(
                200, json=_limits_payload(num_parallel=4, max_queue=32, max_loaded_models=2)
            )
        )
        cache = _LimitsCache(TEST_BASE_URL)
        async with httpx.AsyncClient() as client:
            await cache.refresh(client)

        assert cache.num_parallel == 4
        assert cache.max_queue == 32
        assert cache.max_loaded_models == 2
        assert cache._last_refresh > 0

    @respx.mock
    async def test_refresh_swallows_network_error(self):
        respx.get(TEST_HEALTH_URL).mock(side_effect=httpx.ConnectError("boom"))
        cache = _LimitsCache(TEST_BASE_URL)
        async with httpx.AsyncClient() as client:
            # Must not raise — refresh is best-effort.
            await cache.refresh(client)

        # Defaults preserved on failure.
        assert cache.num_parallel == 1
        assert cache.max_queue == 16
        assert cache.max_loaded_models == 1

    @respx.mock
    async def test_refresh_swallows_non_200(self):
        respx.get(TEST_HEALTH_URL).mock(return_value=httpx.Response(503, text="overload"))
        cache = _LimitsCache(TEST_BASE_URL)
        async with httpx.AsyncClient() as client:
            await cache.refresh(client)

        # Non-200 leaves defaults in place; no exception bubbles up.
        assert cache.num_parallel == 1

    @respx.mock
    async def test_refresh_debounces_within_window(self):
        route = respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=2))
        )
        cache = _LimitsCache(TEST_BASE_URL)
        async with httpx.AsyncClient() as client:
            await cache.refresh(client)
            await cache.refresh(client)
            await cache.refresh(client)

        # Only the first call hits the network; the next two are debounced.
        assert route.call_count == 1
        assert cache.num_parallel == 2

    @respx.mock
    async def test_refresh_after_debounce_window(self):
        route = respx.get(TEST_HEALTH_URL).mock(
            side_effect=[
                httpx.Response(200, json=_limits_payload(num_parallel=2)),
                httpx.Response(200, json=_limits_payload(num_parallel=4)),
            ]
        )
        cache = _LimitsCache(TEST_BASE_URL)
        # Drop the debounce window so the second refresh is allowed through.
        cache._refresh_min_interval = 0.0
        async with httpx.AsyncClient() as client:
            await cache.refresh(client)
            await cache.refresh(client)

        assert route.call_count == 2
        assert cache.num_parallel == 4


# ---------------------------------------------------------------------------
# _ensure_limits
# ---------------------------------------------------------------------------


class TestEnsureLimits:
    """Lazy first-call refresh + semaphore creation."""

    @respx.mock
    async def test_first_call_refreshes_and_creates_semaphore(self, provider):
        route = respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=3))
        )

        assert provider._sema is None
        await provider._ensure_limits()

        assert route.called
        assert provider._sema is not None
        assert provider._limits.num_parallel == 3

    @respx.mock
    async def test_subsequent_calls_skip_refresh(self, provider):
        route = respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=2))
        )

        await provider._ensure_limits()
        sema_after_first = provider._sema
        await provider._ensure_limits()
        await provider._ensure_limits()

        # _ensure_limits short-circuits once _last_refresh > 0; the cache's own
        # debounce would also block, but we want to assert the gate at this layer.
        assert route.call_count == 1
        # Semaphore is a singleton across _ensure_limits calls.
        assert provider._sema is sema_after_first

    @respx.mock
    async def test_creates_semaphore_even_if_health_failed(self, provider):
        # /health unreachable — refresh swallows the error and num_parallel stays 1.
        respx.get(TEST_HEALTH_URL).mock(side_effect=httpx.ConnectError("boom"))

        await provider._ensure_limits()

        # Semaphore must still be created so chat() can proceed.
        assert provider._sema is not None
        assert provider._limits.num_parallel == 1


# ---------------------------------------------------------------------------
# chat() — 503 path and temperature defaulting
# ---------------------------------------------------------------------------


class TestProvider503Path:
    """Non-streaming 503 path: refresh, resize semaphore, raise."""

    @respx.mock
    async def test_503_raises_http_status_error(self, provider):
        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=2))
        )
        respx.post(TEST_CHAT_URL).mock(
            return_value=httpx.Response(
                503, headers={"Retry-After": "30"}, text="overload"
            )
        )

        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await provider.chat(
                messages=[ChatMessage(role="user", content="hi")],
                model="llama3.2:3b",
            )
        assert exc_info.value.response.status_code == 503

    @respx.mock
    async def test_503_resizes_semaphore_when_num_parallel_changes(self, provider):
        # Pre-stage state so _ensure_limits short-circuits and we control
        # exactly what the on-503 refresh sees.
        provider._limits.num_parallel = 2
        provider._limits._last_refresh = time.monotonic()
        # Allow the on-503 refresh to bypass the debounce window.
        provider._limits._refresh_min_interval = 0.0
        provider._sema = asyncio.Semaphore(2)
        # Track size on the wrapper so post-refactor logic can read it without
        # touching the private CPython _value attribute.
        provider._sema_size = 2
        sema_before = provider._sema

        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=4))
        )
        respx.post(TEST_CHAT_URL).mock(
            return_value=httpx.Response(503, headers={"Retry-After": "30"}, text="overload")
        )

        with pytest.raises(httpx.HTTPStatusError):
            await provider.chat(
                messages=[ChatMessage(role="user", content="hi")],
                model="llama3.2:3b",
            )

        assert provider._limits.num_parallel == 4
        # The semaphore was rebuilt: the object identity changed.
        assert provider._sema is not sema_before
        assert provider._sema_size == 4

    @respx.mock
    async def test_503_no_resize_when_num_parallel_unchanged(self, provider):
        provider._limits.num_parallel = 2
        provider._limits._last_refresh = time.monotonic()
        provider._limits._refresh_min_interval = 0.0
        provider._sema = asyncio.Semaphore(2)
        provider._sema_size = 2
        sema_before = provider._sema

        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=2))
        )
        respx.post(TEST_CHAT_URL).mock(
            return_value=httpx.Response(503, text="overload")
        )

        with pytest.raises(httpx.HTTPStatusError):
            await provider.chat(
                messages=[ChatMessage(role="user", content="hi")],
                model="llama3.2:3b",
            )

        # Semaphore object reused since size didn't change.
        assert provider._sema is sema_before
        assert provider._sema_size == 2


class TestTemperatureDefault:
    """`temperature=0.0` default when tools are present, caller-provided wins."""

    @staticmethod
    def _capture_post():
        """Returns (route_handler, captured_dict). Mounted via respx side_effect."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": "cmpl-1",
                    "object": "chat.completion",
                    "model": "llama3.2:3b",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "ok"},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )

        return handler, captured

    @staticmethod
    def _stub_limits(provider: OllamaLocalProvider) -> None:
        provider._limits.num_parallel = 1
        provider._limits._last_refresh = time.monotonic()
        provider._sema = asyncio.Semaphore(1)
        provider._sema_size = 1

    @respx.mock
    async def test_temperature_defaults_to_zero_with_tools(self, provider):
        self._stub_limits(provider)
        handler, captured = self._capture_post()
        respx.post(TEST_CHAT_URL).mock(side_effect=handler)

        tool = ToolDefinition(function=ToolFunction(name="get_x", description="x"))
        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="llama3.2:3b",
            tools=[tool],
        )

        assert captured["body"]["temperature"] == 0.0

    @respx.mock
    async def test_caller_temperature_overrides_default_with_tools(self, provider):
        self._stub_limits(provider)
        handler, captured = self._capture_post()
        respx.post(TEST_CHAT_URL).mock(side_effect=handler)

        tool = ToolDefinition(function=ToolFunction(name="get_x", description="x"))
        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="llama3.2:3b",
            tools=[tool],
            temperature=0.7,
        )

        assert captured["body"]["temperature"] == 0.7

    @respx.mock
    async def test_no_temperature_set_without_tools_when_caller_omits(self, provider):
        self._stub_limits(provider)
        handler, captured = self._capture_post()
        respx.post(TEST_CHAT_URL).mock(side_effect=handler)

        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="llama3.2:3b",
        )

        # The provider must not invent a temperature when the caller didn't
        # ask for one and there are no tools — that's the upstream's default.
        assert "temperature" not in captured["body"]
        assert "tools" not in captured["body"]


# ---------------------------------------------------------------------------
# Semaphore concurrency guard
# ---------------------------------------------------------------------------


class TestSemaphoreConcurrency:
    """The semaphore must cap concurrent in-flight chats at num_parallel."""

    @respx.mock
    async def test_semaphore_caps_concurrent_chats(self, provider):
        num_parallel = 2
        n_requests = 6

        provider._limits.num_parallel = num_parallel
        provider._limits._last_refresh = time.monotonic()
        provider._sema = asyncio.Semaphore(num_parallel)
        provider._sema_size = num_parallel

        in_flight = 0
        max_in_flight = 0
        lock = asyncio.Lock()

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal in_flight, max_in_flight
            async with lock:
                in_flight += 1
                if in_flight > max_in_flight:
                    max_in_flight = in_flight
            # Yield long enough for sibling tasks to pile up if the gate is broken.
            await asyncio.sleep(0.05)
            async with lock:
                in_flight -= 1
            return httpx.Response(
                200,
                json={
                    "id": "cmpl-1",
                    "object": "chat.completion",
                    "model": "llama3.2:3b",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "ok"},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )

        respx.post(TEST_CHAT_URL).mock(side_effect=handler)

        msgs = [ChatMessage(role="user", content="hi")]
        await asyncio.gather(
            *(provider.chat(messages=msgs, model="llama3.2:3b") for _ in range(n_requests))
        )

        assert max_in_flight == num_parallel, (
            f"semaphore did not cap concurrency: max_in_flight={max_in_flight}, "
            f"expected {num_parallel}"
        )


# ---------------------------------------------------------------------------
# _stream_chat() — 503 path symmetry
# ---------------------------------------------------------------------------


class TestStreamingProvider503Path:
    """Streaming 503 path: must run the SAME refresh-and-resize logic as the
    non-streaming branch (silver-tier review issue I-4).

    Pre-fix, the streaming branch only refreshed limits — never rebuilt the
    semaphore — so a scale-up signaled via 503 was silently dropped.
    """

    @respx.mock
    async def test_streaming_503_raises_http_status_error(self, provider):
        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=2))
        )
        respx.post(TEST_CHAT_URL).mock(
            return_value=httpx.Response(
                503, headers={"Retry-After": "30"}, text="overload"
            )
        )

        gen = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="llama3.2:3b",
            stream=True,
        )
        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            async for _ in gen:
                pass
        assert exc_info.value.response.status_code == 503

    @respx.mock
    async def test_streaming_503_resizes_semaphore_when_num_parallel_changes(
        self, provider
    ):
        # Pre-stage state so _ensure_limits short-circuits and we control
        # exactly what the on-503 refresh sees. Mirrors the non-streaming
        # 503-resize test so the two paths are exercised symmetrically.
        provider._limits.num_parallel = 2
        provider._limits._last_refresh = time.monotonic()
        provider._limits._refresh_min_interval = 0.0
        provider._sema = asyncio.Semaphore(2)
        provider._sema_size = 2
        sema_before = provider._sema

        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=4))
        )
        respx.post(TEST_CHAT_URL).mock(
            return_value=httpx.Response(
                503, headers={"Retry-After": "30"}, text="overload"
            )
        )

        gen = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="llama3.2:3b",
            stream=True,
        )
        with pytest.raises(httpx.HTTPStatusError):
            async for _ in gen:
                pass

        # The on-503 refresh must have run AND rebuilt the semaphore — exactly
        # what the non-streaming branch does. Pre-fix, this assertion failed:
        # the streaming branch only refreshed.
        assert provider._limits.num_parallel == 4
        assert provider._sema is not sema_before
        assert provider._sema_size == 4

    @respx.mock
    async def test_streaming_503_no_resize_when_num_parallel_unchanged(self, provider):
        provider._limits.num_parallel = 2
        provider._limits._last_refresh = time.monotonic()
        provider._limits._refresh_min_interval = 0.0
        provider._sema = asyncio.Semaphore(2)
        provider._sema_size = 2
        sema_before = provider._sema

        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=2))
        )
        respx.post(TEST_CHAT_URL).mock(
            return_value=httpx.Response(503, text="overload")
        )

        gen = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="llama3.2:3b",
            stream=True,
        )
        with pytest.raises(httpx.HTTPStatusError):
            async for _ in gen:
                pass

        # No rebuild needed — the semaphore object is the same instance.
        assert provider._sema is sema_before
        assert provider._sema_size == 2
