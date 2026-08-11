"""Physical router port map — WARP-1866.

The switch has had a port map since WARP-1674; the router only ever exposed its
logical interfaces. These tests pin the derivation against payloads captured
off the live RB5009 (``fixtures_rb5009``), because every rule worth having here
is a property of the real reply:

* **link is ``carrier``, not ``up``** — p4–p8 are ``up: True, carrier: False``
  with nothing plugged in, so keying on ``up`` lights every jack;
* **an absent netifd object is ABSENT, not down** — the empty SFP cage reports
  nothing at all and must not be rendered as a dark port;
* **the DSA conduit is not a jack** — ``eth0`` has carrier, counters and 10 Gb,
  so only a roster built from board.json + uci excludes it;
* **bridges and VLANs are not jacks** — ``br-lan`` / ``br-lan.30`` are the
  interfaces' devices, and their *members* are the ports.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import ConnectionLost, UbusError
from router_ports import (
    board_roster,
    derive_ports,
    get_router_ports,
    is_sfp,
    parse_speed,
    parse_traffic,
    resolve_members,
)

from tests.fixtures_rb5009 import BOARD_JSON, DEVICE_STATUS, UCI_NETWORK


AUTH = {"authorization": "Bearer pytest-fake-token"}


def rb5009_ports() -> list[dict]:
    return derive_ports(BOARD_JSON, UCI_NETWORK, DEVICE_STATUS)


def by_id(ports: list[dict]) -> dict[str, dict]:
    return {p["id"]: p for p in ports}


class FakeRouter:
    """Stands in for DropletRouter across the three reads the map needs."""

    def __init__(self, board=BOARD_JSON, uci=UCI_NETWORK, devices=DEVICE_STATUS,
                 board_error: Exception | None = None):
        outer = self

        class _Network:
            def device_status(self):
                if isinstance(devices, Exception):
                    raise devices
                return devices

        class _Uci:
            def get(self, config, section=None, option=None, type=None):
                assert config == "network"
                return uci

        class _System:
            def board_json(self):
                if board_error is not None:
                    raise board_error
                return board

        self.network = _Network()
        self.uci = _Uci()
        self.system = _System()
        self._outer = outer


# --------------------------------------------------------------------------
# The roster: which netdevs are jacks
# --------------------------------------------------------------------------

def test_roster_is_exactly_the_nine_physical_jacks():
    """p1..p8 + the SFP cage — and nothing else."""
    assert [p["id"] for p in rb5009_ports()] == [
        "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "sfp",
    ]


def test_dsa_conduit_is_not_a_port():
    """eth0 has carrier, real counters and 10 Gb — it is the CPU link, not a
    jack. Enumerating `network.device status` directly would ship it as the
    fastest port on the box."""
    assert "eth0" not in by_id(rb5009_ports())


@pytest.mark.parametrize("logical", ["br-lan", "br-lan.30", "lo"])
def test_logical_devices_are_not_ports(logical):
    assert logical not in by_id(rb5009_ports())


def test_sfp_cage_comes_from_the_board_not_from_uci():
    """The cage is in board.json's LAN roster and in NO uci section. Dropping
    board.json would silently drop the ninth port."""
    assert "sfp" in board_roster(BOARD_JSON)
    uci_only = by_id(derive_ports({}, UCI_NETWORK, DEVICE_STATUS))
    assert "sfp" not in uci_only
    assert len(uci_only) == 8


def test_board_roster_handles_both_shapes():
    """`ports` (switch-backed board) and `device` (one NIC per role, e.g. the
    Pi edge router) both enumerate jacks."""
    assert board_roster(BOARD_JSON) == [
        "p2", "p3", "p4", "p5", "p6", "p7", "p8", "sfp", "p1",
    ]
    pi_like = {"network": {"lan": {"device": "eth0"}, "wan": {"device": "eth1"}}}
    assert sorted(board_roster(pi_like)) == ["eth0", "eth1"]
    assert board_roster({}) == []
    assert board_roster(None) == []


def test_ports_are_ordered_like_the_faceplate():
    """Natural sort on the trailing number, fibre after copper — p2 before p10,
    and the cage last."""
    devices = {f"p{n}": {"up": True, "carrier": False} for n in range(1, 11)}
    board = {"network": {"lan": {"ports": [*devices, "sfp"]}}}
    assert [p["id"] for p in derive_ports(board, {}, devices)] == [
        "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "sfp",
    ]


# --------------------------------------------------------------------------
# Link state — the load-bearing honesty rule
# --------------------------------------------------------------------------

def test_link_follows_carrier_not_admin_state():
    """p4-p8 are `up: True` with no cable. If link_up followed `up`, all eight
    LAN jacks would read as live."""
    ports = by_id(rb5009_ports())
    for dark in ("p4", "p5", "p6", "p7", "p8"):
        assert ports[dark]["admin_up"] is True, "fixture must keep the trap"
        assert ports[dark]["link_up"] is False
        assert ports[dark]["status"] == "offline"
    for lit in ("p1", "p2", "p3"):
        assert ports[lit]["link_up"] is True
        assert ports[lit]["status"] == "online"


def test_a_carrier_down_port_reports_no_speed():
    """netifd omits `speed` entirely on this build. Nothing may invent one."""
    ports = by_id(rb5009_ports())
    assert ports["p4"]["speed"] is None
    assert ports["p4"]["duplex"] is None


def test_an_administratively_down_port_is_disabled_not_offline():
    """`up: False` is an operator decision; `carrier: False` is an empty jack.
    They render differently, so they must not collapse into one status."""
    devices = {"p1": {"up": False, "carrier": False, "devtype": "dsa"}}
    port = derive_ports({"network": {"lan": {"ports": ["p1"]}}}, {}, devices)[0]
    assert port["admin_up"] is False
    assert port["status"] == "disabled"


def test_missing_netifd_object_is_absent_never_down():
    """The empty SFP cage. `present: False` + `status: absent` is the whole
    point — a fabricated "down" row would claim we probed a cage we cannot see."""
    sfp = by_id(rb5009_ports())["sfp"]
    assert sfp["present"] is False
    assert sfp["status"] == "absent"
    assert sfp["is_sfp"] is True
    assert sfp["link_up"] is False
    assert sfp["admin_up"] is None  # not False — we have no reading at all
    assert sfp["speed"] is None
    assert sfp["traffic"] is None


# --------------------------------------------------------------------------
# Roles + the interfaces a jack carries
# --------------------------------------------------------------------------

def test_wan_jack_carries_both_wan_and_wan6():
    p1 = by_id(rb5009_ports())["p1"]
    assert p1["role"] == "wan"
    assert p1["networks"] == ["wan", "wan6"]


def test_bridge_member_is_a_lan_port_that_also_trunks_guest():
    """`guest` is a VLAN over br-lan, so its traffic egresses on every bridge
    member. The port is a lan port that ALSO carries guest — calling it a guest
    port would be wrong, and hiding guest would hide a real trunk."""
    p2 = by_id(rb5009_ports())["p2"]
    assert p2["role"] == "lan"
    assert p2["networks"] == ["lan", "guest"]


def test_a_jack_no_interface_uses_is_unused():
    sfp = by_id(rb5009_ports())["sfp"]
    assert sfp["role"] == "unused"
    assert sfp["networks"] == []


def test_an_unrecognised_interface_is_other_not_guessed_lan():
    devices = {"p1": {"up": True, "carrier": True, "speed": "1000F"}}
    uci = {"values": {
        "iot": {".type": "interface", ".name": "iot", "device": "p1"},
    }}
    port = derive_ports({}, uci, devices)[0]
    assert port["role"] == "other"
    assert port["networks"] == ["iot"]


def test_loopback_is_never_a_port_even_though_uci_configures_it():
    """`config interface 'loopback'` has `device 'lo'` — a real uci interface
    pointing at a device that is not a jack."""
    assert "lo" not in by_id(rb5009_ports())


# --------------------------------------------------------------------------
# resolve_members
# --------------------------------------------------------------------------

def test_resolve_members_walks_bridge_and_vlan():
    devices = {
        "br-lan": {"name": "br-lan", "type": "bridge", "ports": ["p2", "p3"]},
        "br-lan.30": {"name": "br-lan.30", "type": "8021q", "ifname": "br-lan"},
    }
    assert resolve_members("br-lan", devices) == ["p2", "p3"]
    assert resolve_members("br-lan.30", devices) == ["p2", "p3"]
    assert resolve_members("p1", devices) == ["p1"]


def test_resolve_members_accepts_a_whitespace_joined_ports_string():
    """uci returns a single-value option as a STRING; iterating it would yield
    one character per 'port'. The switch driver shipped this bug once."""
    devices = {"br-lan": {"name": "br-lan", "type": "bridge",
                          "ports": "p2 p3 p4"}}
    assert resolve_members("br-lan", devices) == ["p2", "p3", "p4"]


def test_resolve_members_survives_a_config_cycle():
    """A hand-edited config whose VLAN parent chain loops must not hang the
    router's own status endpoint."""
    devices = {
        "a": {"name": "a", "type": "8021q", "ifname": "b"},
        "b": {"name": "b", "type": "8021q", "ifname": "a"},
    }
    assert resolve_members("a", devices) == []


