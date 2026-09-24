"""WARP-3047 — a model that can't be LOADED is not the harmony flake.

Docker Model Runner v1.2.6 has no memory-aware eviction: asking for model B
while A is resident starts a second llama-server with ``-ngl 999``, and a B
that doesn't fit in what A left free fails at runner init. DMR answers that
with a 500 whose text/plain body starts ``unable to load runner:``
(scheduling/http_handler.go) and, for a CUDA OOM, carries llama.cpp's own
``not enough GPU memory to load the model (CUDA)`` (backends/llamacpp/errors.go).

Before this ticket the gateway treated that 500 like the WARP-1333 harmony
flake — retried the identical load up to twice more, each doomed — and then
surfaced a generic 502 "Upstream provider error". Policy under test:

  - classify the load failure; never spend the harmony budget on it;
  - ask the inference-manager (lifecycle owner) to unload every idle model
    other than the requested one, and retry ONCE when it freed something;
  - otherwise raise ``ModelLoadFailedError``, which ``/ai/chat`` maps to a
    typed ``503 {error: "model_load_failed", detail}`` with honest copy.
"""

from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

import providers.ollama_local as ollama_local
from providers.ollama_local import (
    ModelLoadFailedError,
    OllamaLocalProvider,
    _is_model_load_failure,
    _LimitsCache,
)
from schemas import ChatMessage, ToolDefinition, ToolFunction

TEST_BASE_URL = "http://test-dmr:12434/engines"
TEST_CHAT_URL = "http://test-dmr:12434/engines/v1/chat/completions"
MANAGER = "http://inference-manager:8002"
UNLOAD_URL = f"{MANAGER}/models/unload"

A = "docker.io/ai/gpt-oss:20B-F16"
B = "docker.io/ai/qwen3:8B-Q4_K_M"

_OOM_BODY = (
    "unable to load runner: error waiting for runner to be ready: "
    "not enough GPU memory to load the model (CUDA)\n\nVerbose output:\n..."
)
_OK = httpx.Response(
    200, json={"choices": [{"message": {"role": "assistant", "content": "hi"}}]}
)

pytestmark = pytest.mark.anyio


@pytest.fixture
async def provider(monkeypatch):
    monkeypatch.setattr(ollama_local, "INFERENCE_MANAGER_URL", MANAGER)
    monkeypatch.setenv("INFERENCE_AUTH_TOKEN", "im-token")
    p = OllamaLocalProvider(base_url=TEST_BASE_URL)
    p._limits.num_parallel = 1
    p._limits._last_refresh = time.monotonic()
    p._sema = asyncio.Semaphore(1)
    p._sema_size = 1
    yield p
    await p.close()


def _tool() -> ToolDefinition:
    return ToolDefinition(function=ToolFunction(name="get_x", description="x"))


async def _chat(provider, *, stream: bool = False, tools: bool = True):
    kwargs = {"tools": [_tool()]} if tools else {}
    return await provider.chat(
        messages=[ChatMessage(role="user", content="hi")], model=B, stream=stream, **kwargs,
    )


# ── classification ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (500, _OOM_BODY, True),
        (500, "unable to load runner: model file is corrupt", True),
        (500, "llama.cpp: not enough GPU memory to load the model (CUDA)", True),
        (500, "no reverse mapping found for function name", False),  # the harmony flake
        (500, "", False),
        (503, _OOM_BODY, False),  # overload keeps its own path
    ],
)
def test_classifies_dmr_load_failures(status, body, expected):
    assert _is_model_load_failure(status, body) is expected


# ── blocking ────────────────────────────────────────────────────────────


@respx.mock
async def test_load_failure_evicts_idle_models_and_retries_once(provider):
    chat = respx.post(TEST_CHAT_URL).mock(side_effect=[httpx.Response(500, text=_OOM_BODY), _OK])
    unload = respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [A], "still_resident": []})
    )
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()) as slept:
        result = await _chat(provider)

    assert result["choices"][0]["message"]["content"] == "hi"
    assert chat.call_count == 2
    # Never the harmony backoff: this was a load failure, not the flake.
    assert slept.await_count == 0
    sent = unload.calls[0].request
    assert json.loads(sent.content) == {"keep": B}
    assert sent.headers["authorization"] == "Bearer im-token"


@respx.mock
async def test_still_failing_after_eviction_is_a_typed_error_not_a_loop(provider):
    chat = respx.post(TEST_CHAT_URL).mock(return_value=httpx.Response(500, text=_OOM_BODY))
    unload = respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [A], "still_resident": []})
    )
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()):
        with pytest.raises(ModelLoadFailedError) as exc_info:
            await _chat(provider)

    assert chat.call_count == 2  # the request + ONE retry
    assert unload.call_count == 1
    assert "doesn't fit in this Droplet's GPU memory" in exc_info.value.detail


@respx.mock
async def test_nothing_idle_to_evict_fails_fast_and_names_the_resident_model(provider):
    chat = respx.post(TEST_CHAT_URL).mock(return_value=httpx.Response(500, text=_OOM_BODY))
    respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [], "still_resident": [A]})
    )
    with pytest.raises(ModelLoadFailedError) as exc_info:
        await _chat(provider)

    # A retry could only fail the same way: A is still busy, nothing was freed.
    assert chat.call_count == 1
    detail = exc_info.value.detail
    # Display names, never raw registry refs (the GW-08 no-leak rule).
    assert detail.startswith("Qwen 3 8B")
    assert "next to Gpt-oss 20B F16" in detail
    assert "docker.io" not in detail


