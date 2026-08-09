"""Tests for the Ollama provider helpers and resilience plumbing."""

from __future__ import annotations

import asyncio
import json
import logging
import time

import httpx
import pytest
import respx

from providers.ollama_local import (
    _LEGACY_MANAGER_URL_ENV,
    _MANAGER_URL_ENV,
    _MAX_CONNECTIONS,
    OllamaLocalProvider,
    _LimitsCache,
    _resolve_manager_url,
    prettify_ollama_name,
)
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

# Use a base_url that is NOT the conftest's OLLAMA_URL — the provider
# under test takes an explicit override, and we want a /proxy suffix here so
# the health_url derivation is exercised.
TEST_BASE_URL = "http://test-ollama:8002/proxy"
TEST_HEALTH_URL = "http://test-ollama:8002/health"
TEST_CHAT_URL = "http://test-ollama:8002/proxy/v1/chat/completions"


def _limits_payload(
    num_parallel: int = 1,
    max_queue: int = 16,
    max_loaded_models: int = 1,
    schema_version: int | None | object = ...,  # sentinel: include version=1
) -> dict:
    """Build a /health-shaped body for tests.

    By default includes the current ``_KNOWN_SCHEMA_VERSION`` so existing
    tests assert the happy path regardless of future bumps. Pass
    ``schema_version=None`` to omit the field (simulates a pre-WARP-284
    appliance) or any other int to force a drift case.
    """
    body: dict = {
        "limits": {
            "num_parallel": num_parallel,
            "max_queue": max_queue,
            "max_loaded_models": max_loaded_models,
        }
    }
    if schema_version is ...:
        body["schema_version"] = _LimitsCache._KNOWN_SCHEMA_VERSION
    elif schema_version is not None:
        body["schema_version"] = schema_version
    # schema_version=None: omit the key entirely (pre-WARP-284 shape).
    return body


@pytest.fixture
async def provider():
    """Provider with a closed httpx client at end-of-test."""
    p = OllamaLocalProvider(base_url=TEST_BASE_URL)
    yield p
    await p.close()


# ---------------------------------------------------------------------------
# Connection pool sizing (GW-13)
# ---------------------------------------------------------------------------


class TestConnectionPoolSizing:
    """The httpx pool must NOT be pinned to construction-time num_parallel (1).

    GW-13: the pool used to be built with max_connections=num_parallel, which is
    1 before the first /health refresh. A later scale-up resized the in-flight
    semaphore but left the pool serializing every chat through one connection.
    The pool is now sized to a generous fixed cap; the semaphore is the real
    concurrency gate.
    """

    @staticmethod
    def _pool_max_connections(provider: OllamaLocalProvider) -> int | None:
        # httpx AsyncClient → AsyncHTTPTransport → httpcore AsyncConnectionPool.
        pool = provider.client._transport._pool  # type: ignore[attr-defined]
        return getattr(pool, "_max_connections", None)

    async def test_pool_not_pinned_to_num_parallel(self):
        provider = OllamaLocalProvider(base_url="http://test-ollama:11434")
        try:
            # num_parallel starts at 1; the pool must be larger than that.
            assert provider._limits.num_parallel == 1
            assert self._pool_max_connections(provider) == _MAX_CONNECTIONS
            assert _MAX_CONNECTIONS > 1
        finally:
            await provider.close()


# ---------------------------------------------------------------------------
# WARP-1748 — INFERENCE_MANAGER_URL, with OLLAMA_MANAGER_URL as a warned shim
# ---------------------------------------------------------------------------


