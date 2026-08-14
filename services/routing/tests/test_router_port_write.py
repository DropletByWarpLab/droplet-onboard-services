"""Enable / disable a physical router jack — WARP-1907.

The port map has been read-only since WARP-1866. This is its write half, to the
parity the managed switch has had since WARP-1674 (click a port, get a drawer,
confirm, apply).

The mechanism
-------------
netifd has no "shut this jack" ubus call. A jack is administratively downed by a
uci ``config device`` section carrying ``option enabled '0'``, keyed by ``option
name '<netdev>'``. Verified against netifd's own source at the revision the
shipped router runs (``netifd 2025.05.23~7901e66c``, OpenWrt 25.12.5):
``device.c`` declares ``[DEV_ATTR_ENABLED] = { .name = "enabled", .type =
BLOBMSG_TYPE_BOOL }``, ``device_init_settings()`` turns a false value into
``device_set_disabled(dev, true)``, and ``device_refresh_present()`` then forces
``present = false`` **regardless of** ``sys_present`` — so a physically-present
DSA jack really does go down, and its bridge drops it.

🔴 **Most jacks have no ``config device`` section at all.** On the live RB5009
only three exist — ``br_lan`` (the bridge), ``guest_dev`` (the VLAN) and
``wan_dev`` (a bare ``config device { option name 'p1' }``). p2–p8 are realised
by netifd from bridge membership alone. So the write must CREATE the section
when absent, and it must key it by the *netdev* name: the section name and the
netdev name are different strings (``config device 'br_lan'`` creates
``br-lan``), which is why :func:`device_section_name` matches on ``option name``
and never on the section name.

The safety asymmetry these tests exist to pin
---------------------------------------------
``safe_apply``'s 60s auto-rollback only fires when the router stops answering
the routing service **over the LAN**. That splits the blast radius three ways,
and a single "does this jack carry something important?" test would get two of
them wrong:

===========================  =========  ==================  ==================
Jack                         Self-cut?  safe_apply reverts  Guard
===========================  =========  ==================  ==================
WAN                          no         **NO** — the probe   409 ``WAN_PORT``
                                        succeeds and the
                                        change is confirmed
management network + link    yes        yes, after 60s       409 ``MANAGEMENT_PORT``
management network, no link  no         n/a                  allowed
===========================  =========  ==================  ==================

That last row is the one that makes this worth a test file: on the RB5009 EVERY
LAN jack is a ``br-lan`` member, so a guard that asked only "does this carry
``lan``?" would demand a force-confirm to disable a bare, empty p7. The guard
gates on ``link_up`` too — an empty jack that merely appears in a bridge's
config is carrying nothing.

And the copy differs because the *fact* differs: the management refusal may
promise an automatic revert, the WAN refusal must not.
"""

from __future__ import annotations

import copy
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import (
    ConnectionLost,
    DeviceWriteNotApplied,
    NetworkApi,
    UbusError,
)
from router_ports import (
    DeviceSectionNameExhausted,
    annotate_write_guards,
    derive_ports,
    device_section_enabled,
    device_section_name,
    disable_guard,
    new_device_section_name,
)

from tests.fixtures_rb5009 import BOARD_JSON, DEVICE_STATUS, UCI_NETWORK

AUTH = {"authorization": "Bearer pytest-fake-token"}

#: The shipped default of DROPLET_MGMT_INTERFACES, as a predicate. Tests pass
#: this explicitly rather than importing main's env-bound closure so a guard can
#: never pass because the environment happened to agree with it.
IS_MGMT = lambda name: name.strip().lower() in ("lan", "mgmt")  # noqa: E731


def rb5009_ports() -> list[dict]:
    return derive_ports(BOARD_JSON, UCI_NETWORK, DEVICE_STATUS)


def port(port_id: str) -> dict:
    for p in rb5009_ports():
        if p["id"] == port_id:
            return p
    raise AssertionError(f"no such port in the RB5009 fixture: {port_id}")


