"""Tests for services/switch/watcher.py (WARP-396).

The watcher's contract is "emit one ``smart-port/event`` message per
genuinely-new device, never on prime or inside the dedup window". These
tests exercise that without a real switch or broker — they hand a stub
driver and capture published payloads in-memory.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import pytest

import watcher as watcher_mod
from watcher import SmartPortWatcher


class _StubDriver:
    def __init__(self) -> None:
        self.mac_table: list[dict] = []
        self.poe: list[dict] = []

    async def get_mac_table(self) -> list[dict]:
        return list(self.mac_table)

    async def get_poe_status(self) -> list[dict]:
        return list(self.poe)


def _make_watcher(driver: _StubDriver, *, lease_path: Optional[str] = None) -> SmartPortWatcher:
    w = SmartPortWatcher(
        driver,  # type: ignore[arg-type]
        mqtt_broker_url="mqtt://nowhere:1883",
        watch_interval_s=0.01,
        dedup_window_s=60,
        lease_file=lease_path or "/nonexistent/leases",
    )
    # Force-skip the real MQTT connect; capture published payloads instead.
    w._mqtt = None  # type: ignore[assignment]
    w._published: list[dict[str, Any]] = []  # type: ignore[attr-defined]

    def _capture(payload: dict) -> None:
        w._published.append(payload)  # type: ignore[attr-defined]

    w._publish = _capture  # type: ignore[assignment]
    return w


def test_prime_tick_emits_nothing_even_when_macs_already_present():
    driver = _StubDriver()
    driver.mac_table = [{"port": 7, "mac": "E4:30:22:50:2A:FD", "vlan": 1, "type": "dynamic"}]
    driver.poe = [{"port": 7, "class": "Class 3"}]
    w = _make_watcher(driver)

    asyncio.run(_one_cycle(w))

    assert w._published == [], "prime tick must not emit — those devices were already here"  # type: ignore[attr-defined]


def test_new_mac_after_prime_emits_one_event():
    driver = _StubDriver()
    w = _make_watcher(driver)

    # First tick: prime an empty switch.
    asyncio.run(_one_cycle(w))
    assert w._published == []  # type: ignore[attr-defined]

    # Second tick: a Hanwha just appeared on port 7.
    driver.mac_table = [{"port": 7, "mac": "E4:30:22:50:2A:FD", "vlan": 1, "type": "dynamic"}]
    asyncio.run(_one_cycle(w))

    assert len(w._published) == 1  # type: ignore[attr-defined]
    evt = w._published[0]  # type: ignore[attr-defined]
    assert evt["port"] == 7
    assert evt["mac"] == "E4:30:22:50:2A:FD"
    assert evt["oui"] == "E4:30:22"
    assert evt["source"] == "mac_table"
    assert "ts" in evt


def test_dedup_window_drops_second_event_for_same_port_mac():
    driver = _StubDriver()
    w = _make_watcher(driver)
    asyncio.run(_one_cycle(w))  # prime

    driver.mac_table = [{"port": 7, "mac": "AA:BB:CC:00:11:22", "vlan": 1, "type": "dynamic"}]
    asyncio.run(_one_cycle(w))
    assert len(w._published) == 1  # type: ignore[attr-defined]

    # Simulate the same MAC dropping out and re-learning inside the dedup
    # window — should NOT emit a second event.
    w._known_macs = {}
    asyncio.run(_one_cycle(w))
    assert len(w._published) == 1, "second emission inside dedup window must be dropped"  # type: ignore[attr-defined]


def test_poe_class_transition_emits_event_correlated_to_port_mac():
    driver = _StubDriver()
    driver.poe = [{"port": 7, "class": ""}]
    w = _make_watcher(driver)
    asyncio.run(_one_cycle(w))  # prime: no PD on port 7

    # PoE comes up + a MAC appears at the same time.
    driver.poe = [{"port": 7, "class": "Class 3"}]
    driver.mac_table = [{"port": 7, "mac": "E4:30:22:00:00:01", "vlan": 1, "type": "dynamic"}]
    asyncio.run(_one_cycle(w))

    # Should emit two distinct signals (mac_table + poe_class) but the dedup
    # key is (port, mac) so the second is dropped if the MAC matches.
    sources = [p["source"] for p in w._published]  # type: ignore[attr-defined]
    assert "mac_table" in sources
    # The PoE-transition signal carries the correlated MAC too.
    for p in w._published:  # type: ignore[attr-defined]
        assert p.get("mac") == "E4:30:22:00:00:01"


def test_lease_file_enriches_mac_event_with_ip_and_hostname(tmp_path):
    leases = tmp_path / "droplet-poc-lan.leases"
    leases.write_text(
        "1779437597 E4:30:22:50:2A:FD 192.168.20.176 XNV-C8083R-E43022502AFD *\n",
    )
    driver = _StubDriver()
    w = _make_watcher(driver, lease_path=str(leases))
    asyncio.run(_one_cycle(w))  # prime

    driver.mac_table = [{"port": 7, "mac": "E4:30:22:50:2A:FD", "vlan": 1, "type": "dynamic"}]
    asyncio.run(_one_cycle(w))

    evt = w._published[0]  # type: ignore[attr-defined]
    assert evt["ip"] == "192.168.20.176"
    assert evt["hostname"] == "XNV-C8083R-E43022502AFD"


def test_signal_with_no_mac_and_no_ip_is_dropped():
    driver = _StubDriver()
    w = _make_watcher(driver)
    asyncio.run(_one_cycle(w))  # prime

    # Manually push a bogus signal — simulating a PoE-only transition with
    # no MAC table entry yet and no lease.
    from watcher import _Signal
    w._maybe_emit(_Signal(port=7, mac=None, poe_class=3, ip=None, hostname=None, source="poe_class"))

    assert w._published == [], "signal with neither MAC nor IP must be dropped"  # type: ignore[attr-defined]


def test_lantronix_get_mac_table_normalises_shape():
    from drivers.lantronix import LantronixDriver

    raw = {
        "data": [
            {"port": "7", "MAC": "e4:30:22:50:2a:fd", "vlan": "1", "type": "Dynamic"},
            {"port": 7, "MAC": "01:00:5E:00:00:01", "vlan": 1, "type": "dynamic"},  # multicast, drop
            {"port": "1", "macAddress": "FF:FF:FF:FF:FF:FF", "vlan": 1},  # broadcast, drop
            {"port": 99, "mac": "AA:BB:CC:00:11:22", "vlan": 1},  # out-of-range port, drop
            {"port": "3", "mac": "AA:BB:CC:DD:EE:FF", "vlan": "10", "Type": "static"},
        ],
    }

    # The function is async — but it only awaits `_request`. We monkeypatch
    # that to return our fixture and exercise the normaliser.
    driver = LantronixDriver.__new__(LantronixDriver)

    async def _fake_request(method, path, **kwargs):
        return raw

    driver._request = _fake_request  # type: ignore[assignment]

    result = asyncio.run(driver.get_mac_table())

    macs = {(e["port"], e["mac"]) for e in result}
    assert (7, "E4:30:22:50:2A:FD") in macs
    assert (3, "AA:BB:CC:DD:EE:FF") in macs
    assert len(result) == 2, f"expected exactly 2 valid entries, got {result}"
    static = [e for e in result if e["mac"] == "AA:BB:CC:DD:EE:FF"][0]
    assert static["type"] == "static"
    assert static["vlan"] == 10


async def _one_cycle(w: SmartPortWatcher) -> None:
    """Run exactly one _collect-signals/emit cycle without starting the loop."""
    signals = await w._collect_signals()
    if not w._primed:
        w._primed = True
    else:
        for sig in signals:
            w._maybe_emit(sig)
