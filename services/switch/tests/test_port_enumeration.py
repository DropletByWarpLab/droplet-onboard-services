"""WARP-2165: the port list is a property of the UNIT, not of the driver.

`services/switch/drivers/openwrt.py` used to derive every port from module
constants written for the GS1900-**10HP** (`PORT_MAX = 10`, SFP at 9-10). The
fleet also runs an 8-port **8HP**, which has only `lan1`-`lan8` — verified on
the live unit at 192.168.9.2, where `ubus call network.device status` returns
exactly `eth0 lan1..lan8 lo switch switch.1` and nothing else.

Against a constant the 8HP therefore grew two ports that do not physically
exist, and four consumers believed it: `/system/info` reported `port_count:10`,
`/ports` returned 9 and 10 as `is_sfp`, `detect_wan_port` preferred the SFP
bank, and the orchestrator's camera-VLAN helper defaulted its trunk to [9,10].

The switch already reports the truth on a call `get_ports` was making anyway.
These tests pin that it is ASKED, on both variants, off one device read.
"""

from __future__ import annotations

import pytest

from drivers.openwrt import OpenWrtSwitchDriver


def _dev(up=True, carrier=True, speed="1000F"):
    return {"up": up, "carrier": carrier, "speed": speed, "statistics": {}}


# Shape as returned live by the 8HP. Note the NON-port devices: a naive
# "count the keys" would report 12 ports, so the filter has to be `lanN`.
EIGHT_PORT = {
    "eth0": _dev(carrier=False),
    "lo": _dev(),
    "switch": _dev(),
    "switch.1": _dev(),
    **{f"lan{n}": _dev(carrier=(n in (1, 7, 8))) for n in range(1, 9)},
}

TEN_PORT = {
    **EIGHT_PORT,
    "lan9": _dev(carrier=False),
    "lan10": _dev(carrier=False),
}

# `poe info` reports lan1-8 on BOTH variants — PoE is the copper bank.
POE_INFO = {
    "firmware": "v16.0",
    "budget": 70,
    "ports": {f"lan{n}": {"priority": 0, "mode": "PoE", "status": "Searching"}
              for n in range(1, 9)},
}


def _driver(devices, poe=POE_INFO, **kw):
    d = OpenWrtSwitchDriver(host="192.0.2.1", password="x", **kw)

    async def fake_ubus(obj, method, args=None):
        if (obj, method) == ("network.device", "status"):
            # get_system_info reads a single named device; get_ports reads all.
            if args and args.get("name"):
                return devices.get(args["name"], {"macaddr": "c8:33:74:2e:e1:38"})
            return devices
        if (obj, method) == ("poe", "info"):
            return poe
        if (obj, method) == ("system", "board"):
            return {"model": "Zyxel GS1900-8HP B1 Switch", "hostname": "droplet-switch",
                    "release": {"version": "25.12.5"}}
        if (obj, method) == ("system", "info"):
            return {"uptime": 100000}
        return {}

    d._ubus = fake_ubus  # type: ignore[assignment]
    return d


class TestEightPortUnit:
    @pytest.mark.asyncio
    async def test_reports_exactly_the_eight_ports_the_device_has(self):
        ports = await _driver(EIGHT_PORT).get_ports()
        assert [p["port"] for p in ports] == list(range(1, 9))

    @pytest.mark.asyncio
    async def test_invents_no_sfp_ports(self):
        """The regression itself: 9 and 10 arrived as `is_sfp: true` phantoms."""
        ports = await _driver(EIGHT_PORT).get_ports()
        assert [p["port"] for p in ports if p["is_sfp"]] == []

    @pytest.mark.asyncio
    async def test_system_info_port_count_matches_the_hardware(self):
        info = await _driver(EIGHT_PORT).get_system_info()
        assert info["port_count"] == 8

    @pytest.mark.asyncio
    async def test_wan_detect_does_not_claim_an_sfp_uplink(self):
        """With no SFP bank, the answer must come from copper and SAY so —
        the old code reached the SFP branch on a switch with no SFP cage.

        The reason may still mention SFP (it explains that the unit has none);
        what it must never do is CLAIM one as the uplink, which is what
        `confidence: high` + "uplink bank" meant."""
        res = await _driver(EIGHT_PORT).detect_wan_port()
        assert res["wan_port"] in (1, 7, 8)
        assert res["confidence"] == "low"
        assert "uplink bank" not in res["reason"].lower()
        assert "no sfp ports" in res["reason"].lower()


class TestTenPortUnit:
    """The 10HP must keep working — this is a generalisation, not a swap."""

    @pytest.mark.asyncio
    async def test_reports_all_ten_ports(self):
        ports = await _driver(TEN_PORT).get_ports()
        assert [p["port"] for p in ports] == list(range(1, 11))

    @pytest.mark.asyncio
    async def test_the_last_two_are_still_sfp(self):
        ports = await _driver(TEN_PORT).get_ports()
        assert [p["port"] for p in ports if p["is_sfp"]] == [9, 10]

    @pytest.mark.asyncio
    async def test_system_info_port_count_is_ten(self):
        info = await _driver(TEN_PORT).get_system_info()
        assert info["port_count"] == 10


class TestDegradedRead:
    @pytest.mark.asyncio
    async def test_a_device_list_with_no_ports_reports_none_rather_than_ten(self):
        """Fail honest, not convenient. If the unit answers but names no
        `lanN`, the truthful answer is "I found no ports" — silently falling
        back to the old 10-port guess is what produced this bug class."""
        ports = await _driver({"eth0": _dev(), "lo": _dev()}).get_ports()
        assert ports == []

    @pytest.mark.asyncio
    async def test_non_contiguous_numbering_is_preserved_and_sorted(self):
        """Never re-derive ports as range(1, len+1): a unit that names
        lan1/lan2/lan5 has a port 5, not a port 3."""
        odd = {"lan1": _dev(), "lan5": _dev(), "lan2": _dev()}
        ports = await _driver(odd).get_ports()
        assert [p["port"] for p in ports] == [1, 2, 5]