# ---------------------------------------------------------------------------
# uci `config device` resolution — the create-when-absent problem
# ---------------------------------------------------------------------------
class TestDeviceSectionResolution:
    def test_finds_an_existing_section_by_its_NETDEV_name(self) -> None:
        """`config device 'wan_dev'` carries `option name 'p1'`. Looking p1 up
        must return the SECTION name, which is a different string."""
        assert device_section_name(UCI_NETWORK, "p1") == "wan_dev"

    def test_finds_the_bridge_section_whose_name_is_dashed(self) -> None:
        """The trap `router_ports` documents: section `br_lan` → netdev `br-lan`."""
        assert device_section_name(UCI_NETWORK, "br-lan") == "br_lan"

    def test_returns_none_for_a_jack_with_no_section(self) -> None:
        """p2–p8 are bridge members with no `config device` of their own — the
        common case, and the reason the write has to be able to CREATE one."""
        for jack in ("p2", "p5", "p8"):
            assert device_section_name(UCI_NETWORK, jack) is None

    def test_new_section_name_is_deterministic_and_uci_safe(self) -> None:
        assert new_device_section_name("p5", UCI_NETWORK) == "port_p5"
        # uci section names are [A-Za-z0-9_] only — a dashed/dotted netdev name
        # cannot be used verbatim.
        assert new_device_section_name("br-lan.30", UCI_NETWORK) == "port_br_lan_30"

    def test_new_section_name_never_collides_with_an_existing_section(self) -> None:
        """Section names share ONE namespace per config across types, so a name
        already taken by an unrelated section would clobber it on `uci add`."""
        uci = copy.deepcopy(UCI_NETWORK)
        uci["values"]["port_p5"] = {".type": "interface", ".name": "port_p5"}
        assert new_device_section_name("p5", uci) == "port_p5_2"

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("0", False), ("off", False), ("false", False), ("no", False),
            ("1", True), ("on", True), ("true", True), ("yes", True),
        ],
    )
    def test_reads_every_uci_boolean_spelling(self, raw: str, expected: bool) -> None:
        uci = {"values": {"d": {".type": "device", ".name": "d", "name": "p5", "enabled": raw}}}
        assert device_section_enabled(uci, "p5") is expected

    def test_absent_option_means_enabled(self) -> None:
        """netifd defaults `enabled` to true. An absent option is not `None` —
        it is a positive claim that the jack is up."""
        assert device_section_enabled(UCI_NETWORK, "p1") is True

    def test_absent_section_means_enabled(self) -> None:
        assert device_section_enabled(UCI_NETWORK, "p5") is True


