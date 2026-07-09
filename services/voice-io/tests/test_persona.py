"""WARP-1119 — voice persona threading (arch brief §14).

The contract these tests pin:

  - `PersonaFetcher.get_block()` GETs the orchestrator's
    `/api/persona/prompt` with the service bearer token and returns the
    composed persona block. Failures NEVER raise — they return None (the
    caller falls back to the built-in greeting prompt) and are visible:
    `fetch_ok` flips False and `last_fetch_at` records the attempt, which
    /health surfaces (a rotated service token shows up in health, not as
    months of undiagnosed drift).
  - The block is fetched per session start — no long-lived cross-session
    cache. A short in-session TTL is allowed (§14) so bursts don't hammer
    the orchestrator; after the TTL the next greeting re-fetches.
  - `OrchestratorLLM` prepends the block ONLY on the greeting path
    (`tool_choice="none"`, where the orchestrator deliberately skips its
    base prompt). Tool-enabled turns already receive the persona inside the
    orchestrator base prompt — prepending there would double-inject, so the
    fetcher must not even be consulted. Exactly ONE persona block per path.
"""
from __future__ import annotations

import json

import httpx

from voice.llm import DEFAULT_LLM_SYSTEM_PROMPT, OrchestratorLLM
from voice.persona import PersonaFetcher, build_persona_fetcher_from_env

PERSONA_BLOCK = (
    "Style preferences (never override safety or honesty rules):\n"
    "Speak like a senior engineer: terse, technically precise."
)


def _install_mock_transport(monkeypatch, handler) -> list:
    """Route module-level httpx.get/httpx.post through a MockTransport
    (same plumbing as test_llm.py — persona.py uses `httpx.get`)."""
    captured: list[httpx.Request] = []

    def _record_and_handle(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_record_and_handle)
    client = httpx.Client(transport=transport)

    def _patched_get(url, **kwargs):
        kwargs.pop("verify", None)
        kwargs.pop("cert", None)
        return client.get(url, **kwargs)

    def _patched_post(url, **kwargs):
        kwargs.pop("verify", None)
        kwargs.pop("cert", None)
        return client.post(url, **kwargs)

    monkeypatch.setattr(httpx, "get", _patched_get)
    monkeypatch.setattr(httpx, "post", _patched_post)
    return captured


class TestPersonaFetcher:
    def test_fetch_ok_returns_block_and_flags_health(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text=PERSONA_BLOCK)

        captured = _install_mock_transport(monkeypatch, handler)
        f = PersonaFetcher("http://orchestrator:3000", bearer_token="tok-123")

        assert f.fetch_ok is None  # never attempted yet
        assert f.get_block() == PERSONA_BLOCK
        assert f.fetch_ok is True
        assert f.last_fetch_at is not None

        req = captured[0]
        assert req.url.path == "/api/persona/prompt"
        assert req.headers["authorization"] == "Bearer tok-123"

    def test_fetch_failure_returns_none_never_raises(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("boom", request=request)

        _install_mock_transport(monkeypatch, handler)
        f = PersonaFetcher("http://orchestrator:3000", bearer_token="tok")

        assert f.get_block() is None
        assert f.fetch_ok is False
        assert f.last_fetch_at is not None

    def test_http_error_returns_none(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"error": "forbidden"})

        _install_mock_transport(monkeypatch, handler)
        f = PersonaFetcher("http://orchestrator:3000", bearer_token="tok")
        assert f.get_block() is None
        assert f.fetch_ok is False

    def test_empty_body_is_treated_as_no_block(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="   ")

        _install_mock_transport(monkeypatch, handler)
        f = PersonaFetcher("http://orchestrator:3000", bearer_token="tok")
        assert f.get_block() is None
        assert f.fetch_ok is True  # the orchestrator answered fine

    def test_short_ttl_caches_within_and_refetches_after(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text=PERSONA_BLOCK)

        captured = _install_mock_transport(monkeypatch, handler)
        clock = [1000.0]
        f = PersonaFetcher(
            "http://orchestrator:3000",
            bearer_token="tok",
            ttl_s=60.0,
            time_source=lambda: clock[0],
        )

        assert f.get_block() == PERSONA_BLOCK
        clock[0] += 10.0  # inside the TTL — served from the session cache
        assert f.get_block() == PERSONA_BLOCK
        assert len(captured) == 1

        clock[0] += 61.0  # past the TTL — a new session re-fetches
        assert f.get_block() == PERSONA_BLOCK
        assert len(captured) == 2

    def test_failure_is_cached_for_the_ttl_too(self, monkeypatch):
        """A down orchestrator must not add a connect-timeout to EVERY
        greeting — the failed attempt holds for the TTL, then retries."""
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down", request=request)

        captured = _install_mock_transport(monkeypatch, handler)
        clock = [0.0]
        f = PersonaFetcher(
            "http://orchestrator:3000",
            bearer_token="tok",
            ttl_s=60.0,
            time_source=lambda: clock[0],
        )
        assert f.get_block() is None
        clock[0] += 5.0
        assert f.get_block() is None
        assert len(captured) == 1
        clock[0] += 61.0
        assert f.get_block() is None
        assert len(captured) == 2


