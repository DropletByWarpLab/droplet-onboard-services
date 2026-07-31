"""LantronixDriver against the VERIFIED WebStaX v1.04.0079 JSON API.

ADR-018 item 10. Every request is served by an in-process httpx.MockTransport
fed the recorded payloads in ``fixtures_webstax`` — NO socket to the real
SM8TAT2SA at 192.168.1.77 (it rate-limits + locks the admin account).

The driver builds its own httpx.AsyncClient inside connect(); to keep the
production interface untouched, each test installs a MockTransport-backed
client on ``driver._client`` and the session cookies the firmware keys on,
exactly as connect() would, then drives the methods directly.
"""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx
import pytest

from drivers.base import AuthenticationError, SwitchAPIError
from drivers.lantronix import LantronixDriver
from tests import fixtures_webstax as fx

pytestmark = pytest.mark.asyncio

_HOST = "192.168.1.77"
_BASE = f"https://{_HOST}:443"


class _Recorder:
    """Records every request the driver makes and routes it to a fixture.

    ``routes`` maps (METHOD, path) -> dict|callable. A callable receives the
    httpx.Request and returns an httpx.Response so a test can assert on the
    POST body / make a read reflect a prior write.
    """

    def __init__(self, routes: dict[tuple[str, str], Any]):
        self.routes = routes
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = (request.method, request.url.path)
        spec = self.routes.get(key)
        if spec is None:
            # Anything unrouted is a 404 — mirrors the v1.04 firmware's
            # behaviour for the legacy endpoints and surfaces accidental hits.
            return httpx.Response(404, json={"error": "not found"})
        if callable(spec):
            return spec(request)
        return httpx.Response(200, json=spec)

    def posts_to(self, path: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "POST" and r.url.path == path]

    def gets_to(self, path: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "GET" and r.url.path == path]


def _make_driver(recorder: _Recorder, *, plan_only: bool = True) -> LantronixDriver:
    driver = LantronixDriver(
        host=_HOST, port=443, username="admin", password="Droplet123!",
        plan_only=plan_only,
    )
    client = httpx.AsyncClient(
        base_url=_BASE,
        transport=httpx.MockTransport(recorder.handler),
    )
    # Install the client-picked session cookies exactly as connect() does — the
    # firmware never issues Set-Cookie; these three are the session key.
    for name in ("cid", "seid", "sesslid"):
        client.cookies.set(name, "123456789", domain=_HOST)
    driver._client = client
    return driver


_READ_ROUTES: dict[tuple[str, str], Any] = {
    ("GET", "/config/login"): fx.LOGIN_GET,
    ("POST", "/config/login"): fx.LOGIN_POST_OK,
    ("GET", "/stat/sysinfo"): fx.SYSINFO,
    ("GET", "/stat/vlan_membership_stat"): fx.VLAN_MEMBERSHIP_STAT,
    ("GET", "/stat/vlan_port_stat"): fx.VLAN_PORT_STAT,
    ("GET", "/stat/poe_status"): fx.POE_STATUS,
    ("GET", "/stat/port_status"): fx.PORT_STATUS,
}


# --- Auth handshake ---------------------------------------------------------


async def test_authenticate_posts_login_envelope_with_userip_and_cookies():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec)

    await driver._authenticate()

    # GET /config/login then POST /config/login, in that order.
    assert rec.gets_to("/config/login"), "must GET /config/login for userip first"
    posts = rec.posts_to("/config/login")
    assert len(posts) == 1, "exactly one login POST"

    post = posts[0]
    body = json.loads(post.content)
    assert "users_login_auth" in body
    env = body["users_login_auth"]
    assert env["username"] == "admin"
    assert env["password"] == "Droplet123!"
    assert env["agent"] == 4  # HTTPS
    # userip is lifted from the GET /config/login response, not guessed.
    assert env["userip"] == fx.LOGIN_GET["userip"]

    # The session cookies ride on the login POST (the firmware's session key).
    cookie_header = post.headers.get("cookie", "")
    assert "cid=" in cookie_header
    assert "seid=" in cookie_header
    assert "sesslid=" in cookie_header


async def test_authenticate_raises_on_rejected_login():
    routes = dict(_READ_ROUTES)
    routes[("POST", "/config/login")] = fx.LOGIN_POST_FAIL
    rec = _Recorder(routes)
    driver = _make_driver(rec)

    with pytest.raises(AuthenticationError):
        await driver._authenticate()


# --- System info ------------------------------------------------------------


