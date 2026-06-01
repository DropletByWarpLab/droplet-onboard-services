"""`get_network_summary()` must be deployment-shape-agnostic (ADR-011).

Root-caused live on the 192.168.1.87 single-box: the containerised OpenWrt
there is minimal — `ubus list` exposes only `network.interface.lan` +
`network.interface.loopback`, and it does NOT expose some optional objects
(`network.wireless`, `dhcp`, `firewall` vary by build). `get_all_interface_statuses()`
was already made shape-agnostic by #385, but the OTHER sections of
`get_network_summary()` (resources, wireless, dhcp_leases, firewall_zones) were
raw ubus calls. When the object is absent the low-level client raises
``UbusError(-1, "Object not found")`` (a top-level JSON-RPC error, code -1 —
distinct from the numeric NOT_FOUND used per-interface), which propagated as
HTTP 500 on ``GET /network/summary`` → orchestrator retried 3× then reported the
router UNREACHABLE → the dashboard showed "router offline".

A missing optional surface is data, not a crash (mirrors `interface_stub(present=False)`):
each section degrades to a sensible empty/stub value. Genuine faults
(auth/PERMISSION_DENIED, transport `ConnectionLost`, unrelated ubus errors) still
surface — only the "object not found / not present on this deployment" class degrades.
"""

import pytest

from droplet_openwrt_sdk import (
    NetworkApi,
    UbusError,
    ConnectionLost,
    get_network_summary,
    describe_network_for_llm,
    interface_stub,
    UBUS_STATUS_NOT_FOUND,
    UBUS_STATUS_NO_DATA,
)

UBUS_STATUS_PERMISSION_DENIED = 6

# The error the low-level UbusClient.call() raises when a whole ubus object is
# absent on this build: a top-level JSON-RPC {"error": {"message": ...}} →
# UbusError(-1, "Object not found"). This is the exact 500 root-caused on the box.
OBJECT_NOT_FOUND = UbusError(-1, "Object not found")

_BOARD = {
    "kernel": "6.6.0",
    "hostname": "droplet-sys",
    "model": "x86",
    "release": {"distribution": "OpenWrt", "version": "SNAPSHOT"},
}
_RESOURCES = {"uptime": 7200, "memory": {"total": 8 * 1024**3, "free": 4 * 1024**3}}
_LAN = {
    "up": True,
    "available": True,
    "device": "br-lan",
    "proto": "static",
    "ipv4-address": [{"address": "192.168.20.1", "mask": 24}],
}
_WIRELESS = {"radio0": {"up": True, "interfaces": []}}
_LEASES = [{"hostname": "laptop", "ipaddr": "192.168.20.50", "macaddr": "aa:bb:cc:dd:ee:ff"}]
_FW_ZONES = {"values": {"cfg01": {"name": "lan"}, "cfg02": {"name": "wan"}}}


class _FakeRouter:
    """Stand-in DropletRouter whose sub-API surfaces are driven by `errors`.

    `errors` maps a section name -> Exception to raise from that section's call.
    Any section not in `errors` returns its canned all-present value. Mirrors the
    `_FakeRouter`/responder style already used in test_network_shape.py.
    """

    def __init__(self, errors=None):
        errors = errors or {}
        self.network = _Section(self, "interfaces", errors)
        self.wireless = _Section(self, "wireless", errors)
        self.dhcp = _Section(self, "dhcp_leases", errors)
        self.firewall = _Section(self, "firewall_zones", errors)
        self.system = _SystemSection(self, errors)


class _SectionBase:
    def __init__(self, router, key, errors):
        self._router = router
        self._key = key
        self._errors = errors

    def _maybe_raise(self, key):
        if key in self._errors:
            raise self._errors[key]