# --------------------------------------------------------------------------
# Field parsers
# --------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("1000F", ("1 Gb", "full")),
    ("2500F", ("2.5 Gb", "full")),
    ("10000F", ("10 Gb", "full")),
    ("100H", ("100 Mb", "half")),
    ("10F", ("10 Mb", "full")),
    ("-1F", (None, None)),
    ("0", (None, None)),
    ("", (None, None)),
    (None, (None, None)),
    ("garbage", (None, None)),
])
def test_parse_speed(raw, expected):
    assert parse_speed(raw) == expected


def test_parse_traffic_distinguishes_zero_from_unknown():
    assert parse_traffic({"rx_bytes": 0, "tx_bytes": 0}) == {
        "rx_bytes": 0, "tx_bytes": 0,
    }
    assert parse_traffic({}) is None
    assert parse_traffic(None) is None
    assert parse_traffic({"rx_bytes": "n/a", "tx_bytes": 1}) is None
    assert parse_traffic({"rx_bytes": -1, "tx_bytes": 1}) is None


def test_real_counters_survive_the_join():
    p3 = by_id(rb5009_ports())["p3"]
    assert p3["traffic"] == {"rx_bytes": 205693124, "tx_bytes": 49725610}
    assert p3["speed"] == "1 Gb"
    assert p3["mac"] == "d0:ea:11:41:67:2e"