class TestBuildPersonaFetcherFromEnv:
    def test_builds_from_env(self, monkeypatch):
        monkeypatch.setenv("LLM_URL", "http://orchestrator:3000")
        monkeypatch.setenv("ORCHESTRATOR_TOKEN", "svc-token")
        f = build_persona_fetcher_from_env()
        assert isinstance(f, PersonaFetcher)

    def test_mock_llm_url_builds_no_fetcher(self, monkeypatch):
        monkeypatch.setenv("LLM_URL", "__mock__")
        assert build_persona_fetcher_from_env() is None


class TestGreetingPathInjection:
    """§14/§16 — exactly one persona block per path."""

    def _reply_body(self, captured: list[httpx.Request]) -> dict:
        posts = [r for r in captured if r.method == "POST"]
        assert len(posts) == 1
        return json.loads(posts[0].content.decode("utf-8"))

    def _make_llm(self, monkeypatch, persona_handler=None):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/persona/prompt":
                if persona_handler is not None:
                    return persona_handler(request)
                return httpx.Response(200, text=PERSONA_BLOCK)
            return httpx.Response(
                200,
                json={"message": {"role": "assistant", "content": "hi"}},
            )

        captured = _install_mock_transport(monkeypatch, handler)
        fetcher = PersonaFetcher("http://orchestrator:3000", bearer_token="tok")
        llm = OrchestratorLLM(
            base_url="http://orchestrator:3000",
            bearer_token="tok",
            persona_fetcher=fetcher,
        )
        return llm, captured

    def test_greeting_turn_prepends_exactly_one_persona_block(self, monkeypatch):
        llm, captured = self._make_llm(monkeypatch)
        assert llm.reply("good morning", tool_choice="none") == "hi"

        body = self._reply_body(captured)
        system_msg = body["messages"][0]["content"]
        # The block leads, the built-in greeting persona follows — one copy.
        assert system_msg.startswith(PERSONA_BLOCK)
        assert system_msg.count(PERSONA_BLOCK) == 1
        assert DEFAULT_LLM_SYSTEM_PROMPT in system_msg

    def test_tool_enabled_turn_never_carries_the_block(self, monkeypatch):
        """The orchestrator base prompt owns the persona on tool-enabled
        turns (§14) — prepending here would double-inject. The fetcher must
        not even be consulted (no persona GET rides a tool turn)."""
        llm, captured = self._make_llm(monkeypatch)
        assert llm.reply("list the cameras", tool_choice=None) == "hi"

        body = self._reply_body(captured)
        system_msg = body["messages"][0]["content"]
        assert PERSONA_BLOCK not in system_msg
        assert not any(
            r.url.path == "/api/persona/prompt" for r in captured
        )

    def test_greeting_turn_falls_back_when_fetch_fails(self, monkeypatch):
        def persona_handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("orchestrator restarting", request=request)

        llm, captured = self._make_llm(monkeypatch, persona_handler=persona_handler)
        # Voice must never break because the orchestrator is restarting.
        assert llm.reply("good morning", tool_choice="none") == "hi"

        body = self._reply_body(captured)
        system_msg = body["messages"][0]["content"]
        assert PERSONA_BLOCK not in system_msg
        assert DEFAULT_LLM_SYSTEM_PROMPT in system_msg

    def test_no_fetcher_configured_behaves_as_before(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"message": {"role": "assistant", "content": "hi"}}
            )

        captured = _install_mock_transport(monkeypatch, handler)
        llm = OrchestratorLLM(base_url="http://orchestrator:3000", bearer_token="tok")
        assert llm.reply("good morning", tool_choice="none") == "hi"
        body = self._reply_body(captured)
        assert PERSONA_BLOCK not in body["messages"][0]["content"]
