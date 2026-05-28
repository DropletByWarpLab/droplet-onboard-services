"""WARP-468 — tests for the off-LAN egress meter's diff + post path."""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

import egress_meter
from egress_meter import (
    _channel_for_chain,
    _derive_deltas,
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


class TestChannelMapping:
    def test_maps_droplet_offlan_prefix_to_channel(self):
        assert _channel_for_chain("droplet_offlan_telemetry") == "telemetry"
        assert (
            _channel_for_chain("droplet_offlan_cloud_model_escape")
            == "cloud_model_escape"
        )

    def test_rejects_unknown_chains(self):
        assert _channel_for_chain("forward") is None
        assert _channel_for_chain("droplet_offlan_unknown") is None
        assert _channel_for_chain("offlan_telemetry") is None  # missing droplet_ prefix


class TestDiffDerivation:
    def test_first_sample_emits_no_deltas(self):
        # Empty previous → no chains have a baseline → no deltas.
        previous: dict[str, _CounterSnapshot] = {}
        current = {"droplet_offlan_telemetry": 1000}
        assert _derive_deltas(previous, current) == {}

    def test_positive_delta_extracted(self):
        previous = {"droplet_offlan_telemetry": _CounterSnapshot(bytes_=1000)}
        current = {"droplet_offlan_telemetry": 4096}
        assert _derive_deltas(previous, current) == {"telemetry": 3096}

    def test_negative_delta_clamps_to_zero(self):
        # nftables counter reset → cur < prev. Honest "I don't know"
        # over a fake spike.
        previous = {"droplet_offlan_telemetry": _CounterSnapshot(bytes_=10_000)}
        current = {"droplet_offlan_telemetry": 100}
        assert _derive_deltas(previous, current) == {"telemetry": 0}

    def test_skips_chains_outside_prefix(self):
        previous = {
            "droplet_offlan_telemetry": _CounterSnapshot(bytes_=1000),
            "forward": _CounterSnapshot(bytes_=500),
        }
        current = {
            "droplet_offlan_telemetry": 1500,
            "forward": 600,
        }
        deltas = _derive_deltas(previous, current)
        assert deltas == {"telemetry": 500}


class TestTickFlow:
    @pytest.mark.asyncio
    async def test_first_tick_primes_cache_emits_nothing(self):
        router = MagicMock()
        with (
            patch(
                "egress_meter.read_counters_via_ubus",
                return_value={"droplet_offlan_telemetry": 1000},
            ),
            patch("egress_meter._post_batch", new=AsyncMock()) as mock_post,
        ):
            await _tick(router)
            mock_post.assert_not_called()
        assert "droplet_offlan_telemetry" in egress_meter._previous

    @pytest.mark.asyncio
    async def test_second_tick_posts_deltas(self):
        router = MagicMock()
        readings = iter(
            [
                {"droplet_offlan_telemetry": 1000, "droplet_offlan_outbound_email": 0},
                {"droplet_offlan_telemetry": 1500, "droplet_offlan_outbound_email": 200},
            ]
        )
        with (
            patch(
                "egress_meter.read_counters_via_ubus",
                side_effect=lambda router: next(readings),
            ),
            patch("egress_meter._post_batch", new=AsyncMock()) as mock_post,
        ):
            await _tick(router)
            await _tick(router)
            mock_post.assert_called_once()
        deltas = mock_post.call_args[0][0]
        assert deltas == {"telemetry": 500, "outbound_email": 200}

    @pytest.mark.asyncio
    async def test_empty_read_skips_post(self):
        # Overlay not installed yet → empty dict → don't POST.
        router = MagicMock()
        with (
            patch(
                "egress_meter.read_counters_via_ubus",
                return_value={},
            ),
            patch("egress_meter._post_batch", new=AsyncMock()) as mock_post,
        ):
            await _tick(router)
            mock_post.assert_not_called()


class TestUbusReadDegradation:
    def test_returns_empty_on_ubus_error(self):
        from droplet_openwrt_sdk import UbusError

        router = MagicMock()
        router._call.side_effect = UbusError("method not found")
        assert read_counters_via_ubus(router) == {}
        # Subsequent call still returns empty without re-logging the
        # overlay-warning (module-level flag prevents repeat noise).
        assert read_counters_via_ubus(router) == {}

    def test_filters_non_int_values(self):
        router = MagicMock()
        router._call.return_value = {
            "droplet_offlan_telemetry": 1000,
            "droplet_offlan_outbound_email": "garbage",
            "stray_key": 999,
        }
        result = read_counters_via_ubus(router)
        # "garbage" filtered out; "stray_key" still in the dict (filtered
        # later by _channel_for_chain inside _derive_deltas).
        assert result == {
            "droplet_offlan_telemetry": 1000,
            "stray_key": 999,
        }
