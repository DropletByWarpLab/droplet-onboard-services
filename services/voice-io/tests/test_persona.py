"""WARP-1119 — voice persona threading (arch brief §14).

The contract these tests pin:

  - `PersonaFetcher` GETs the orchestrator's `/api/persona/prompt` with the
    service bearer token. Failures NEVER raise — the caller falls back to
    the built-in greeting prompt — and are visible: `fetch_ok` flips False
    and `last_fetch_at` records the attempt, which /health surfaces (a
    rotated service token shows up in health, not as months of undiagnosed
    drift).
  - WARP-3124 stale-while-revalidate: `get_block()` NEVER waits on the
    network. It returns the cached block at once and, once the short TTL
    (§14) has passed, starts at most ONE background refresh. The first-ever
    call has nothing cached and returns None (the built-in fallback). A
    failed refresh keeps the last good block; failures still hold for the
    TTL so a down orchestrator is not hammered.
  - `OrchestratorLLM` prepends the block ONLY on the greeting path
    (`tool_choice="none"`, where the orchestrator deliberately skips its
    base prompt). Tool-enabled turns already receive the persona inside the
    orchestrator base prompt — prepending there would double-inject, so the
    fetcher must not even be consulted. Exactly ONE persona block per path.
"""
from __future__ import annotations

import json
import threading
import time

import httpx

import voice.llm
import voice.persona
from voice.llm import DEFAULT_LLM_SYSTEM_PROMPT, OrchestratorLLM
from voice.persona import PersonaFetcher, build_persona_fetcher_from_env

PERSONA_BLOCK = (
    "Style preferences (never override safety or honesty rules):\n"
    "Speak like a senior engineer: terse, technically precise."
)


def _install_mock_transport(monkeypatch, handler) -> list:
    """Route BOTH pooled clients (persona fetch + llm chat/health) through
    one MockTransport (WARP-1433).

    The greeting-path tests drive a PersonaFetcher AND an OrchestratorLLM
    together, and each now owns a reused `httpx.Client` built via its
    module's `_new_httpx_client()` factory. Patching both factories to the
    same transport captures the persona GET and the chat POST in one list —
    the mTLS material rides the pool constructor now, so there are no
    per-request cert/verify kwargs to strip."""
    captured: list[httpx.Request] = []

    def _record_and_handle(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_record_and_handle)

    def _factory() -> httpx.Client:
        return httpx.Client(transport=transport)

    monkeypatch.setattr(voice.persona, "_new_httpx_client", _factory)
    monkeypatch.setattr(voice.llm, "_new_httpx_client", _factory)
    return captured


# Bounded wait for a background refresh in tests — generous so a loaded CI
# box never flakes, but a hang still fails fast instead of wedging pytest.
_REFRESH_WAIT_S = 5.0


def _prime(f: PersonaFetcher) -> None:
    """Kick the first background refresh and wait for it (what main.py's
    build-time prime achieves before the first greeting ever arrives)."""
    f.get_block()
    assert f.wait_for_refresh(_REFRESH_WAIT_S)


