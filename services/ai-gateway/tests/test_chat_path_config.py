"""Configurable OpenAI-compat chat path (WARP-1744).

`_CHAT_PATH` used to be the hardcoded literal `/v1/chat/completions`. It is now
read from OLLAMA_CHAT_PATH so an alternative local runtime can be pointed at
its own prefix — Docker Model Runner serves the identical OpenAI surface at
`POST /engines/v1/chat/completions` (docker/model-runner v1.2.6) — without any
change to the request or response shape.

The whole point of these tests is the DARK half: with OLLAMA_CHAT_PATH unset,
every request must go exactly where it went before.
"""

from __future__ import annotations

import asyncio
import json
import os
import time

import httpx
import pytest
import respx

import providers.ollama_local as ollama_local
from providers.ollama_local import (
    _CHAT_PATH,
    _DEFAULT_CHAT_PATH,
    OllamaLocalProvider,
    _resolve_chat_path,
)
from schemas import ChatMessage

BASE = "http://path-ollama:11434"

# The literal this provider posted to before WARP-1744. Spelled out here
# rather than imported so a change to the constant fails this test instead of
# silently agreeing with itself.
HISTORICAL_CHAT_PATH = "/v1/chat/completions"

# DMR's equivalent, verified against docker/model-runner v1.2.6
# (`/engines/v1/chat/completions`, alongside `/engines/v1/completions`,
# `/engines/v1/embeddings` and `GET /engines/v1/models`).
DMR_CHAT_PATH = "/engines/v1/chat/completions"


@pytest.fixture
async def provider():
    p = OllamaLocalProvider(base_url=BASE)
    p._limits.num_parallel = 1
    p._limits._last_refresh = time.monotonic()
    p._sema = asyncio.Semaphore(1)
    p._sema_size = 1
    yield p
    await p.close()


def _chat_response(model: str = "gpt-oss:20b") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "cmpl-1",
            "object": "chat.completion",
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop",
                }
            ],
        },
    )


# ---------------------------------------------------------------------------
# Default — must be byte-identical to pre-WARP-1744
# ---------------------------------------------------------------------------


class TestChatPathDefault:
    """No config → the exact path this provider has always used."""

    def test_env_is_unset_in_this_suite(self):
        # Makes the assertions below honest: they pin the DEFAULT, so the env
        # var must genuinely be absent (conftest.py never sets it).
        assert os.environ.get("OLLAMA_CHAT_PATH") is None

    def test_module_constant_is_the_historical_literal(self):
        assert _CHAT_PATH == HISTORICAL_CHAT_PATH
        assert _DEFAULT_CHAT_PATH == HISTORICAL_CHAT_PATH

    @pytest.mark.parametrize("raw", [None, "", "   "])
    def test_unset_or_empty_falls_back_to_the_default(self, raw):
        # Compose passes optional settings through as `${VAR:-}`, which
        # delivers "" rather than "unset" — an empty value must not retarget
        # chat at the daemon root.
        assert _resolve_chat_path(raw) == HISTORICAL_CHAT_PATH

    @respx.mock
    async def test_chat_posts_to_the_default_path(self, provider):
        route = respx.post(f"{BASE}{HISTORICAL_CHAT_PATH}").mock(
            return_value=_chat_response()
        )

        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")], model="gpt-oss:20b"
        )

        assert route.call_count == 1

    @respx.mock
    async def test_streaming_chat_posts_to_the_default_path(self, provider):
        route = respx.post(f"{BASE}{HISTORICAL_CHAT_PATH}").mock(
            return_value=httpx.Response(
                200,
                text='data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
            )
        )

        gen = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            stream=True,
        )
        frames = [f async for f in gen]

        assert route.call_count == 1
        assert frames[-1].startswith("data: [DONE]")

    @respx.mock
    async def test_request_body_is_unchanged_by_the_refactor(self, provider):
        # The path moved behind a constant; the BODY contract did not.
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content)
            return _chat_response()

        respx.post(f"{BASE}{HISTORICAL_CHAT_PATH}").mock(side_effect=handler)

        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")], model="gpt-oss:20b"
        )

        assert captured["body"] == {
            "model": "gpt-oss:20b",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
        }


# ---------------------------------------------------------------------------
# Override — opt-in only
# ---------------------------------------------------------------------------


class TestChatPathOverride:
    """An explicit value is honored verbatim, on both chat branches."""

    def test_explicit_value_is_used_as_given(self):
        assert _resolve_chat_path(DMR_CHAT_PATH) == DMR_CHAT_PATH

    def test_surrounding_whitespace_is_trimmed(self):
        assert _resolve_chat_path(f"  {DMR_CHAT_PATH}  ") == DMR_CHAT_PATH

    @respx.mock
    async def test_override_retargets_the_blocking_chat_post(
        self, provider, monkeypatch
    ):
        monkeypatch.setattr(ollama_local, "_CHAT_PATH", DMR_CHAT_PATH)
        default_route = respx.post(f"{BASE}{HISTORICAL_CHAT_PATH}").mock(
            return_value=_chat_response()
        )
        dmr_route = respx.post(f"{BASE}{DMR_CHAT_PATH}").mock(
            return_value=_chat_response()
        )

        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")], model="gpt-oss:20b"
        )

        assert dmr_route.call_count == 1
        assert default_route.call_count == 0

    @respx.mock
    async def test_override_retargets_the_streaming_chat_post(
        self, provider, monkeypatch
    ):
        monkeypatch.setattr(ollama_local, "_CHAT_PATH", DMR_CHAT_PATH)
        dmr_route = respx.post(f"{BASE}{DMR_CHAT_PATH}").mock(
            return_value=httpx.Response(200, text="data: [DONE]\n\n")
        )

        gen = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            stream=True,
        )
        _ = [f async for f in gen]

        assert dmr_route.call_count == 1

    @respx.mock
    async def test_override_composes_with_a_proxy_base_url(self, monkeypatch):
        # The path is resolved RELATIVE to OLLAMA_URL, exactly as the
        # hardcoded literal was — so the opt-in `/proxy` base still nests.
        monkeypatch.setattr(ollama_local, "_CHAT_PATH", DMR_CHAT_PATH)
        p = OllamaLocalProvider(base_url="http://manager:8002/proxy")
        p._limits._last_refresh = time.monotonic()
        p._sema = asyncio.Semaphore(1)
        p._sema_size = 1
        route = respx.post(
            f"http://manager:8002/proxy{DMR_CHAT_PATH}"
        ).mock(return_value=_chat_response())
        try:
            await p.chat(
                messages=[ChatMessage(role="user", content="hi")], model="gpt-oss:20b"
            )
        finally:
            await p.close()

        assert route.call_count == 1
