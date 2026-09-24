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
  - otherwise raise ``ModelLoadFailedError``, which ``/ai/chat`` and the
    session route map to a typed ``503 {error: "model_load_failed", detail}``
    with honest copy — streaming too: the stream is run to its first frame
    before the response starts, so the status is still ours to choose.
"""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
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
    unload = respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [A], "still_resident": []})
    )
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()) as slept:
        gen = await _chat(provider, stream=True)
        out = [chunk async for chunk in gen]

    assert chat.call_count == 2
    assert out[0].startswith("data: ") and "hi" in out[0]
    # The retry was earned by making room — not the harmony backoff.
    assert unload.call_count == 1
    sent = unload.calls[0].request
    assert json.loads(sent.content) == {"keep": B}
    assert sent.headers["authorization"] == "Bearer im-token"
    assert slept.await_count == 0


@respx.mock
async def test_streaming_persistent_load_failure_raises_before_yielding(provider):
    chat = respx.post(TEST_CHAT_URL).mock(return_value=httpx.Response(500, text=_OOM_BODY))
    respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [], "still_resident": [A]})
    )
    gen = await _chat(provider, stream=True)
    with pytest.raises(ModelLoadFailedError) as exc_info:
        async for _ in gen:
            pytest.fail("nothing may be yielded for a model that never loaded")
    # Nothing was freed, so a retry could only fail the same way.
    assert chat.call_count == 1
    assert "next to Gpt-oss 20B F16" in exc_info.value.detail


@respx.mock
async def test_streaming_still_failing_after_eviction_retries_exactly_once(provider):
    chat = respx.post(TEST_CHAT_URL).mock(return_value=httpx.Response(500, text=_OOM_BODY))
    unload = respx.post(UNLOAD_URL).mock(
        return_value=httpx.Response(200, json={"unloaded": [A], "still_resident": []})
    )
    with patch("providers.ollama_local.asyncio.sleep", new=AsyncMock()):
        gen = await _chat(provider, stream=True)
        with pytest.raises(ModelLoadFailedError):
            async for _ in gen:
                pytest.fail("nothing may be yielded for a model that never loaded")
    assert chat.call_count == 2  # the request + ONE retry
    assert unload.call_count == 1


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


# ── /ai/chat and the session route map it to a typed 503 ────────────────


@asynccontextmanager
async def _chat_globals():
    """The module globals the chat routes need, owned by THIS test.

    The ASGI test transport runs no lifespan, so the globals are None unless a
    test sets them. The scheduler's worker is a task on the loop that starts
    it, and that loop closes when the test ends — left installed, the next
    test to use `main.inference_scheduler` enqueues into a dead worker and
    hangs until the pytest timeout. So: a fresh scheduler, stopped and the
    previous globals restored on the way out.

    A context manager entered IN the test body, not an async fixture: this
    module's tests run under anyio, and whether an async fixture runs on the
    test's loop depends on which of pytest-asyncio / anyio registered first
    (CI and a local venv differ). A worker on the fixture's loop never runs
    while the test awaits it.
    """
    import main
    from router import ProviderRouter
    from scheduler import InferenceScheduler

    saved = (main.provider_router, main.inference_scheduler)
    sched = InferenceScheduler()
    await sched.start()
    main.provider_router = saved[0] or ProviderRouter()
    main.inference_scheduler = sched
    try:
        yield main
    finally:
        await sched.stop()
        main.provider_router, main.inference_scheduler = saved


_ERR = ModelLoadFailedError(B, out_of_memory=True, resident=[A])
_HONEST = "doesn't fit in GPU memory next to Gpt-oss 20B F16"


def _chat_body(stream: bool) -> dict:
    return {"model": B, "messages": [{"role": "user", "content": "hi"}], "stream": stream}


async def _never_loads():
    """A provider stream whose model never loaded: DMR's load failure is
    classified before any frame, so the generator raises on first pull."""
    raise _ERR
    yield  # pragma: no cover — makes this an async generator


async def test_ai_chat_answers_a_typed_503_with_honest_copy(client):
    async with _chat_globals() as main:
        with patch.object(main.provider_router, "chat", AsyncMock(side_effect=_ERR)):
            resp = await client.post("/ai/chat", json=_chat_body(stream=False))
        assert resp.status_code == 503
        body = resp.json()
        assert body["error"] == "model_load_failed"
        assert _HONEST in body["detail"]
        # The scheduler slot is released — the next request is admitted.
        assert main.inference_scheduler.active_requests == 0


async def test_ai_chat_stream_answers_the_typed_503_before_any_frame(client):
    """The dashboard chat STREAMS. The load failure is raised inside the
    provider's generator, so it must be pulled before the response starts —
    a 200 that is then cut off can't carry the honest copy."""
    async with _chat_globals() as main:
        with patch.object(main.provider_router, "chat", AsyncMock(return_value=_never_loads())):
            resp = await client.post("/ai/chat", json=_chat_body(stream=True))
        assert resp.status_code == 503
        body = resp.json()
        assert body == {"error": "model_load_failed", "detail": body["detail"]}
        assert _HONEST in body["detail"]
        assert main.inference_scheduler.active_requests == 0


async def test_ai_chat_stream_still_streams_every_frame_and_frees_the_slot(client):
    async with _chat_globals() as main:

        async def frames():
            yield 'data: {"choices":[{"delta":{"content":"he"}}]}\n\n'
            yield 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n'
            yield "data: [DONE]\n\n"

        with patch.object(main.provider_router, "chat", AsyncMock(return_value=frames())):
            resp = await client.post("/ai/chat", json=_chat_body(stream=True))
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.text.index('"he"') < resp.text.index('"llo"') < resp.text.index("[DONE]")
        assert main.inference_scheduler.active_requests == 0


async def test_ai_chat_stream_other_pre_frame_errors_are_the_generic_502(client):
    """Anything else that fails before the first frame gets the blocking
    path's GW-08 answer — a generic 502 with a correlation id, never the
    upstream text — instead of a 200 cut off mid-body."""
    async with _chat_globals() as main:
        secret = "http://test-dmr:12434 sk-LEAKED upstream body"

        async def boom():
            raise RuntimeError(secret)
            yield  # pragma: no cover

        with patch.object(main.provider_router, "chat", AsyncMock(return_value=boom())):
            resp = await client.post("/ai/chat", json=_chat_body(stream=True))
        assert resp.status_code == 502
        assert "sk-LEAKED" not in resp.text
        assert "Upstream provider error" in resp.json()["detail"]
        assert main.inference_scheduler.active_requests == 0


async def test_session_chat_stream_answers_the_typed_503(client_with_sessions):
    import main

    created = await client_with_sessions.post("/ai/sessions", json={"model": B})
    session_id = created.json()["id"]
    with patch.object(main.provider_router, "chat", AsyncMock(return_value=_never_loads())):
        resp = await client_with_sessions.post(
            f"/ai/sessions/{session_id}/chat", json={"message": "hi", "stream": True}
        )
    assert resp.status_code == 503
    assert resp.json()["error"] == "model_load_failed"
    assert _HONEST in resp.json()["detail"]