class _Section(_SectionBase):
    def get_all_interface_statuses(self):  # network.*
        self._maybe_raise("interfaces")
        return {
            "lan": {**_LAN, "present": True},
            "wan": {
                "up": False, "available": False, "device": "", "proto": "",
                "ipv4-address": [], "ipv6-address": [], "present": False, "data": {},
            },
        }

    def status(self):  # wireless.status()
        self._maybe_raise("wireless")
        return dict(_WIRELESS)

    def active_leases(self):  # dhcp.active_leases()
        self._maybe_raise("dhcp_leases")
        return list(_LEASES)

    def get_zones(self):  # firewall.get_zones()
        self._maybe_raise("firewall_zones")
        return dict(_FW_ZONES)


class _SystemSection(_SectionBase):
    def __init__(self, router, errors):
        super().__init__(router, "system", errors)

    def board_info(self):
        self._maybe_raise("system")
        return dict(_BOARD)

    def resource_info(self):
        self._maybe_raise("resources")
        return dict(_RESOURCES)


# ---------------------------------------------------------------------------
# Happy path — everything present
# ---------------------------------------------------------------------------
def test_summary_all_present_is_complete():
    summary = get_network_summary(_FakeRouter())

    assert summary["system"]["hostname"] == "droplet-sys"
    assert summary["resources"]["uptime"] == 7200
    assert summary["lan"]["present"] is True
    assert summary["wan"]["present"] is False  # single-box: WAN handled by host
    assert summary["wireless"] == _WIRELESS
    assert summary["dhcp_leases"] == _LEASES
    assert summary["firewall_zones"] == _FW_ZONES

    # The LLM describer must work against the full summary.
    text = describe_network_for_llm(_FakeRouter())
    assert "LAN IP 192.168.20.1" in text
    assert "Connected devices (DHCP): 1" in text


# ---------------------------------------------------------------------------
# Each optional section degrades on a missing ubus object (the live bug)
# ---------------------------------------------------------------------------
def test_summary_tolerates_missing_wireless_object():
    summary = get_network_summary(_FakeRouter({"wireless": OBJECT_NOT_FOUND}))
    assert summary["wireless"] == {}
    # other sections unaffected
    assert summary["dhcp_leases"] == _LEASES
    assert summary["firewall_zones"] == _FW_ZONES


def test_summary_tolerates_missing_dhcp_object():
    summary = get_network_summary(_FakeRouter({"dhcp_leases": OBJECT_NOT_FOUND}))
    assert summary["dhcp_leases"] == []
    assert summary["wireless"] == _WIRELESS


def test_summary_tolerates_missing_firewall_object():
    summary = get_network_summary(_FakeRouter({"firewall_zones": OBJECT_NOT_FOUND}))
    assert summary["firewall_zones"] == {}


def test_summary_tolerates_missing_resources_object():
    summary = get_network_summary(_FakeRouter({"resources": OBJECT_NOT_FOUND}))
    assert summary["resources"] == {}


def test_summary_tolerates_all_optional_objects_missing():
    """The real single-box worst case: wireless + dhcp + firewall + resources
    all absent. Summary must still be a complete 200-shaped dict and the LLM
    describer must not raise on the degraded sections."""
    errors = {k: OBJECT_NOT_FOUND for k in ("wireless", "dhcp_leases", "firewall_zones", "resources")}
    summary = get_network_summary(_FakeRouter(errors))

    assert summary["wireless"] == {}
    assert summary["dhcp_leases"] == []
    assert summary["firewall_zones"] == {}
    assert summary["resources"] == {}
    # lan/wan still present (interface handling untouched)
    assert summary["lan"]["present"] is True
    assert summary["system"]["hostname"] == "droplet-sys"

    # describe_network_for_llm reads resources.get(...) and iterates leases —
    # must degrade cleanly, not raise.
    text = describe_network_for_llm(_FakeRouter(errors))
    assert "Uptime: 0 hours" in text
    assert "Connected devices (DHCP): 0" in text