class TestPersonaFetcher:
    def test_fetch_ok_caches_block_and_flags_health(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text=PERSONA_BLOCK)

        captured = _install_mock_transport(monkeypatch, handler)
        f = PersonaFetcher("http://orchestrator:3000", bearer_token="tok-123")

        assert f.fetch_ok is None  # never attempted yet
        # First-ever call: nothing cached yet → the built-in fallback (None),
        # while the fetch runs in the background.
        assert f.get_block() is None
        assert f.wait_for_refresh(_REFRESH_WAIT_S)
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

        _prime(f)
        assert f.get_block() is None
        assert f.fetch_ok is False
        assert f.last_fetch_at is not None

    def test_http_error_returns_none(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={"error": "forbidden"})

        _install_mock_transport(monkeypatch, handler)
        f = PersonaFetcher("http://orchestrator:3000", bearer_token="tok")
        _prime(f)
        assert f.get_block() is None
        assert f.fetch_ok is False

    def test_empty_body_is_treated_as_no_block(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="   ")

        _install_mock_transport(monkeypatch, handler)
        f = PersonaFetcher("http://orchestrator:3000", bearer_token="tok")
        _prime(f)
        assert f.get_block() is None
        assert f.fetch_ok is True  # the orchestrator answered fine

    def test_ttl_serves_cache_within_and_revalidates_in_background_after(
        self, monkeypatch,
    ):
        bodies = iter([PERSONA_BLOCK, "Updated persona block."])

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text=next(bodies))

        captured = _install_mock_transport(monkeypatch, handler)
        clock = [1000.0]
        f = PersonaFetcher(
            "http://orchestrator:3000",
            bearer_token="tok",
            ttl_s=60.0,
            time_source=lambda: clock[0],
        )

        _prime(f)
        assert f.get_block() == PERSONA_BLOCK
        clock[0] += 10.0  # inside the TTL — served from the session cache
        assert f.get_block() == PERSONA_BLOCK
        assert len(captured) == 1

        clock[0] += 61.0  # past the TTL — serve STALE now, refresh behind it
        assert f.get_block() == PERSONA_BLOCK
        assert f.wait_for_refresh(_REFRESH_WAIT_S)
        assert len(captured) == 2
        # The next greeting sees the revalidated block.
        assert f.get_block() == "Updated persona block."

    def test_failure_is_cached_for_the_ttl_too(self, monkeypatch):
        """A down orchestrator must not be hit on EVERY greeting — the
        failed attempt holds for the TTL, then retries."""
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
        _prime(f)
        assert f.get_block() is None
        clock[0] += 5.0
        assert f.get_block() is None
        assert f.wait_for_refresh(_REFRESH_WAIT_S)
        assert len(captured) == 1
        clock[0] += 61.0
        assert f.get_block() is None
        assert f.wait_for_refresh(_REFRESH_WAIT_S)
        assert len(captured) == 2

    def test_failed_refresh_keeps_the_last_good_block(self, monkeypatch):
        """A restarting orchestrator must not strip the owner's persona:
        the stale block keeps serving; health still reports the failure."""
        ok = {"flag": True}

        def handler(request: httpx.Request) -> httpx.Response:
            if ok["flag"]:
                return httpx.Response(200, text=PERSONA_BLOCK)
            raise httpx.ConnectError("orchestrator restarting", request=request)

        _install_mock_transport(monkeypatch, handler)
        clock = [0.0]
        f = PersonaFetcher(
            "http://orchestrator:3000",
            bearer_token="tok",
            ttl_s=60.0,
            time_source=lambda: clock[0],
        )
        _prime(f)
        assert f.get_block() == PERSONA_BLOCK

        ok["flag"] = False
        clock[0] += 61.0
        assert f.get_block() == PERSONA_BLOCK  # stale, refresh started
        assert f.wait_for_refresh(_REFRESH_WAIT_S)
        assert f.fetch_ok is False
        assert f.get_block() == PERSONA_BLOCK  # still the last good block

    def test_get_block_never_blocks_on_a_slow_get(self, monkeypatch):
        """The greeting path must never wait on the persona GET — not on the
        first-ever call, and not while a refresh is in flight."""
        release = threading.Event()
        started = threading.Event()

        def handler(request: httpx.Request) -> httpx.Response:
            started.set()
            release.wait(_REFRESH_WAIT_S)  # a GET slower than any budget
            return httpx.Response(200, text=PERSONA_BLOCK)

        captured = _install_mock_transport(monkeypatch, handler)
        f = PersonaFetcher("http://orchestrator:3000", bearer_token="tok")
        try:
            t0 = time.monotonic()
            assert f.get_block() is None
            assert time.monotonic() - t0 < 0.5
            assert started.wait(_REFRESH_WAIT_S)  # the GET really is in flight
            # Single-flight: more greetings during the slow GET start no
            # second request and still return at once.
            t0 = time.monotonic()
            for _ in range(5):
                assert f.get_block() is None
            assert time.monotonic() - t0 < 0.5
            assert len(captured) == 1
        finally:
            release.set()
        assert f.wait_for_refresh(_REFRESH_WAIT_S)
        assert f.get_block() == PERSONA_BLOCK
        f.close()

    def test_close_copes_with_an_in_flight_refresh(self, monkeypatch):
        release = threading.Event()
        started = threading.Event()

        def handler(request: httpx.Request) -> httpx.Response:
            started.set()
            release.wait(_REFRESH_WAIT_S)
            return httpx.Response(200, text=PERSONA_BLOCK)

        captured = _install_mock_transport(monkeypatch, handler)
        clock = [0.0]
        f = PersonaFetcher(
            "http://orchestrator:3000",
            bearer_token="tok",
            ttl_s=60.0,
            time_source=lambda: clock[0],
        )
        f.get_block()
        assert started.wait(_REFRESH_WAIT_S)
        closer = threading.Thread(target=f.close)
        closer.start()
        # close() waits for the refresh in flight instead of closing the
        # pooled client under it.
        closer.join(0.2)
        assert closer.is_alive()
        release.set()
        closer.join(_REFRESH_WAIT_S)
        assert not closer.is_alive()  # close() returned, and did not raise
        assert f.fetch_ok is True     # the GET finished on an open client
        assert f.wait_for_refresh(_REFRESH_WAIT_S)
        # A closed fetcher never starts another refresh, even once stale.
        clock[0] += 61.0
        f.get_block()
        assert f.wait_for_refresh(_REFRESH_WAIT_S)
        assert len(captured) == 1


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
        # WARP-3124 — the build-time prime (main.py) has cached the block
        # before the first greeting; only the turn's own traffic is asserted.
        _prime(fetcher)
        captured.clear()
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