# ---------------------------------------------------------------------------
# The three-way guard
# ---------------------------------------------------------------------------
class TestDisableGuard:
    def test_wan_jack_is_guarded(self) -> None:
        guard = disable_guard(port("p1"), IS_MGMT)
        assert guard is not None
        assert guard["code"] == "WAN_PORT"

    def test_wan_refusal_never_promises_an_automatic_revert(self) -> None:
        """The load-bearing copy rule. safe_apply probes the router over the
        LAN; cutting the WAN leaves that probe succeeding, so `uci.confirm()`
        runs and the change is PERMANENT. Telling the user it reverts itself
        would be false at exactly the moment it matters."""
        reason = disable_guard(port("p1"), IS_MGMT)["reason"].lower()
        assert "revert" not in reason and "automatic" not in reason
        assert "minute" not in reason

    def test_a_live_management_jack_is_guarded(self) -> None:
        """p2 carries `lan` AND has carrier — this is the jack the dashboard
        could be reached through."""
        assert port("p2")["link_up"] is True
        guard = disable_guard(port("p2"), IS_MGMT)
        assert guard is not None
        assert guard["code"] == "MANAGEMENT_PORT"

    def test_management_refusal_promises_the_automatic_revert(self) -> None:
        """Here it IS true: cutting this jack cuts the routing service's own
        path to the router, the probe fails, and OpenWrt reverts after 60s."""
        reason = disable_guard(port("p2"), IS_MGMT)["reason"].lower()
        assert "minute" in reason

    def test_an_empty_management_jack_is_NOT_guarded(self) -> None:
        """🔴 The row that makes the guard usable. On the RB5009 every LAN jack
        is a br-lan member — p2 through p8 all report `networks: [lan, guest]`
        — so gating on "carries lan" alone would demand a force-confirm to
        disable a bare, empty p7. Five of the router's eight jacks are exactly
        that: in the bridge's config, with nothing plugged in."""
        for jack in ("p4", "p5", "p6", "p7", "p8"):
            assert port(jack)["networks"] == ["lan", "guest"], jack
            assert port(jack)["link_up"] is False, jack
            assert disable_guard(port(jack), IS_MGMT) is None, jack

    def test_link_state_is_the_ONLY_thing_separating_p3_from_p4(self) -> None:
        """The same networks, the same role, opposite verdicts — the whole
        point of putting `link_up` in the guard. p3 has a cable in it; p4 is the
        identical jack with nothing plugged in."""
        assert port("p3")["networks"] == port("p4")["networks"]
        assert port("p3")["role"] == port("p4")["role"]
        assert port("p3")["link_up"] is True and port("p4")["link_up"] is False
        assert disable_guard(port("p3"), IS_MGMT)["code"] == "MANAGEMENT_PORT"
        assert disable_guard(port("p4"), IS_MGMT) is None

    def test_wan_wins_over_management_when_a_jack_is_both(self) -> None:
        """A jack carrying wan AND a live management network gets the WAN
        refusal: it is the one with no automatic undo, so it is the one the
        copy has to describe."""
        both = {**port("p2"), "networks": ["lan", "wan"], "link_up": True}
        assert disable_guard(both, IS_MGMT)["code"] == "WAN_PORT"

    def test_wan_is_detected_from_the_networks_list_not_the_derived_role(self) -> None:
        """`role` is the FIRST network with a role we recognise, so a jack
        carrying ["lan", "wan"] derives role="lan". Gating on `role` alone would
        wave the WAN jack straight through."""
        trap = {**port("p2"), "networks": ["lan", "wan"], "role": "lan", "link_up": True}
        assert trap["role"] == "lan"
        assert disable_guard(trap, IS_MGMT)["code"] == "WAN_PORT"

    def test_wan6_counts_as_wan(self) -> None:
        p = {**port("p5"), "networks": ["wan6"], "role": "wan"}
        assert disable_guard(p, IS_MGMT)["code"] == "WAN_PORT"

    @pytest.mark.parametrize("jack", ["p1", "p2"])
    def test_reason_says_WHY_and_never_what_to_do_next(self, jack: str) -> None:
        """The drawer renders `reason` as a warning banner at a point where the
        user has confirmed nothing, so an instruction to "confirm again" there is
        telling them to do something nobody has asked. `instruction` is the
        separate field — kept server-side so there is still exactly one source
        of this copy, which is the property that made the WAN/management split
        hold up in the first place."""
        guard = disable_guard(port(jack), IS_MGMT)
        assert "confirm" not in guard["reason"].lower()
        assert guard["instruction"] == "Confirm again to continue."

    def test_the_management_list_is_the_injected_one(self) -> None:
        """DROPLET_MGMT_INTERFACES is env-configurable, so the guard must read
        the deployment's list — not a second hardcoded copy of it."""
        p = {**port("p2"), "networks": ["iot"], "link_up": True}
        assert disable_guard(p, IS_MGMT) is None
        assert disable_guard(p, lambda n: n == "iot")["code"] == "MANAGEMENT_PORT"


# ---------------------------------------------------------------------------
# The guard is published on the READ, so the UI and the write cannot disagree
# ---------------------------------------------------------------------------
class TestAnnotateWriteGuards:
    def test_every_port_carries_a_disable_guard_field(self) -> None:
        annotated = annotate_write_guards(
            {"supported": True, "detail": None, "model": "x", "ports": rb5009_ports()},
            IS_MGMT,
        )
        for p in annotated["ports"]:
            assert "disable_guard" in p

    def test_the_annotation_agrees_with_the_write_guard_port_for_port(self) -> None:
        """The invariant that lets the dashboard render the right confirm copy
        without owning a second copy of the policy."""
        annotated = annotate_write_guards(
            {"supported": True, "detail": None, "model": "x", "ports": rb5009_ports()},
            IS_MGMT,
        )
        for p in annotated["ports"]:
            assert p["disable_guard"] == disable_guard(p, IS_MGMT)

    def test_an_unsupported_map_is_passed_through_untouched(self) -> None:
        unsupported = {"supported": False, "detail": "no map", "model": None, "ports": []}
        assert annotate_write_guards(unsupported, IS_MGMT) == unsupported


