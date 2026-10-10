"""WARP-3883 — the box follows an AP by its MAC, not by a cached address.

Live 2026-10-09: the edge router was upgraded (lease table wiped), the AP
rebooted and came back on a new pool address (.180 -> .242). The AP announced
.242 correctly, but the ROUTER's umdns cache kept answering .180 for many
minutes, so pairing read AP_UNREACHABLE, /aps/{mac}/wireless 502'd and
/aps/discovered fed .180 to the orchestrator.

These tests pin the resolver every AP-direct route now dials through
(`_current_ap_ip`) and the overlay /aps/discovered + /fabric/members report
through (`_with_current_ips`):

  * the router's active DHCP lease for the MAC wins over a stale mDNS record;
  * no lease (static-IP AP) -> a host hint naming exactly one address, then
    mDNS; an ambiguous hint (stale neighbour entry) is not an answer;
  * a lease for another MAC is never used; MAC case / separators don't matter;
  * only addresses inside the router's `lan` subnet count: a lease or hint on
    another pool (the isolated cameras VLAN) never receives the fleet-wide AP
    credential, and an unreadable LAN subnet trusts no lease or hint at all;
  * a lease or hint read that fails degrades to the next source, never an error;
  * an mDNS/lease disagreement is logged once and asks umdns to refresh once.

Route-level coverage of the same bug lives next to each route's own harness
(test_ap_pairing, test_aps_wireless, test_aps_direct).
"""

from __future__ import annotations

import logging
from typing import Optional
from unittest.mock import MagicMock

import pytest

import main
from droplet_openwrt_sdk import ConnectionLost, UbusError

AUTH = {"Authorization": "Bearer pytest-fake-token"}
MAC = "80:EA:0B:39:AE:23"  # the lab AP
OTHER_MAC = "80:EA:0B:39:AE:24"
STALE_IP = "192.168.9.180"  # what the router's umdns cache kept answering
LEASE_IP = "192.168.9.242"  # the AP's current DHCP lease
CAMERA_IP = "192.168.100.57"  # the isolated cameras pool (/network/subnets/cameras/setup default)
LAN_STATUS = {"device": "br-lan", "ipv4-address": [{"address": "192.168.9.1", "mask": 24}]}


def _lease(mac: str = MAC.lower(), ip: str = LEASE_IP, expires=3600) -> dict:
    return {"macaddr": mac, "ipaddr": ip, "hostname": "droplet-ap", "expires": expires}


def _router(leases=None, hints=None, mdns: Optional[str] = STALE_IP) -> MagicMock:
    """Just the router surfaces the resolver reads. `ap` is spec'd like the
    real `ApApi` — no mock `get` — so the last source is the umdns browse."""
    r = MagicMock(name="router")
    r.network.interface_status.return_value = LAN_STATUS
    r.dhcp.active_leases.return_value = [] if leases is None else leases
    r.dhcp.host_hints.return_value = {} if hints is None else hints
    r.ap = MagicMock(spec=["browse_discovered"])
    r.ap.browse_discovered.return_value = (
        [{"mac": MAC.lower(), "last_ip": mdns}] if mdns else []
    )
    r._call.return_value = {}
    return r


@pytest.fixture(autouse=True)
def _fresh_log_dedupe(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "_stale_mdns_noted", {})


def _umdns_updates(r: MagicMock) -> int:
    return sum(1 for c in r._call.call_args_list if c.args[:2] == ("umdns", "update"))