class TestManagerUrlResolution:
    """These are the tests that prove field boxes survive the rename.

    `OLLAMA_MANAGER_URL` is in the .env of deployed boxes and reaches this
    process through the ai-gateway's `env_file: ../.env`
    (docker/docker-compose.yml:979-981). If the fallback ever regresses, the
    failure is SILENT — the appliance-limits probe stops resolving, outbound
    concurrency stays pinned at 1, and /ai/readiness reports a permanent
    "degraded" that nobody investigates for weeks. Hence a case per branch.

    Precedence under test: canonical → legacy (warned) → today's default
    (None). An explicitly-EMPTY value counts as unset at every step (the
    compose `${VAR:-}` trap).
    """

    @staticmethod
    def _resolve(monkeypatch, canonical: str | None, legacy: str | None) -> str | None:
        """Resolve with the two vars forced to the given state.

        `None` means "not in the environment at all" — distinct from `""`,
        which is what compose's `${VAR:-}` actually delivers and which the
        resolver must treat as unset.
        """
        for name, value in ((_MANAGER_URL_ENV, canonical), (_LEGACY_MANAGER_URL_ENV, legacy)):
            if value is None:
                monkeypatch.delenv(name, raising=False)
            else:
                monkeypatch.setenv(name, value)
        return _resolve_manager_url()

    @staticmethod
    def _warnings(caplog) -> list[str]:
        return [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]

    def test_canonical_name_wins(self, monkeypatch, caplog):
        with caplog.at_level(logging.WARNING):
            resolved = self._resolve(monkeypatch, "http://manager:8002", None)
        assert resolved == "http://manager:8002"
        # Nothing deprecated is in play — a clean box must not be nagged.
        assert self._warnings(caplog) == []

    def test_legacy_name_still_works_and_warns(self, monkeypatch, caplog):
        # THE field-box case: an un-migrated .env carries only the old name.
        with caplog.at_level(logging.WARNING):
            resolved = self._resolve(monkeypatch, None, "http://legacy-manager:8002")
        assert resolved == "http://legacy-manager:8002"

        warnings = self._warnings(caplog)
        assert len(warnings) == 1
        msg = warnings[0]
        # The warning has to be ACTIONABLE: old name, new name, and the file.
        assert _LEGACY_MANAGER_URL_ENV in msg
        assert _MANAGER_URL_ENV in msg
        assert "DEPRECATED" in msg
        assert ".env" in msg

    def test_canonical_wins_when_both_set(self, monkeypatch, caplog):
        with caplog.at_level(logging.WARNING):
            resolved = self._resolve(monkeypatch, "http://new:8002", "http://old:8002")
        assert resolved == "http://new:8002"

        # Still warns — two names for one endpoint is how a box ends up
        # probing a stale manager after a half-finished .env edit.
        warnings = self._warnings(caplog)
        assert len(warnings) == 1
        assert _LEGACY_MANAGER_URL_ENV in warnings[0]
        assert _MANAGER_URL_ENV in warnings[0]
        # Never leak the configured values into the logs (URLs can carry creds).
        assert "http://new:8002" not in warnings[0]
        assert "http://old:8002" not in warnings[0]

    def test_empty_canonical_does_not_shadow_legacy(self, monkeypatch, caplog):
        # The compose `${VAR:-}` trap: an unset compose variable arrives as ""
        # (not "absent"). An empty canonical must NOT blank out a field box's
        # working legacy value — that would be the exact silent breakage the
        # shim exists to prevent.
        with caplog.at_level(logging.WARNING):
            resolved = self._resolve(monkeypatch, "", "http://legacy-manager:8002")
        assert resolved == "http://legacy-manager:8002"
        assert len(self._warnings(caplog)) == 1

    def test_whitespace_only_canonical_does_not_shadow_legacy(self, monkeypatch):
        # `.env` lines pick up trailing spaces; whitespace is not configuration.
        assert self._resolve(monkeypatch, "   ", "http://legacy-manager:8002") == (
            "http://legacy-manager:8002"
        )

    def test_neither_set_keeps_todays_default(self, monkeypatch, caplog):
        # Unchanged behavior: no manager wired → None, so _LimitsCache falls
        # through to the /proxy derivation and then skips the probe (XR-05).
        with caplog.at_level(logging.WARNING):
            assert self._resolve(monkeypatch, None, None) is None
        assert self._warnings(caplog) == []

    def test_both_empty_keeps_todays_default(self, monkeypatch, caplog):
        with caplog.at_level(logging.WARNING):
            assert self._resolve(monkeypatch, "", "") is None
        # An empty legacy value is not a deployment to warn about.
        assert self._warnings(caplog) == []

    def test_legacy_value_reaches_the_health_url(self, monkeypatch):
        # End-to-end for the field box: the legacy name must still produce the
        # manager /health URL the limits probe GETs. Patching the resolved
        # module constant is how the import-time read is exercised (the
        # deployed process resolves once at import).
        import providers.ollama_local as ol

        monkeypatch.setattr(
            ol, "INFERENCE_MANAGER_URL", self._resolve(monkeypatch, None, "http://legacy:8002")
        )
        cache = _LimitsCache("http://ollama:11434")  # direct path, no /proxy
        assert cache.health_url == "http://legacy:8002/health"