# ---------------------------------------------------------------------------
# The numeric not-found / no-data codes degrade too (per-object NOT_FOUND)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("code", [UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA])
def test_summary_tolerates_numeric_not_found_codes(code):
    errors = {k: UbusError(code) for k in ("wireless", "dhcp_leases", "firewall_zones", "resources")}
    summary = get_network_summary(_FakeRouter(errors))
    assert summary["wireless"] == {}
    assert summary["dhcp_leases"] == []
    assert summary["firewall_zones"] == {}
    assert summary["resources"] == {}


# ---------------------------------------------------------------------------
# Genuine faults still surface — only "not present" degrades
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("section", ["wireless", "dhcp_leases", "firewall_zones", "resources"])
def test_summary_reraises_permission_denied(section):
    """An auth/permission failure is a real fault, not a deployment shape —
    it must propagate, not be masked as an empty section."""
    err = UbusError(UBUS_STATUS_PERMISSION_DENIED, "Access denied")
    with pytest.raises(UbusError):
        get_network_summary(_FakeRouter({section: err}))


@pytest.mark.parametrize("section", ["wireless", "dhcp_leases", "firewall_zones", "resources"])
def test_summary_reraises_transport_loss(section):
    """A total transport loss (router unreachable) must propagate so a genuinely
    offline router surfaces as offline upstream, not as fake-empty sections."""
    with pytest.raises(ConnectionLost):
        get_network_summary(_FakeRouter({section: ConnectionLost("router down")}))


def test_summary_reraises_unrelated_minus_one_error():
    """A code -1 UbusError whose message is NOT the object-absent signal
    (e.g. 'Empty result' from the low-level client) is a real fault and must
    propagate — the degrade path keys on the not-found class, not on code -1 alone."""
    with pytest.raises(UbusError):
        get_network_summary(_FakeRouter({"wireless": UbusError(-1, "Empty result")}))


def test_summary_does_not_degrade_missing_system_board():
    """`system` (board_info) is a core object on every OpenWrt build; its absence
    means a genuinely broken router, not a deployment shape. It is intentionally
    NOT in the degrade set, so it propagates."""
    with pytest.raises(UbusError):
        get_network_summary(_FakeRouter({"system": OBJECT_NOT_FOUND}))