# ---------------------------------------------------------------------------
# 1. `_current_ap_ip` — what every AP-direct route dials
# ---------------------------------------------------------------------------
class TestCurrentApIp:
    def test_the_lease_beats_a_stale_mdns_record(self) -> None:
        r = _router(leases=[_lease()])
        assert main._current_ap_ip(r, MAC) == LEASE_IP
        # A lease hit is the whole answer: no hint read, no umdns round trip.
        r.dhcp.host_hints.assert_not_called()
        r.ap.browse_discovered.assert_not_called()

    def test_a_lease_for_another_mac_is_never_used(self) -> None:
        r = _router(leases=[_lease(mac=OTHER_MAC.lower(), ip="192.168.9.99")])
        assert main._current_ap_ip(r, MAC) == STALE_IP

    @pytest.mark.parametrize(
        "lease_mac",
        ["80:ea:0b:39:ae:23", "80:EA:0B:39:AE:23", "80-ea-0b-39-ae-23", " 80:Ea:0b:39:aE:23 "],
    )
    @pytest.mark.parametrize("asked", ["80:EA:0B:39:AE:23", "80:ea:0b:39:ae:23"])
    def test_mac_case_and_separators_do_not_matter(self, lease_mac: str, asked: str) -> None:
        r = _router(leases=[_lease(mac=lease_mac)])
        assert main._current_ap_ip(r, asked) == LEASE_IP

    @pytest.mark.parametrize("expires", [0, -5])
    def test_an_expired_lease_is_not_the_current_address(self, expires) -> None:
        r = _router(leases=[_lease(expires=expires)])
        assert main._current_ap_ip(r, MAC) == STALE_IP

    @pytest.mark.parametrize("expires", [False, None])
    def test_a_lease_without_an_expiry_counts(self, expires) -> None:
        # luci reports `false` for an infinite lease; the mock carries none.
        r = _router(leases=[_lease(expires=expires)])
        assert main._current_ap_ip(r, MAC) == LEASE_IP

    def test_two_leases_for_one_mac_pick_the_one_with_most_time_left(self) -> None:
        r = _router(leases=[_lease(ip=STALE_IP, expires=30), _lease(ip=LEASE_IP, expires=40000)])
        assert main._current_ap_ip(r, MAC) == LEASE_IP
        r = _router(leases=[_lease(ip=LEASE_IP, expires=40000), _lease(ip=STALE_IP, expires=30)])
        assert main._current_ap_ip(r, MAC) == LEASE_IP

    def test_no_lease_falls_to_an_unambiguous_host_hint(self) -> None:
        # A static-IP AP never holds a lease; the neighbour table still knows it.
        r = _router(hints={MAC: {"ipaddrs": ["192.168.9.7"], "name": "droplet-ap"}})
        assert main._current_ap_ip(r, MAC) == "192.168.9.7"
        r.ap.browse_discovered.assert_not_called()

    def test_hint_keys_and_older_shapes_are_tolerated(self) -> None:
        r = _router(hints={"80-ea-0b-39-ae-23": {"ipv4": "192.168.9.7"}})
        assert main._current_ap_ip(r, MAC) == "192.168.9.7"

    def test_an_ambiguous_hint_is_not_an_answer(self) -> None:
        # The neighbour table kept the old entry next to the new one.
        r = _router(hints={MAC.lower(): {"ipaddrs": ["192.168.9.7", "192.168.9.8"]}})
        assert main._current_ap_ip(r, MAC) == STALE_IP
        r.ap.browse_discovered.assert_called_once()

    def test_a_hint_for_another_mac_is_never_used(self) -> None:
        r = _router(hints={OTHER_MAC: {"ipaddrs": ["192.168.9.99"]}})
        assert main._current_ap_ip(r, MAC) == STALE_IP

    @pytest.mark.parametrize("exc", [UbusError(6, "Permission denied"), RuntimeError("bad shape")])
    def test_a_failing_lease_read_falls_back_without_an_error(self, exc) -> None:
        r = _router()
        r.dhcp.active_leases.side_effect = exc
        assert main._current_ap_ip(r, MAC) == STALE_IP
        r.dhcp.host_hints.side_effect = exc
        assert main._current_ap_ip(r, MAC) == STALE_IP

    def test_a_failing_lease_read_still_uses_the_hint(self) -> None:
        r = _router(hints={MAC: {"ipaddrs": ["192.168.9.7"]}})
        r.dhcp.active_leases.side_effect = UbusError(6, "Permission denied")
        assert main._current_ap_ip(r, MAC) == "192.168.9.7"

    def test_unexpected_lease_shapes_are_ignored(self) -> None:
        r = _router(leases=["junk", {"macaddr": MAC}, {"ipaddr": LEASE_IP}, {"macaddr": "", "ipaddr": "1.2.3.4"}])
        assert main._current_ap_ip(r, MAC) == STALE_IP
        r = _router()
        r.dhcp.active_leases.return_value = MagicMock()  # an unconfigured double
        r.dhcp.host_hints.return_value = MagicMock()
        assert main._current_ap_ip(r, MAC) == STALE_IP

    def test_a_dead_router_session_ends_the_walk_without_raising(self) -> None:
        r = _router(leases=[_lease()])
        r.dhcp.active_leases.side_effect = ConnectionLost("router gone")
        assert main._current_ap_ip(r, MAC) is None
        # Same session for every source: don't sit through the timeout again.
        r.dhcp.host_hints.assert_not_called()
        r.ap.browse_discovered.assert_not_called()

    def test_nothing_knows_the_ap(self) -> None:
        assert main._current_ap_ip(_router(mdns=None), MAC) is None

    # -- the LAN is the trust boundary: no other pool's address is the AP's --
    def test_a_lease_on_another_pool_is_never_the_aps_address(self) -> None:
        # A cameras-VLAN host holding the AP's MAC on a fresher lease must not
        # receive the fleet-wide AP credential; the LAN lease still answers.
        r = _router(leases=[_lease(ip=CAMERA_IP, expires=86000), _lease(expires=30)])
        assert main._current_ap_ip(r, MAC) == LEASE_IP
        r = _router(leases=[_lease(ip=CAMERA_IP)])
        assert main._current_ap_ip(r, MAC) == STALE_IP
        r.ap.browse_discovered.assert_called_once()

    def test_hint_addresses_off_the_lan_are_dropped_before_counting(self) -> None:
        r = _router(hints={MAC: {"ipaddrs": [CAMERA_IP, "192.168.9.7"]}})
        assert main._current_ap_ip(r, MAC) == "192.168.9.7"
        r = _router(hints={MAC: {"ipaddrs": [CAMERA_IP]}})
        assert main._current_ap_ip(r, MAC) == STALE_IP

    def test_every_lan_address_counts(self) -> None:
        r = _router(leases=[_lease(ip="10.20.0.9")])
        r.network.interface_status.return_value = {"ipv4-address": [
            {"address": "192.168.9.1", "mask": 24}, {"address": "10.20.0.1", "mask": 16},
        ]}
        assert main._current_ap_ip(r, MAC) == "10.20.0.9"
        r.network.interface_status.assert_called_once_with("lan")

    @pytest.mark.parametrize("status", [
        UbusError(6, "Permission denied"),
        {"ipv4-address": []},
        {"ipv4-address": [{"address": "192.168.9.1"}]},
        {"ipv4-address": ["junk", {"address": "not-an-ip", "mask": 24}]},
        None,
    ])
    def test_an_unknown_lan_subnet_trusts_no_lease_or_hint(self, status) -> None:
        r = _router(leases=[_lease()], hints={MAC: {"ipaddrs": [LEASE_IP]}})
        if isinstance(status, Exception):
            r.network.interface_status.side_effect = status
        else:
            r.network.interface_status.return_value = status
        assert main._current_ap_ip(r, MAC) == STALE_IP  # umdns, as before WARP-3883
        r.dhcp.active_leases.assert_not_called()
        r.dhcp.host_hints.assert_not_called()

    def test_a_dead_router_on_the_lan_read_ends_the_walk(self) -> None:
        r = _router(leases=[_lease()])
        r.network.interface_status.side_effect = ConnectionLost("router gone")
        assert main._current_ap_ip(r, MAC) is None
        r.dhcp.active_leases.assert_not_called()
        r.ap.browse_discovered.assert_not_called()

    def test_the_mock_seed_is_still_the_last_source(self) -> None:
        r = _router()
        r.ap = MagicMock()
        r.ap.get.return_value = {"mac": MAC, "last_ip": "10.0.0.5"}
        assert main._current_ap_ip(r, MAC) == "10.0.0.5"