# ---------------------------------------------------------------------------
# _LimitsCache
# ---------------------------------------------------------------------------


class TestLimitsCache:
    """Unit tests for the appliance-limits cache."""

    def test_health_url_strips_proxy_suffix(self):
        # The opt-in /proxy chat path IS the manager (:8002), so /health is
        # derived from it (back-compat with the manager deploy).
        cache = _LimitsCache("http://ollama:8002/proxy")
        assert cache.health_url == "http://ollama:8002/health"

    def test_health_url_none_on_direct_path(self):
        # XR-05: a direct Ollama URL (no /proxy) with no INFERENCE_MANAGER_URL
        # has NO manager /health to probe — health_url is None so refresh()
        # skips the probe instead of 404-ing against Ollama :11434.
        cache = _LimitsCache("http://ollama:11434")
        assert cache.health_url is None

    def test_health_url_prefers_explicit_manager_url(self, monkeypatch):
        # XR-05: the manager URL decouples /health from the chat URL.
        # WARP-1748 renamed the module constant OLLAMA_MANAGER_URL ->
        # INFERENCE_MANAGER_URL; the patched attribute moves with it. The
        # ASSERTION is unchanged — this is a mechanical follow of the rename,
        # not a behavior edit.
        import providers.ollama_local as ol

        monkeypatch.setattr(ol, "INFERENCE_MANAGER_URL", "http://manager:8002")
        cache = _LimitsCache("http://ollama:11434")
        assert cache.health_url == "http://manager:8002/health"

    def test_initial_defaults(self):
        cache = _LimitsCache(TEST_BASE_URL)
        assert cache.num_parallel == 1
        assert cache.max_queue == 16
        assert cache.max_loaded_models == 1
        assert cache._last_refresh == 0.0

    @respx.mock
    async def test_refresh_skips_probe_on_direct_path(self):
        # XR-05: with no manager wired, refresh() must NOT issue any HTTP GET
        # (no 404 against Ollama) and must keep the default limits.
        route = respx.get(url__regex=r".*/health").mock(
            return_value=httpx.Response(200, json=_limits_payload(num_parallel=9))
        )
        cache = _LimitsCache("http://ollama:11434")  # direct path → health_url None
        async with httpx.AsyncClient() as client:
            await cache.refresh(client)
        assert route.call_count == 0
        assert cache.num_parallel == 1  # unchanged default

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
# _LimitsCache schema_version drift detection (WARP-284)
# ---------------------------------------------------------------------------