# ---------------------------------------------------------------------------
# SDK: NetworkApi.set_device_enabled
# ---------------------------------------------------------------------------
class FakeUci:
    """A uci double that actually holds state.

    A MagicMock would let `set_device_enabled` claim success while staging
    nothing — precisely the failure this ticket is most exposed to — so the SDK
    tests drive a store that records what was written and can be read back.
    """

    def __init__(self, values: dict | None = None) -> None:
        self.values = copy.deepcopy(values if values is not None else UCI_NETWORK["values"])
        self.commits: list[str] = []
        self.adds: list[tuple] = []
        self.sets: list[tuple] = []

    def get(self, config: str, section=None, option=None, type=None):
        assert config == "network"
        return {"values": copy.deepcopy(self.values)}

    def add(self, config: str, type: str, values=None, name=None):
        self.adds.append((config, type, values, name))
        self.values[name] = {".type": type, ".name": name, **(values or {})}

    def set(self, config: str, section: str, values: dict):
        self.sets.append((config, section, values))
        self.values.setdefault(section, {}).update(values)

    def commit(self, config: str):
        self.commits.append(config)


def sdk_router(uci: FakeUci | None = None) -> MagicMock:
    router = MagicMock()
    router.uci = uci or FakeUci()
    return router


class TestSetDeviceEnabled:
    def test_disabling_a_jack_with_no_section_CREATES_one(self) -> None:
        """The common case: p5 is a bare bridge member."""
        uci = FakeUci()
        router = sdk_router(uci)
        result = NetworkApi(router).set_device_enabled("p5", False)

        assert uci.adds == [("network", "device", {"name": "p5", "enabled": "0"}, "port_p5")]
        assert uci.sets == []
        assert result["created_section"] is True
        assert result["section"] == "port_p5"

    def test_the_created_section_carries_the_NETDEV_name(self) -> None:
        """Without `option name`, netifd has no idea which jack the section is
        about and the write is an expensive no-op."""
        uci = FakeUci()
        NetworkApi(sdk_router(uci)).set_device_enabled("p5", False)
        assert uci.values["port_p5"]["name"] == "p5"

    def test_disabling_a_jack_that_HAS_a_section_edits_it_in_place(self) -> None:
        """p1 already has `wan_dev`. Adding a second `config device` naming p1
        would leave two sections fighting over one jack."""
        uci = FakeUci()
        result = NetworkApi(sdk_router(uci)).set_device_enabled("p1", False)
        assert uci.adds == []
        assert uci.sets == [("network", "wan_dev", {"enabled": "0"})]
        assert result["created_section"] is False

    def test_re_enabling_writes_an_explicit_1(self) -> None:
        uci = FakeUci()
        NetworkApi(sdk_router(uci)).set_device_enabled("p1", True)
        assert uci.sets == [("network", "wan_dev", {"enabled": "1"})]

    def test_the_write_rides_safe_apply_with_the_60s_rollback_timer(self) -> None:
        router = sdk_router()
        NetworkApi(router).set_device_enabled("p5", False)
        router.safe_apply.assert_called_once_with(timeout=60)

    def test_the_write_is_committed(self) -> None:
        uci = FakeUci()
        NetworkApi(sdk_router(uci)).set_device_enabled("p5", False)
        assert uci.commits == ["network"]

    def test_it_is_idempotent(self) -> None:
        uci = FakeUci()
        api = NetworkApi(sdk_router(uci))
        api.set_device_enabled("p5", False)
        api.set_device_enabled("p5", False)
        # Second call finds the section it created and edits it rather than
        # adding a duplicate.
        assert len(uci.adds) == 1
        assert uci.sets == [("network", "port_p5", {"enabled": "0"})]

    def test_a_write_that_changes_nothing_RAISES_instead_of_reporting_success(self) -> None:
        """🔴 The worst possible outcome for this feature is a write that looks
        like it worked and moved nothing. After the apply, uci on disk must
        carry the value we asked for; if it doesn't, say so."""
        uci = FakeUci()

        def swallow(config, type, values=None, name=None):
            uci.adds.append((config, type, values, name))  # recorded, not applied

        uci.add = swallow
        with pytest.raises(DeviceWriteNotApplied):
            NetworkApi(sdk_router(uci)).set_device_enabled("p5", False)

    def test_connection_lost_propagates(self) -> None:
        """safe_apply raising ConnectionLost means the rollback timer is running
        — the route turns this into the 503 `rollback_pending`, never a 200."""
        router = sdk_router()
        router.safe_apply.side_effect = ConnectionLost("link cut after apply")
        with pytest.raises(ConnectionLost):
            NetworkApi(router).set_device_enabled("p5", False)