# ---------------------------------------------------------------------------
# 2. `_with_current_ips` — what /aps/discovered and /fabric/members report
# ---------------------------------------------------------------------------
def _record(mac: str = MAC.lower(), ip: Optional[str] = STALE_IP, **extra) -> dict:
    return {"mac": mac, "last_ip": ip, "model": "Zyxel NWA50BE", "serial": "S1", **extra}


class TestWithCurrentIps:
    def test_last_ip_follows_the_lease_and_the_shape_is_kept(self) -> None:
        r = _router(leases=[_lease()])
        [rec] = main._with_current_ips(r, [_record()])
        assert rec == _record(ip=LEASE_IP)

    def test_a_disagreement_is_logged_once_and_asks_umdns_once(self, caplog) -> None:
        r = _router(leases=[_lease()])
        with caplog.at_level(logging.INFO, logger="droplet.routing"):
            main._with_current_ips(r, [_record()])
            main._with_current_ips(r, [_record()])
            main._with_current_ips(r, [_record()])
        noted = [rec for rec in caplog.records if "mDNS still reports" in rec.getMessage()]
        assert len(noted) == 1 and noted[0].levelno == logging.INFO
        line = noted[0].getMessage()
        assert STALE_IP in line and LEASE_IP in line and "DHCP lease" in line
        assert _umdns_updates(r) == 1

    def test_a_new_disagreement_after_agreement_is_reported_again(self, caplog) -> None:
        r = _router(leases=[_lease()])
        with caplog.at_level(logging.INFO, logger="droplet.routing"):
            main._with_current_ips(r, [_record()])
            main._with_current_ips(r, [_record(ip=LEASE_IP)])  # umdns caught up
            main._with_current_ips(r, [_record()])  # ... and went stale again
        assert sum("mDNS still reports" in rec.getMessage() for rec in caplog.records) == 2
        assert _umdns_updates(r) == 2

    def test_agreement_and_unknown_aps_are_left_alone(self, caplog) -> None:
        r = _router(leases=[_lease()])
        other = _record(mac=OTHER_MAC, ip="192.168.9.50")
        with caplog.at_level(logging.INFO, logger="droplet.routing"):
            out = main._with_current_ips(r, [_record(ip=LEASE_IP), other])
        assert out == [_record(ip=LEASE_IP), other]
        assert not any("mDNS still reports" in rec.getMessage() for rec in caplog.records)
        assert _umdns_updates(r) == 0

    def test_a_record_without_an_address_gets_the_lease_silently(self, caplog) -> None:
        r = _router(leases=[_lease()])
        with caplog.at_level(logging.INFO, logger="droplet.routing"):
            [rec] = main._with_current_ips(r, [_record(ip=None)])
        assert rec["last_ip"] == LEASE_IP
        assert _umdns_updates(r) == 0

    def test_no_lease_uses_an_unambiguous_hint_read_once(self) -> None:
        r = _router(hints={MAC: {"ipaddrs": ["192.168.9.7"]}})
        out = main._with_current_ips(r, [_record(), _record(mac=OTHER_MAC, ip="192.168.9.50")])
        assert [rec["last_ip"] for rec in out] == ["192.168.9.7", "192.168.9.50"]
        r.dhcp.host_hints.assert_called_once()

    def test_a_lease_hit_needs_no_hint_read(self) -> None:
        r = _router(leases=[_lease()])
        main._with_current_ips(r, [_record()])
        r.dhcp.host_hints.assert_not_called()

    def test_non_ap_fabric_members_keep_their_address(self) -> None:
        # The switch holds a lease too; only the AP member is this resolver's.
        r = _router(leases=[_lease(mac="70:49:a2:77:64:1a", ip="192.168.9.3"), _lease()])
        switch = {"role": "switch", "mac": "70:49:a2:77:64:1a", "last_ip": "192.168.9.2"}
        ap = {"role": "ap", "mac": MAC.lower(), "last_ip": STALE_IP}
        assert main._with_current_ips(r, [switch, ap]) == [switch, {**ap, "last_ip": LEASE_IP}]

    def test_a_dead_router_session_leaves_the_records_as_they_are(self) -> None:
        r = _router()
        r.dhcp.active_leases.side_effect = ConnectionLost("router gone")
        records = [_record()]
        assert main._with_current_ips(r, records) == records

    def test_a_failing_lease_read_leaves_the_records_as_they_are(self) -> None:
        r = _router()
        r.dhcp.active_leases.side_effect = UbusError(6, "Permission denied")
        assert main._with_current_ips(r, [_record()]) == [_record()]

    def test_a_lease_on_another_pool_is_never_reported(self, caplog) -> None:
        r = _router(leases=[_lease(ip=CAMERA_IP)])
        with caplog.at_level(logging.INFO, logger="droplet.routing"):
            assert main._with_current_ips(r, [_record()]) == [_record()]
        assert not any("mDNS still reports" in rec.getMessage() for rec in caplog.records)
        assert _umdns_updates(r) == 0

    def test_nothing_to_report_costs_no_router_call(self) -> None:
        r = _router(leases=[_lease()])
        assert main._with_current_ips(r, []) == []
        r.dhcp.active_leases.assert_not_called()