class TestLimitsCacheSchemaVersion:
    """The four cases of /health.schema_version vs _KNOWN_SCHEMA_VERSION."""

    @respx.mock
    async def test_schema_version_equal_is_silent(self, caplog):
        """Happy path: appliance schema_version matches what we know."""
        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(
                200, json=_limits_payload(schema_version=_LimitsCache._KNOWN_SCHEMA_VERSION)
            )
        )
        cache = _LimitsCache(TEST_BASE_URL)
        with caplog.at_level("WARNING", logger="providers.ollama_local"):
            async with httpx.AsyncClient() as client:
                await cache.refresh(client)

        # No warning about schema version drift.
        assert not any(
            "schema_version" in r.getMessage() for r in caplog.records
        ), f"unexpected schema_version warning: {[r.getMessage() for r in caplog.records]}"
        # Limits still parsed normally.
        assert cache.num_parallel == 1

    @respx.mock
    async def test_schema_version_missing_logs_warning(self, caplog):
        """Pre-WARP-284 appliance: no schema_version key in body."""
        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(schema_version=None))
        )
        cache = _LimitsCache(TEST_BASE_URL)
        with caplog.at_level("WARNING", logger="providers.ollama_local"):
            async with httpx.AsyncClient() as client:
                await cache.refresh(client)

        msgs = [r.getMessage() for r in caplog.records]
        assert any("appliance_schema_version_missing" in m for m in msgs), msgs
        # Limits still parsed by name — graceful degradation.
        assert cache.num_parallel == 1

    @respx.mock
    async def test_schema_version_newer_logs_warning(self, caplog):
        """Appliance is on a future version this orchestrator doesn't know."""
        future_version = _LimitsCache._KNOWN_SCHEMA_VERSION + 5
        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(
                200, json=_limits_payload(schema_version=future_version)
            )
        )
        cache = _LimitsCache(TEST_BASE_URL)
        with caplog.at_level("WARNING", logger="providers.ollama_local"):
            async with httpx.AsyncClient() as client:
                await cache.refresh(client)

        msgs = [r.getMessage() for r in caplog.records]
        assert any(
            "appliance_schema_version_newer_than_known" in m for m in msgs
        ), msgs
        # The warning includes both numbers so operators can see the gap.
        joined = "\n".join(msgs)
        assert f"appliance={future_version}" in joined
        assert f"orchestrator={_LimitsCache._KNOWN_SCHEMA_VERSION}" in joined

    @respx.mock
    async def test_schema_version_older_logs_warning(self, caplog):
        """Appliance is on stale code — older than the orchestrator knows.

        Only meaningful once _KNOWN_SCHEMA_VERSION > 1; for now we simulate
        by temporarily setting the cache's known to a higher number.
        """
        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(200, json=_limits_payload(schema_version=1))
        )
        cache = _LimitsCache(TEST_BASE_URL)
        # Force the orchestrator to know a higher version than the appliance reports.
        cache._KNOWN_SCHEMA_VERSION = 99  # type: ignore[misc]  # test-only override
        with caplog.at_level("WARNING", logger="providers.ollama_local"):
            async with httpx.AsyncClient() as client:
                await cache.refresh(client)

        msgs = [r.getMessage() for r in caplog.records]
        assert any(
            "appliance_schema_version_older_than_known" in m for m in msgs
        ), msgs

    @respx.mock
    async def test_schema_version_warning_logged_once(self, caplog):
        """Repeated refreshes against the same drift state log only once."""
        future_version = _LimitsCache._KNOWN_SCHEMA_VERSION + 5
        respx.get(TEST_HEALTH_URL).mock(
            return_value=httpx.Response(
                200, json=_limits_payload(schema_version=future_version)
            )
        )
        cache = _LimitsCache(TEST_BASE_URL)
        # Disable debounce so multiple refreshes hit the schema-check path.
        cache._refresh_min_interval = 0.0
        with caplog.at_level("WARNING", logger="providers.ollama_local"):
            async with httpx.AsyncClient() as client:
                await cache.refresh(client)
                await cache.refresh(client)
                await cache.refresh(client)

        msgs = [r.getMessage() for r in caplog.records]
        # Exactly one schema_version warning despite three refreshes.
        schema_warnings = [m for m in msgs if "schema_version" in m]
        assert len(schema_warnings) == 1, schema_warnings


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


# ---------------------------------------------------------------------------
# WARP-1442 — streaming chat content contract
# ---------------------------------------------------------------------------