async def test_get_system_info_parses_model_fw_mac():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec)

    info = await driver.get_system_info()

    # WARP-1674: the driver owns vendor branding now that the SwitchPanel no
    # longer hardcodes "Lantronix" in front of the model.
    assert info["model"] == "Lantronix SM8TAT2SA"
    assert info["firmware_version"] == "v1.04.0079"
    assert info["mac_address"] == "00-C0-F2-A3-E6-3D"
    assert info["hostname"] == "Droplet Switch"
    assert info["port_count"] == 10
    assert info["driver"] == "lantronix"
    # sysinfo, not the legacy endpoint.
    assert rec.gets_to("/stat/sysinfo")


# --- VLANs (vlan_membership_stat) -------------------------------------------


async def test_get_vlans_parses_membership_stat_with_tagged_split():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec)

    vlans = await driver.get_vlans()

    by_id = {v["vlan_id"]: v for v in vlans}
    assert set(by_id) == {1, 10, 100}
    assert by_id[10]["name"] == "lan"
    assert by_id[100]["name"] == "cameras"

    # VLAN 100: members [5,6], untagged [6] -> port 6 untagged, port 5 tagged.
    cam_ports = {p["port"]: p for p in by_id[100]["ports"]}
    assert cam_ports[6]["tagged"] is False and cam_ports[6]["member"] is True
    assert cam_ports[5]["tagged"] is True and cam_ports[5]["member"] is True

    # Uses the verified endpoint, never the 404 legacy one.
    assert rec.gets_to("/stat/vlan_membership_stat")
    assert not rec.gets_to("/stat/vlan")


async def test_get_vlan_membership_single_vlan_tagged_untagged():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec)

    membership = await driver.get_vlan_membership(100)

    assert membership["vlan_id"] == 100
    ports = {p["port"]: p for p in membership["ports"]}
    # members 5,6; untagged 6 => 6 untagged member, 5 tagged member.
    assert ports[6] == {"port": 6, "tagged": False, "member": True}
    assert ports[5] == {"port": 5, "tagged": True, "member": True}


async def test_get_vlan_membership_missing_vlan_is_empty():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec)

    membership = await driver.get_vlan_membership(999)

    assert membership == {"vlan_id": 999, "ports": []}


# --- Ports (vlan_port_stat) -------------------------------------------------


async def test_get_ports_parses_pvid_and_trunk_detection():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec)

    ports = await driver.get_ports()

    by_port = {p["port"]: p for p in ports}
    assert set(by_port) == set(range(1, 11)), "all 10 ports represented"

    # PVID parsed from vlan_port_stat.
    assert by_port[1]["vlan"] == 10
    assert by_port[2]["vlan"] == 1
    assert by_port[6]["vlan"] == 100

    # SFP flag preserved (9, 10).
    assert by_port[9]["is_sfp"] is True
    assert by_port[1]["is_sfp"] is False

    # Trunk detection via txtag "All except-native": port 5 is a trunk, the
    # access ports are not.
    assert by_port[5]["is_trunk"] is True
    assert by_port[1]["is_trunk"] is False
    assert by_port[6]["is_trunk"] is False

    assert rec.gets_to("/stat/vlan_port_stat")
    assert not rec.gets_to("/stat/port")


# --- Port status (port_status) — the real link/speed source -----------------


async def test_get_port_status_parses_link_speed_media():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec)

    statuses = await driver.get_port_status()

    by_port = {p["port"]: p for p in statuses}
    assert set(by_port) == set(range(1, 11)), "all 10 ports represented"

    # Up copper port: link_up True, speed normalised to "1 Gb".
    assert by_port[1]["link_up"] is True
    assert by_port[1]["speed"] == "1 Gb"
    assert by_port[1]["is_sfp"] is False

    # Down port: link_up False, speed "" (the panel renders "—").
    assert by_port[2]["link_up"] is False
    assert by_port[2]["speed"] == ""

    # SFP uplink port 9: 10 Gb on fiber media -> is_sfp True.
    assert by_port[9]["link_up"] is True
    assert by_port[9]["speed"] == "10 Gb"
    assert by_port[9]["is_sfp"] is True

    # Reads the newly-confirmed endpoint, not the legacy 404 ones.
    assert rec.gets_to("/stat/port_status")
    assert not rec.gets_to("/stat/port")


async def test_get_port_status_backfills_missing_ports_as_down():
    # Firmware omits a port row -> the driver still represents all 10, down.
    partial = {"data": [{"port": 1, "link": "up", "media": "copper", "speed": 1000}]}
    routes = dict(_READ_ROUTES)
    routes[("GET", "/stat/port_status")] = partial
    rec = _Recorder(routes)
    driver = _make_driver(rec)

    statuses = await driver.get_port_status()

    by_port = {p["port"]: p for p in statuses}
    assert set(by_port) == set(range(1, 11))
    assert by_port[1]["link_up"] is True
    # Omitted port 5 -> safe down default, copper, not SFP.
    assert by_port[5]["link_up"] is False
    assert by_port[5]["speed"] == ""
    # Ports 9-10 are SFP by position even when absent from the payload.
    assert by_port[10]["is_sfp"] is True