# ---------------------------------------------------------------------------
# 3. The discovery endpoints report the corrected address
# ---------------------------------------------------------------------------
class TestDiscoveryEndpoints:
    @pytest.fixture(autouse=True)
    def _lan(self, mock_router) -> None:
        mock_router.network.interface_status.return_value = LAN_STATUS

    def test_aps_discovered_reports_the_lease_address(self, connected_client, mock_router, caplog) -> None:
        del mock_router.ap.discovered  # the real ApApi: umdns browse
        mock_router.ap.browse_discovered.return_value = [_record()]
        mock_router.dhcp.active_leases.return_value = [_lease()]
        with caplog.at_level(logging.INFO, logger="droplet.routing"):
            resp = connected_client.get("/aps/discovered", headers=AUTH)
            again = connected_client.get("/aps/discovered", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"discovered": [_record(ip=LEASE_IP)]}
        assert again.json() == resp.json()
        assert sum("mDNS still reports" in rec.getMessage() for rec in caplog.records) == 1
        assert _umdns_updates(mock_router) == 1

    def test_aps_discovered_survives_a_failing_lease_read(self, connected_client, mock_router) -> None:
        del mock_router.ap.discovered
        mock_router.ap.browse_discovered.return_value = [_record()]
        mock_router.dhcp.active_leases.side_effect = UbusError(6, "Permission denied")
        resp = connected_client.get("/aps/discovered", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"discovered": [_record()]}

    def test_fabric_members_ap_follows_the_lease(self, connected_client, mock_router) -> None:
        mock_router.fabric.browse_members.return_value = [
            {"role": "ap", "mac": MAC.lower(), "last_ip": STALE_IP, "hostname": "droplet-ap"},
            {"role": "switch", "mac": "70:49:a2:77:64:1a", "last_ip": "192.168.9.2"},
        ]
        mock_router.network.device_status.return_value = {}  # no router member
        mock_router.dhcp.active_leases.return_value = [_lease()]
        resp = connected_client.get("/fabric/members", headers=AUTH)
        assert resp.status_code == 200, resp.text
        by_role = {m["role"]: m for m in resp.json()["members"]}
        assert by_role["ap"]["last_ip"] == LEASE_IP
        assert by_role["switch"]["last_ip"] == "192.168.9.2"