# ---------------------------------------------------------------------------
# Route-level: GET /network/summary stays 200 on the minimal single-box
# ---------------------------------------------------------------------------
def test_network_summary_route_stays_200_with_objects_absent(connected_client, mock_router):
    """End-to-end through the FastAPI route: with wireless/dhcp/firewall/resources
    ubus objects absent (the live single-box shape), `/network/summary` returns 200
    with a complete dict — not the 500 that made the dashboard read router OFFLINE.

    Drives the real `get_network_summary` over a router whose optional sections
    raise `UbusError(-1, "Object not found")`, with the interface path returning a
    real (shape-agnostic) dict.
    """
    mock_router.network.get_all_interface_statuses.return_value = {
        "lan": {**_LAN, "present": True},
        "wan": {"up": False, "present": False, "ipv4-address": []},
    }
    mock_router.system.resource_info.side_effect = OBJECT_NOT_FOUND
    mock_router.wireless.status.side_effect = OBJECT_NOT_FOUND
    mock_router.dhcp.active_leases.side_effect = OBJECT_NOT_FOUND
    mock_router.firewall.get_zones.side_effect = OBJECT_NOT_FOUND
    # board_info already returns a real dict from the conftest mock_router fixture.

    resp = connected_client.get(
        "/network/summary",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 200
    body = resp.json()
    # Complete shape, degraded sections empty.
    assert set(body) >= {
        "system", "resources", "lan", "wan", "wireless", "dhcp_leases", "firewall_zones",
    }
    assert body["resources"] == {}
    assert body["wireless"] == {}
    assert body["dhcp_leases"] == []
    assert body["firewall_zones"] == {}
    assert body["lan"]["present"] is True
    assert body["system"]["hostname"] == "test-router"


# ---------------------------------------------------------------------------
# Route-level over the REAL interface loop: the `wan` ubus OBJECT is absent
# ---------------------------------------------------------------------------
# The exact 192.168.1.87 single-box trigger: `ubus list` has
# `network.interface.lan` + `network.interface.loopback` but NO
# `network.interface.wan`. `ubus call network.interface.wan status` → top-level
# JSON-RPC error → the SDK raises `UbusError(-1, "Object not found")` (a whole
# missing object, code -1 — NOT the numeric NOT_FOUND). The interface loop was
# only catching numeric NOT_FOUND, so it re-raised → 500 on BOTH
# `/network/interfaces` and `/network/summary` (which calls the loop first).
#
# Unlike `test_network_summary_route_stays_200_with_objects_absent` above (which
# stubs `get_all_interface_statuses.return_value`, bypassing the loop entirely),
# these drive the REAL `NetworkApi.get_all_interface_statuses` via a router whose
# `_call` raises the missing-object shape for `network.interface.wan` — i.e. they
# would 500 against the un-fixed loop, exactly as the live box did.
OBJECT_NOT_FOUND_CALL = UbusError(-1, "Object not found")

_LAN_LIVE = {
    "up": True, "available": True, "device": "br-lan", "proto": "static",
    "ipv4-address": [{"address": "192.168.20.1", "mask": 24}],
}


class _SingleBoxCallRouter:
    """Minimal router whose `_call` mimics the single-box ubus surface: `lan`
    answers live, `wan` is a whole missing OBJECT (-1 "Object not found")."""

    def _call(self, obj, method, args=None):
        if obj == "network.interface.lan":
            return dict(_LAN_LIVE)
        if obj == "network.interface.wan":
            raise OBJECT_NOT_FOUND_CALL
        raise AssertionError(f"unexpected ubus call {obj}.{method}")


def test_network_interfaces_route_stays_200_with_wan_object_absent(connected_client, mock_router):
    """`GET /network/interfaces` returns 200 (not the live 500) when the real
    interface loop hits a missing `wan` OBJECT — lan present, wan degraded to a
    present:False stub."""
    mock_router.network = NetworkApi(_SingleBoxCallRouter())

    resp = connected_client.get(
        "/network/interfaces",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["lan"]["present"] is True
    assert body["lan"]["up"] is True
    assert body["wan"] == interface_stub(present=False)


def test_network_summary_route_stays_200_with_wan_object_absent(connected_client, mock_router):
    """`GET /network/summary` returns 200 over the REAL interface loop when `wan`
    is an absent OBJECT. `get_network_summary` calls `get_all_interface_statuses`
    FIRST, so a re-raise there 500s the whole summary before any `_section_or`
    guard runs — this is why guarding only the optional sections wasn't enough.
    The optional sections are also absent here (full single-box shape)."""
    mock_router.network = NetworkApi(_SingleBoxCallRouter())
    mock_router.system.resource_info.side_effect = OBJECT_NOT_FOUND_CALL
    mock_router.wireless.status.side_effect = OBJECT_NOT_FOUND_CALL
    mock_router.dhcp.active_leases.side_effect = OBJECT_NOT_FOUND_CALL
    mock_router.firewall.get_zones.side_effect = OBJECT_NOT_FOUND_CALL
    # board_info returns a real dict from the conftest mock_router fixture.

    resp = connected_client.get(
        "/network/summary",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert set(body) >= {
        "system", "resources", "lan", "wan", "wireless", "dhcp_leases", "firewall_zones",
    }
    assert body["lan"]["present"] is True
    assert body["wan"] == interface_stub(present=False)
    # optional sections degraded, core system still present
    assert body["resources"] == {}
    assert body["wireless"] == {}
    assert body["dhcp_leases"] == []
    assert body["firewall_zones"] == {}
    assert body["system"]["hostname"] == "test-router"
