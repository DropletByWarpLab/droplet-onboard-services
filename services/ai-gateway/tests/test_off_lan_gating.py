"""WARP-468 — tests for the off-LAN cloud-model-escape gate."""
from __future__ import annotations

import pytest
import httpx
from unittest.mock import patch, AsyncMock

from fastapi import HTTPException

from middleware import off_lan_gating
from middleware.off_lan_gating import (
    _invalidate_cache_for_tests,
    check_off_lan_gate,
    get_cloud_model_escape,
    is_local_provider,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    _invalidate_cache_for_tests()
    yield
    _invalidate_cache_for_tests()


@pytest.fixture(autouse=True)
def _set_token(monkeypatch):
    # The fetch helper short-circuits to "fail closed" when the token
    # is unset. Tests that exercise actual orchestrator reads need a
    # token in place; tests that exercise the no-token branch override.
    monkeypatch.setattr(off_lan_gating, "AI_GATEWAY_SAMPLER_TOKEN", "test-token")


class TestLocalProviderShortCircuit:
    def test_ollama_is_local(self):
        assert is_local_provider("ollama") is True
        assert is_local_provider("OLLAMA") is True
        assert is_local_provider("ollama_local") is True

    def test_cloud_providers_are_not_local(self):
        assert is_local_provider("anthropic") is False
        assert is_local_provider("openai") is False
        assert is_local_provider("unknown") is False

    async def test_gate_no_op_for_local(self):
        # The gate must not even attempt to fetch when the provider
        # is local — running locally has nothing to do with off-LAN.
        with patch.object(
            off_lan_gating, "_fetch_off_lan_posture", new=AsyncMock(return_value=False),
        ) as mock_fetch:
            await check_off_lan_gate("ollama")
            mock_fetch.assert_not_called()


class TestGateBlocksCloud:
    async def test_blocks_anthropic_when_escape_disabled(self):
        with patch.object(
            off_lan_gating,
            "_fetch_off_lan_posture",
            new=AsyncMock(return_value=False),
        ):
            with pytest.raises(HTTPException) as exc:
                await check_off_lan_gate("anthropic")
            assert exc.value.status_code == 451
            assert exc.value.detail["channel"] == "cloud_model_escape"
            assert exc.value.detail["provider"] == "anthropic"

    async def test_allows_openai_when_escape_enabled(self):
        with patch.object(
            off_lan_gating,
            "_fetch_off_lan_posture",
            new=AsyncMock(return_value=True),
        ):
            # No raise — passes through cleanly.
            await check_off_lan_gate("openai")


class TestFailClosed:
    async def test_fails_closed_when_orchestrator_unreachable(self):
        # Simulate a transport error from the orchestrator. The gate
        # must refuse cloud calls rather than fail-open — sovereignty
        # contract trumps service availability for this surface.
        async def boom(*args, **kwargs):
            raise httpx.ConnectError("orchestrator unreachable")

        with patch("middleware.off_lan_gating.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = boom
            with pytest.raises(HTTPException) as exc:
                await check_off_lan_gate("anthropic")
            assert exc.value.status_code == 451

    async def test_fails_closed_on_missing_token(self, monkeypatch):
        monkeypatch.setattr(off_lan_gating, "AI_GATEWAY_SAMPLER_TOKEN", "")
        # No token → fetch returns None → posture treated as disabled.
        with pytest.raises(HTTPException) as exc:
            await check_off_lan_gate("anthropic")
        assert exc.value.status_code == 451


class TestCacheTtl:
    async def test_cache_hit_within_ttl(self):
        with patch.object(
            off_lan_gating,
            "_fetch_off_lan_posture",
            new=AsyncMock(return_value=True),
        ) as mock_fetch:
            assert await get_cloud_model_escape() is True
            assert await get_cloud_model_escape() is True
            # One fetch even though we asked twice.
            assert mock_fetch.call_count == 1

    async def test_cache_skipped_when_fetch_returns_none(self):
        # A failed fetch must not poison the cache — the next call
        # must re-try rather than reuse a stale failure.
        with patch.object(
            off_lan_gating,
            "_fetch_off_lan_posture",
            new=AsyncMock(return_value=None),
        ) as mock_fetch:
            assert await get_cloud_model_escape() is False
            assert await get_cloud_model_escape() is False
            assert mock_fetch.call_count == 2