async def test_get_port_status_unusual_speed_renders_mbps():
    # A 100 Mbps link (not a clean Gb multiple) is rendered without fabricating
    # a Gb label — we never invent data the firmware didn't report.
    odd = {"data": [{"port": 3, "link": "up", "media": "copper", "speed": 100}]}
    routes = dict(_READ_ROUTES)
    routes[("GET", "/stat/port_status")] = odd
    rec = _Recorder(routes)
    driver = _make_driver(rec)

    statuses = await driver.get_port_status()
    by_port = {p["port"]: p for p in statuses}
    assert by_port[3]["link_up"] is True
    assert by_port[3]["speed"] == "100 Mb"


# --- PoE --------------------------------------------------------------------


async def test_get_poe_status_parses_status_endpoint():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec)

    poe = await driver.get_poe_status()

    by_port = {p["port"]: p for p in poe}
    assert by_port[1]["delivering"] is True
    assert by_port[1]["power_mw"] == 12500.0
    assert by_port[2]["delivering"] is False
    assert rec.gets_to("/stat/poe_status")


# --- Writes: dry-run (plan_only) does NOT POST ------------------------------


async def test_set_vlan_membership_plan_only_does_not_post():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec, plan_only=True)

    plan = await driver.set_vlan_membership(
        100, [{"port": 6, "tagged": False, "member": True}]
    )

    # No write hit the wire.
    assert rec.posts_to("/config/vlan_membership_stat") == []
    # The planned diff is returned for inspection.
    assert plan is not None
    assert plan["dry_run"] is True
    assert plan["vlan_id"] == 100
    assert plan["membership"] == [{"port": 6, "tagged": False, "member": True}]


async def test_set_port_poe_plan_only_does_not_post():
    rec = _Recorder(dict(_READ_ROUTES))
    driver = _make_driver(rec, plan_only=True)

    plan = await driver.set_port_poe(1, False)

    assert rec.posts_to("/config/poe_config") == []
    assert plan is not None and plan["dry_run"] is True


# --- Writes: apply mode POSTs + read-back verifies --------------------------


async def test_set_vlan_membership_apply_posts_and_verifies():
    # A stateful membership read that flips port 6 onto VLAN 100 only AFTER the
    # write lands, so read-back verification passes.
    state = {"written": False}

    def membership_read(_req: httpx.Request) -> httpx.Response:
        if state["written"]:
            return httpx.Response(200, json={
                "data": [[100, "cameras", [6], [6]]]
            })
        return httpx.Response(200, json={"data": [[100, "cameras", [], []]]})

    def membership_write(_req: httpx.Request) -> httpx.Response:
        state["written"] = True
        return httpx.Response(200, json={"status": "ok"})

    routes = dict(_READ_ROUTES)
    routes[("GET", "/stat/vlan_membership_stat")] = membership_read
    routes[("POST", "/config/vlan_membership_stat")] = membership_write
    rec = _Recorder(routes)
    driver = _make_driver(rec, plan_only=False)

    result = await driver.set_vlan_membership(
        100, [{"port": 6, "tagged": False, "member": True}]
    )

    assert rec.posts_to("/config/vlan_membership_stat"), "apply mode must POST"
    assert result is None or result.get("dry_run") is False


async def test_set_vlan_membership_apply_readback_mismatch_raises():
    # Write "succeeds" (200) but the read-back never reflects it -> the driver
    # must raise rather than report a silent mis-provision.
    def membership_read(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [[100, "cameras", [], []]]})

    routes = dict(_READ_ROUTES)
    routes[("GET", "/stat/vlan_membership_stat")] = membership_read
    routes[("POST", "/config/vlan_membership_stat")] = (
        lambda _r: httpx.Response(200, json={"status": "ok"})
    )
    rec = _Recorder(routes)
    driver = _make_driver(rec, plan_only=False)

    with pytest.raises(SwitchAPIError):
        await driver.set_vlan_membership(
            100, [{"port": 6, "tagged": False, "member": True}]
        )


# --- plan_only defaults safe ------------------------------------------------


async def test_driver_defaults_to_plan_only():
    driver = LantronixDriver(
        host=_HOST, port=443, username="admin", password="pw"
    )
    assert driver._plan_only is True
