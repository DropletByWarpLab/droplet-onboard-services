"""WARP-468 — tests for the DNS-block meter's diff + post path.

Clones test_egress_meter.py. Note the meter tracks a single cumulative
scalar (not a per-channel dict), so deltas are plain ints / None.

`read_counters_via_ubus` is currently a deliberate fail-soft stub (the
real adblock/dnsblock ubus method is unconfirmed), so the degradation
tests assert the stub returns None + warns once. The diff / tick tests
monkeypatch `read_counters_via_ubus` to inject readings, exactly as the
egress-meter tests do.
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

import dns_block_meter
from dns_block_meter import (
    _derive_delta,
    _CounterSnapshot,
    _reset_state_for_tests,
    _tick,
    read_counters_via_ubus,
)


@pytest.fixture(autouse=True)
def _clear_state():
    _reset_state_for_tests()
    yield
    _reset_state_for_tests()


class TestDiffDerivation:
    def test_first_sample_emits_no_delta(self):
        # No previous baseline → first tick primes, emits nothing.
        assert _derive_delta(None, 1000) is None

    def test_positive_delta_extracted(self):
        previous = _CounterSnapshot(blocked=1000)
        assert _derive_delta(previous, 4096) == 3096

    def test_negative_delta_clamps_to_zero(self):
        # adblock reload reset the counter → cur < prev. Honest "I don't
        # know" over a fake spike.
        previous = _CounterSnapshot(blocked=10_000)
        assert _derive_delta(previous, 100) == 0

    def test_zero_delta_is_zero(self):
        previous = _CounterSnapshot(blocked=500)
        assert _derive_delta(previous, 500) == 0


class TestTickFlow:
    @pytest.mark.asyncio
    async def test_first_tick_primes_cache_emits_nothing(self):
        router = MagicMock()
        with (
            patch(
                "dns_block_meter.read_counters_via_ubus",
                return_value=1000,
            ),
            patch("dns_block_meter._post_sample", new=AsyncMock()) as mock_post,
        ):
            await _tick(router)
            mock_post.assert_not_called()
        assert dns_block_meter._previous is not None
        assert dns_block_meter._previous.blocked == 1000

    @pytest.mark.asyncio
    async def test_second_tick_posts_delta(self):
        router = MagicMock()
        readings = iter([1000, 1500])
        with (
            patch(
                "dns_block_meter.read_counters_via_ubus",
                side_effect=lambda router: next(readings),
            ),
            patch("dns_block_meter._post_sample", new=AsyncMock()) as mock_post,
        ):
            await _tick(router)
            await _tick(router)
            mock_post.assert_called_once()
        delta = mock_post.call_args[0][0]
        assert delta == 500

    @pytest.mark.asyncio
    async def test_empty_read_skips_post(self):
        # Overlay not pinned yet → read returns None → don't POST and
        # don't prime the cache.
        router = MagicMock()
        with (
            patch(
                "dns_block_meter.read_counters_via_ubus",
                return_value=None,
            ),
            patch("dns_block_meter._post_sample", new=AsyncMock()) as mock_post,
        ):
            await _tick(router)
            mock_post.assert_not_called()
        assert dns_block_meter._previous is None

    @pytest.mark.asyncio
    async def test_counter_reset_posts_zero_not_spike(self):
        router = MagicMock()
        readings = iter([10_000, 50])
        with (
            patch(
                "dns_block_meter.read_counters_via_ubus",
                side_effect=lambda router: next(readings),
            ),
            patch("dns_block_meter._post_sample", new=AsyncMock()) as mock_post,
        ):
            await _tick(router)
            await _tick(router)
            mock_post.assert_called_once()
        assert mock_post.call_args[0][0] == 0


class TestUbusReadDegradation:
    def test_returns_none_until_overlay_pinned(self):
        # The real ubus method is unconfirmed, so the read is a
        # deliberate fail-soft stub: None + a one-time warning.
        router = MagicMock()
        assert read_counters_via_ubus(router) is None
        # Subsequent call still returns None without re-logging (the
        # module-level flag prevents repeat noise).
        assert read_counters_via_ubus(router) is None
        assert dns_block_meter._overlay_warning_logged is True

    def test_returns_none_on_ubus_error(self):
        # Even when the read is later wired to a real ubus call, a
        # ConnectionLost / UbusError must degrade to None, not raise.
        from droplet_openwrt_sdk import UbusError

        router = MagicMock()
        router._call.side_effect = UbusError("method not found")
        assert read_counters_via_ubus(router) is None