@respx.mock
async def test_unreachable_manager_fails_fast_without_retrying(provider):
    chat = respx.post(TEST_CHAT_URL).mock(return_value=httpx.Response(500, text=_OOM_BODY))
    respx.post(UNLOAD_URL).mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(ModelLoadFailedError) as exc_info:
        await _chat(provider)
    assert chat.call_count == 1
    assert "GPU memory" in exc_info.value.detail


@respx.mock
async def test_no_manager_configured_fails_fast(provider, monkeypatch):
    monkeypatch.setattr(ollama_local, "INFERENCE_MANAGER_URL", None)
    chat = respx.post(TEST_CHAT_URL).mock(return_value=httpx.Response(500, text=_OOM_BODY))
    with pytest.raises(ModelLoadFailedError):
        await _chat(provider)
    assert chat.call_count == 1


@respx.mock
async def test_a_non_memory_load_failure_is_not_described_as_memory(provider):
    respx.post(TEST_CHAT_URL).mock(
        return_value=httpx.Response(500, text="unable to load runner: model file is corrupt")
    )
    respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [], "still_resident": []})
    )
    with pytest.raises(ModelLoadFailedError) as exc_info:
        await _chat(provider, tools=False)
    assert "GPU memory" not in exc_info.value.detail
    assert "couldn't be loaded" in exc_info.value.detail


@respx.mock
async def test_the_harmony_flake_is_still_retried_as_before(provider):
    chat = respx.post(TEST_CHAT_URL).mock(
        side_effect=[httpx.Response(500, text="harmony boom"), _OK]
    )
    unload = respx.post(UNLOAD_URL)
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()) as slept:
        await _chat(provider)
    assert chat.call_count == 2
    assert slept.await_count == 1
    assert not unload.called


# ── streaming ───────────────────────────────────────────────────────────


@respx.mock
async def test_streaming_load_failure_evicts_and_retries_before_any_frame(provider):
    frames = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    chat = respx.post(TEST_CHAT_URL).mock(
        side_effect=[
            httpx.Response(500, text=_OOM_BODY),
            httpx.Response(200, text=frames, headers={"content-type": "text/event-stream"}),
        ]
    )
    respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [A], "still_resident": []})
    )
    gen = await _chat(provider, stream=True)
    out = [chunk async for chunk in gen]

    assert chat.call_count == 2
    assert out[0].startswith("data: ") and "hi" in out[0]


@respx.mock
async def test_streaming_persistent_load_failure_raises_before_yielding(provider):
    respx.post(TEST_CHAT_URL).mock(return_value=httpx.Response(500, text=_OOM_BODY))
    respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [], "still_resident": [A]})
    )
    gen = await _chat(provider, stream=True)
    with pytest.raises(ModelLoadFailedError):
        async for _ in gen:
            pytest.fail("nothing may be yielded for a model that never loaded")


# ── /health schema v3 ───────────────────────────────────────────────────


@respx.mock
async def test_limits_keep_their_default_when_dmr_omits_max_loaded_models(caplog):
    """inference-manager v3 omits `max_loaded_models` on DMR (no cap to
    report). The cache keeps its default and logs no schema drift."""
    health = f"{MANAGER}/health"
    respx.get(health).mock(
        return_value=httpx.Response(
            200,
            json={"schema_version": 3, "limits": {"num_parallel": 2, "max_queue": 16}},
        )
    )
    cache = _LimitsCache("http://test-dmr:12434")
    cache._manager_health_url = health
    async with httpx.AsyncClient() as client:
        await cache.refresh(client)
    assert cache.num_parallel == 2
    assert cache.max_loaded_models == 1
    assert _LimitsCache._KNOWN_SCHEMA_VERSION == 3
    assert not [r for r in caplog.records if "schema" in r.getMessage().lower() and r.levelname == "WARNING"]


# ── /ai/chat maps it to a typed 503 ─────────────────────────────────────


async def test_ai_chat_answers_a_typed_503_with_honest_copy(client):
    import main
    from router import ProviderRouter
    from scheduler import InferenceScheduler

    if main.provider_router is None:
        main.provider_router = ProviderRouter()
    if main.inference_scheduler is None:
        main.inference_scheduler = InferenceScheduler()
        await main.inference_scheduler.start()
    err = ModelLoadFailedError(B, out_of_memory=True, resident=[A])
    active_before = main.inference_scheduler._active_count
    with patch.object(main.provider_router, "chat", AsyncMock(side_effect=err)):
        resp = await client.post(
            "/ai/chat",
            json={"model": B, "messages": [{"role": "user", "content": "hi"}], "stream": False},
        )
    assert resp.status_code == 503
    body = resp.json()
    assert body["error"] == "model_load_failed"
    assert "doesn't fit in GPU memory next to Gpt-oss 20B F16" in body["detail"]
    # The scheduler slot is released — the next request is admitted.
    assert main.inference_scheduler._active_count == active_before