# ---------------------------------------------------------------------------
# Route: POST /network/ports/{port}/enable
# ---------------------------------------------------------------------------
def wire_port_map(mock_router: MagicMock) -> None:
    """Point the mocked router at the live RB5009 payloads so the route's own
    port-map lookup (roster + guard) runs against real hardware shapes."""
    mock_router.network.device_status.return_value = DEVICE_STATUS
    mock_router.uci.get.return_value = UCI_NETWORK
    mock_router.system.board_json.return_value = BOARD_JSON


class TestSetPortEnabledEndpoint:
    def test_disabling_an_empty_jack_dispatches(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/p5/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["port"] == "p5"
        assert body["enabled"] is False
        assert body["operation_id"]
        mock_router.network.set_device_enabled.assert_called_once_with("p5", False)

    def test_enabling_dispatches(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/p5/enable", json={"enabled": True}, headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        mock_router.network.set_device_enabled.assert_called_once_with("p5", True)

    def test_the_wan_jack_is_refused_without_force(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/p1/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "WAN_PORT"
        mock_router.network.set_device_enabled.assert_not_called()

    def test_the_refusal_body_splits_the_reason_from_the_instruction(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        """The orchestrator carries `reason` into the dashboard's escalation
        dialog; `error` keeps both for a caller with one place to put a
        sentence."""
        wire_port_map(mock_router)
        body = connected_client.post(
            "/network/ports/p1/enable", json={"enabled": False}, headers=AUTH,
        ).json()
        assert "confirm" not in body["reason"].lower()
        assert body["instruction"] == "Confirm again to continue."
        assert body["error"] == f"{body['reason']} {body['instruction']}"

    def test_an_exhausted_section_namespace_is_a_typed_409_not_a_500(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        """The route catches only the SDK's own exceptions, so a bare
        ValueError from `new_device_section_name` would surface as an untyped
        500 with nothing the operator could act on."""
        wire_port_map(mock_router)
        mock_router.network.set_device_enabled.side_effect = DeviceSectionNameExhausted(
            "no free name for p5"
        )
        resp = connected_client.post(
            "/network/ports/p5/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "PORT_SECTION_NAME_EXHAUSTED"

    def test_the_wan_jack_proceeds_with_force(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/p1/enable",
            json={"enabled": False, "force": True},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        mock_router.network.set_device_enabled.assert_called_once_with("p1", False)

    def test_a_live_management_jack_is_refused_without_force(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/p2/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "MANAGEMENT_PORT"
        mock_router.network.set_device_enabled.assert_not_called()

    def test_a_live_management_jack_proceeds_with_force(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/p2/enable",
            json={"enabled": False, "force": True},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        mock_router.network.set_device_enabled.assert_called_once_with("p2", False)

    def test_ENABLING_a_guarded_jack_needs_no_force(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        """The guard is about blast radius, and turning a jack back ON has
        none. Requiring force here would make restoring the WAN harder than
        cutting it."""
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/p1/enable", json={"enabled": True}, headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        mock_router.network.set_device_enabled.assert_called_once_with("p1", True)

    def test_an_unknown_jack_is_404_not_a_blind_write(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        """Writing `config device { name 'p99' }` on a router with no p99 would
        stage a section netifd can never realise, and report success."""
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/p99/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["code"] == "PORT_NOT_FOUND"
        mock_router.network.set_device_enabled.assert_not_called()

    def test_a_bridge_is_not_a_jack(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        """br-lan is in `network.device status` and has a `config device`
        section, so it is reachable by name — but it is not on the port map and
        disabling it would take the whole LAN down in one call."""
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/br-lan/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code == 404, resp.text
        mock_router.network.set_device_enabled.assert_not_called()

    def test_a_malformed_port_name_is_rejected_by_the_schema(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.post(
            "/network/ports/..%2Fetc%2Fpasswd/enable",
            json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code in (404, 422), resp.text
        mock_router.network.set_device_enabled.assert_not_called()

    def test_enabled_is_required(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.post("/network/ports/p5/enable", json={}, headers=AUTH)
        assert resp.status_code == 422

    def test_lost_connectivity_surfaces_rollback_pending(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        mock_router.network.set_device_enabled.side_effect = ConnectionLost("cut")
        resp = connected_client.post(
            "/network/ports/p2/enable",
            json={"enabled": False, "force": True},
            headers=AUTH,
        )
        assert resp.status_code == 503, resp.text
        assert resp.json()["rollback_pending"] is True

    def test_a_write_that_did_not_apply_is_reported_as_such(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        mock_router.network.set_device_enabled.side_effect = DeviceWriteNotApplied(
            "uci still reports p5 enabled"
        )
        resp = connected_client.post(
            "/network/ports/p5/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code == 502, resp.text
        assert resp.json()["code"] == "PORT_WRITE_NOT_APPLIED"

    def test_a_ubus_fault_is_not_swallowed(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        mock_router.network.set_device_enabled.side_effect = UbusError(6, "Permission denied")
        resp = connected_client.post(
            "/network/ports/p5/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code >= 400
        assert resp.status_code != 200

    def test_requires_a_bearer_token(self, connected_client: TestClient) -> None:
        resp = connected_client.post("/network/ports/p5/enable", json={"enabled": False})
        assert resp.status_code in (401, 403)

    def test_a_shape_with_no_port_map_degrades_instead_of_500ing(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        """ROUTING_MODE=mock: MockRouter has no `device_status`, so the read
        already answers `supported: false`. The write must answer the same
        limitation honestly — never a 500, and never a fake 200."""
        wire_port_map(mock_router)
        del mock_router.network.device_status
        resp = connected_client.post(
            "/network/ports/p5/enable", json={"enabled": False}, headers=AUTH,
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "PORT_MAP_UNSUPPORTED"
        mock_router.network.set_device_enabled.assert_not_called()


# ---------------------------------------------------------------------------
# The read route publishes the guard
# ---------------------------------------------------------------------------
class TestPortsReadCarriesTheGuard:
    def test_get_ports_annotates_each_jack(
        self, connected_client: TestClient, mock_router: MagicMock
    ) -> None:
        wire_port_map(mock_router)
        resp = connected_client.get("/network/ports", headers=AUTH)
        assert resp.status_code == 200, resp.text
        by_id = {p["id"]: p for p in resp.json()["ports"]}
        assert by_id["p1"]["disable_guard"]["code"] == "WAN_PORT"
        assert by_id["p2"]["disable_guard"]["code"] == "MANAGEMENT_PORT"
        assert by_id["p7"]["disable_guard"] is None

    def test_the_read_uses_the_deployment_management_list(
        self, connected_client: TestClient, mock_router: MagicMock, monkeypatch
    ) -> None:
        """Pins that the route wires `_is_management_interface` in — not a
        second hardcoded lan/mgmt list living in router_ports."""
        wire_port_map(mock_router)
        monkeypatch.setattr(main, "_is_management_interface", lambda n: False)
        resp = connected_client.get("/network/ports", headers=AUTH)
        by_id = {p["id"]: p for p in resp.json()["ports"]}
        assert by_id["p2"]["disable_guard"] is None
        # WAN is not a management interface, so it is unaffected.
        assert by_id["p1"]["disable_guard"]["code"] == "WAN_PORT"