class TestStreamingProviderContent:
    """The streaming path yields Ollama's OpenAI-compat SSE chunks in order,
    VERBATIM: content, reasoning_content, and tool_call fragments all pass
    through untouched.

    The gateway never accumulates tool-call fragments, folds reasoning into
    content, or dispatches tools — the orchestrator agent loop owns all of that
    (ADR-011 / WARP-104). This test pins that the streaming transport is a
    faithful passthrough so the loop's by-index accumulation + reasoning
    separation have exactly the frames they expect. reasoning_effort rides the
    streaming body for gpt-oss, identical to the non-streaming path.
    """

    # One turn's worth of Ollama OpenAI-compat streaming SSE: two content
    # fragments, a reasoning-channel fragment, a tool-call fragment (args split
    # so the orchestrator must concatenate by index), then the terminal [DONE].
    SSE_BODY = (
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
        'data: {"choices":[{"delta":{"reasoning_content":"analysing"}}]}\n\n'
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1",'
        '"type":"function","function":{"name":"get_x","arguments":"{}"}}]}}]}\n\n'
        "data: [DONE]\n\n"
    )

    @staticmethod
    def _stub_limits(provider: OllamaLocalProvider) -> None:
        provider._limits.num_parallel = 1
        provider._limits._last_refresh = time.monotonic()
        provider._sema = asyncio.Semaphore(1)
        provider._sema_size = 1

    @respx.mock
    async def test_streaming_yields_chunks_in_order_verbatim(self, provider):
        self._stub_limits(provider)
        respx.post(TEST_CHAT_URL).mock(
            return_value=httpx.Response(200, text=self.SSE_BODY)
        )
        gen = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            stream=True,
        )
        frames = [frame async for frame in gen]

        # Each yielded frame is a full SSE frame: "data: {json}\n\n".
        payloads = [f[len("data: ") :].strip() for f in frames]
        assert payloads[-1] == "[DONE]"
        parsed = [json.loads(p) for p in payloads[:-1]]

        # Order is preserved fragment-for-fragment.
        assert parsed[0]["choices"][0]["delta"]["content"] == "Hel"
        assert parsed[1]["choices"][0]["delta"]["content"] == "lo"
        # reasoning_content is a SEPARATE delta field — never folded into content.
        assert parsed[2]["choices"][0]["delta"]["reasoning_content"] == "analysing"
        assert "content" not in parsed[2]["choices"][0]["delta"]
        # Tool-call fragment passes through verbatim, INDEX intact so the
        # orchestrator can accumulate args by index.
        tc = parsed[3]["choices"][0]["delta"]["tool_calls"][0]
        assert tc["index"] == 0
        assert tc["function"]["name"] == "get_x"

    @respx.mock
    async def test_streaming_body_sets_stream_true_and_reasoning_effort(self, provider):
        self._stub_limits(provider)
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, text=self.SSE_BODY)

        respx.post(TEST_CHAT_URL).mock(side_effect=handler)
        gen = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            stream=True,
            reasoning_effort="low",
        )
        _ = [frame async for frame in gen]
        # WARP-1442a keeps working on the streaming request too.
        assert captured["body"]["stream"] is True
        assert captured["body"]["reasoning_effort"] == "low"

    @respx.mock
    async def test_streaming_early_break_tears_down_cleanly(self, provider):
        # A client disconnect mid-stream: consume one frame, then close the
        # generator. The `async with client.stream()` + semaphore context must
        # unwind without raising (WARP-329 teardown).
        self._stub_limits(provider)
        respx.post(TEST_CHAT_URL).mock(
            return_value=httpx.Response(200, text=self.SSE_BODY)
        )
        gen = await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            stream=True,
        )
        first = None
        async for frame in gen:
            first = frame
            break
        await gen.aclose()
        assert first is not None and first.startswith("data: ")
        # The semaphore slot was released on teardown (not leaked).
        assert provider._sema._value == 1


# ---------------------------------------------------------------------------
# WARP-1284 (F1/F2) — list_models failure seam + metadata timeout
# ---------------------------------------------------------------------------