@pytest.mark.parametrize("name,expected", [
    ("sfp", True), ("sfp1", True), ("SFP", True), ("fiber0", True),
    ("p1", False), ("eth0", False), ("lan8", False),
])
def test_is_sfp(name, expected):
    assert is_sfp(name) is expected


# --------------------------------------------------------------------------
# get_router_ports — shape degradation
# --------------------------------------------------------------------------

def test_get_router_ports_reports_the_model_and_the_map():
    result = get_router_ports(FakeRouter())
    assert result["supported"] is True
    assert result["detail"] is None
    assert result["model"] == "MikroTik RB5009"
    assert len(result["ports"]) == 9


def test_board_json_failure_degrades_to_the_uci_roster():
    """A build without luci-rpc still knows about its configured jacks. It just
    can't know about a cage the config never mentions."""
    result = get_router_ports(FakeRouter(board_error=UbusError(6, "Permission denied")))
    assert result["supported"] is True
    assert result["model"] is None
    assert [p["id"] for p in result["ports"]] == [
        "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8",
    ]


def test_a_shape_with_no_physical_ports_says_so():
    """Not an empty faceplate — an empty faceplate reads as "your router has no
    ports", which is a claim we have no basis for."""
    result = get_router_ports(FakeRouter(board={}, uci={"values": {}}, devices={}))
    assert result["supported"] is False
    assert result["ports"] == []
    assert "doesn't report a physical port map" in result["detail"]


def test_an_unreachable_router_propagates_rather_than_reporting_all_dark():
    router = FakeRouter(devices=ConnectionLost("router unreachable"))
    with pytest.raises(ConnectionLost):
        get_router_ports(router)


# --------------------------------------------------------------------------
# The route
# --------------------------------------------------------------------------

def test_route_serves_the_map(monkeypatch):
    monkeypatch.setattr(main, "get_router", lambda: FakeRouter())
    client = TestClient(main.app)
    res = client.get("/network/ports", headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["supported"] is True
    assert [p["id"] for p in body["ports"]][:3] == ["p1", "p2", "p3"]


def test_route_requires_the_bearer():
    client = TestClient(main.app)
    assert client.get("/network/ports").status_code in (401, 403)


def test_route_surfaces_an_unreachable_router(monkeypatch):
    def boom():
        raise ConnectionLost("router unreachable")

    monkeypatch.setattr(main, "get_router", boom)
    client = TestClient(main.app)
    assert client.get("/network/ports", headers=AUTH).status_code == 503