class TestListModelsFailureSeam:
    """WARP-1284 F1 — list_models must RAISE on transport/HTTP failures.

    The old code swallowed them into `return []`, which made the router's
    degraded_providers classification dead code in production: a dead
    Ollama was indistinguishable from an empty registry, so the setup
    wizard showed "still downloading" for an unreachable AI service. The
    router fan-out (list_all_models, the only production caller) already
    handles the raise via asyncio.gather(return_exceptions=True)."""

    BASE = "http://dead-ollama:11434"

    @respx.mock
    async def test_raises_on_connect_error(self):
        respx.get(f"{self.BASE}/api/tags").mock(
            side_effect=httpx.ConnectError("connection refused")
        )
        provider = OllamaLocalProvider(base_url=self.BASE)
        with pytest.raises(httpx.ConnectError):
            await provider.list_models()

    @respx.mock
    async def test_raises_on_http_error(self):
        respx.get(f"{self.BASE}/api/tags").mock(
            return_value=httpx.Response(500, text="boom")
        )
        provider = OllamaLocalProvider(base_url=self.BASE)
        with pytest.raises(httpx.HTTPStatusError):
            await provider.list_models()

    @respx.mock
    async def test_genuinely_empty_tags_still_returns_empty_list(self):
        """A REACHABLE Ollama with no model pulled yet (first boot) is the
        one honest empty-list case — it must stay a plain [] (not degraded)."""
        respx.get(f"{self.BASE}/api/tags").mock(
            return_value=httpx.Response(200, json={"models": []})
        )
        provider = OllamaLocalProvider(base_url=self.BASE)
        assert await provider.list_models() == []

    async def test_tags_get_uses_short_metadata_timeout(self, monkeypatch):
        """WARP-1284 F2 — /api/tags is a metadata call; it must NOT ride the
        shared client's 300s chat read timeout. Degraded listings are never
        TTL-cached, so a slow-not-down Ollama would otherwise pile hung
        wizard/SWR polls onto the shared connection pool chat also uses."""
        from providers.ollama_local import _TAGS_TIMEOUT_S

        provider = OllamaLocalProvider(base_url=self.BASE)
        captured: dict = {}

        async def fake_get(url, **kwargs):
            captured["timeout"] = kwargs.get("timeout")
            return httpx.Response(
                200, json={"models": []}, request=httpx.Request("GET", url)
            )

        monkeypatch.setattr(provider.client, "get", fake_get)
        await provider.list_models()
        assert captured["timeout"] == _TAGS_TIMEOUT_S
        assert _TAGS_TIMEOUT_S <= 5.0


# ---------------------------------------------------------------------------
# WARP-1442 — gpt-oss reasoning-effort control on the outbound Ollama request
# ---------------------------------------------------------------------------


class TestReasoningEffort:
    """The knob is set as a TOP-LEVEL `reasoning_effort` field on the
    OpenAI-compat /v1/chat/completions body — the same shape as temperature /
    max_tokens (see the GW-12 note in ollama_local.chat), so it reaches Ollama
    on the exact path this provider already uses. It is applied ONLY for the
    gpt-oss family (the reasoning-capable model this stack serves), so every
    other model's request is byte-for-byte unchanged and we never risk a 400
    on a field a non-reasoning model doesn't understand. Unset → the field is
    never added (back-compat)."""

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
                    "model": "gpt-oss:20b",
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
    async def test_low_effort_set_on_body_for_gpt_oss(self, provider):
        self._stub_limits(provider)
        handler, captured = self._capture_post()
        respx.post(TEST_CHAT_URL).mock(side_effect=handler)

        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            reasoning_effort="low",
        )
        assert captured["body"]["reasoning_effort"] == "low"

    @respx.mock
    async def test_effort_passed_through_verbatim_for_gpt_oss(self, provider):
        # A different level proves we forward the caller's value, not a constant.
        self._stub_limits(provider)
        handler, captured = self._capture_post()
        respx.post(TEST_CHAT_URL).mock(side_effect=handler)

        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
            reasoning_effort="high",
        )
        assert captured["body"]["reasoning_effort"] == "high"

    @respx.mock
    async def test_no_reasoning_effort_key_when_unset(self, provider):
        # Byte-for-byte back-compat: an unset knob must NOT add the field, even
        # for a gpt-oss model. This is the dashboard/default path.
        self._stub_limits(provider)
        handler, captured = self._capture_post()
        respx.post(TEST_CHAT_URL).mock(side_effect=handler)

        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="gpt-oss:20b",
        )
        assert "reasoning_effort" not in captured["body"]

    @respx.mock
    async def test_effort_ignored_for_non_reasoning_model(self, provider):
        # No-op guard: a non-gpt-oss model's request stays byte-for-byte
        # unchanged even when an effort is passed, so a model that doesn't
        # support the field never receives it.
        self._stub_limits(provider)
        handler, captured = self._capture_post()
        respx.post(TEST_CHAT_URL).mock(side_effect=handler)

        await provider.chat(
            messages=[ChatMessage(role="user", content="hi")],
            model="llama3.2:3b",
            reasoning_effort="low",
        )
        assert "reasoning_effort" not in captured["body"]
