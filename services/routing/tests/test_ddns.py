"""Tests for the DuckDNS configuration endpoints (Phase 4).

The schema is small enough that boundary tests live alongside the endpoint
tests in one file. The mock router uses an in-memory uci-like store so a
PUT followed by a GET round-trips correctly.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import UbusError
from mock_router import MockRouter


AUTH = {"authorization": "Bearer pytest-fake-token"}


@pytest.fixture
def ddns_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """TestClient with a real MockRouter and an in-memory uci store added on
    the ddns config so PUT → GET round-trips.

    The base MockUci returns {"values": {}} for any get(); we monkeypatch
    `_MockUci.get` and `_MockUci.add` for this fixture so the duckdns flow
    can persist state inside a single test.
    """
    router = MockRouter()
    store: dict[str, dict] = {}

    def fake_get(config: str, section: str | None = None, **kwargs):
        if config != "ddns":
            return {"values": {}}
        if section is None:
            return {"values": dict(store)}
        if section not in store:
            raise UbusError(4, f"section {section!r} not found")
        return {"values": dict(store[section])}

    def fake_set(config: str, section: str, values: dict):
        if config != "ddns":
            return
        store.setdefault(section, {}).update(values)

    def fake_add(config: str, type: str, values: dict | None = None, name: str | None = None):
        if config != "ddns":
            return
        sname = name or f"cfgmock{len(store)+1:02d}{type}"
        body = {".type": type}
        if values:
            body.update(values)
        store[sname] = body
        return {"section": sname}

    monkeypatch.setattr(router.uci, "get", fake_get)
    monkeypatch.setattr(router.uci, "set", fake_set)
    monkeypatch.setattr(router.uci, "add", fake_add)
    monkeypatch.setattr(main, "router_instance", router)
    return TestClient(main.app)


def _make_ddns_store_client(
    monkeypatch: pytest.MonkeyPatch, *, present_interfaces: set[str]
) -> tuple[TestClient, dict[str, dict]]:
    """Like `ddns_client` but also exposes the in-memory uci store AND lets the
    test pin which logical interfaces this deployment shape exposes.

    `present_interfaces` mirrors the canonical presence signal from
    `NetworkApi.get_all_interface_statuses()` (ADR-011): an interface in the set
    reads back `present: True`; one absent from it reads back the
    `interface_stub(present=False)` shape — exactly what a LAN-only single-box
    returns for `wan`. Returning the store lets the interface-selection tests
    assert on the *value actually written to /etc/config/ddns*.
    """
    from droplet_openwrt_sdk import interface_stub

    router = MockRouter()
    store: dict[str, dict] = {}

    def fake_get(config: str, section: str | None = None, **kwargs):
        if config != "ddns":
            return {"values": {}}
        if section is None:
            return {"values": dict(store)}
        if section not in store:
            raise UbusError(4, f"section {section!r} not found")
        return {"values": dict(store[section])}

    def fake_set(config: str, section: str, values: dict):
        if config != "ddns":
            return
        store.setdefault(section, {}).update(values)

    def fake_add(config: str, type: str, values: dict | None = None, name: str | None = None):
        if config != "ddns":
            return
        sname = name or f"cfgmock{len(store)+1:02d}{type}"
        body = {".type": type}
        if values:
            body.update(values)
        store[sname] = body
        return {"section": sname}

    def fake_interface_statuses() -> dict[str, dict]:
        out: dict[str, dict] = {}
        for name in ("lan", "wan"):
            if name in present_interfaces:
                out[name] = {"up": True, "device": f"br-{name}", "present": True}
            else:
                out[name] = interface_stub(present=False)
        return out

    monkeypatch.setattr(router.uci, "get", fake_get)
    monkeypatch.setattr(router.uci, "set", fake_set)
    monkeypatch.setattr(router.uci, "add", fake_add)
    monkeypatch.setattr(router.network, "get_all_interface_statuses", fake_interface_statuses)
    monkeypatch.setattr(main, "router_instance", router)
    return TestClient(main.app), store


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


class TestDuckDnsSchema:
    @pytest.mark.parametrize(
        "bad_subdomain",
        [
            "",                         # empty
            "Stefan",                   # uppercase
            "-droplet",                 # leading hyphen
            "droplet-",                 # trailing hyphen
            "drop.let",                 # dot — DuckDNS subdomains are flat
            "a" * 64,                   # > 63 chars
            "stefan_droplet",           # underscore not allowed
        ],
    )
    def test_invalid_subdomain_rejected(self, ddns_client: TestClient, bad_subdomain: str) -> None:
        resp = ddns_client.put(
            "/ddns/duckdns",
            json={"subdomain": bad_subdomain, "token": "0123456789abcdef"},
            headers=AUTH,
        )
        assert resp.status_code == 422

    @pytest.mark.parametrize("bad_token", ["", "x", "short"])
    def test_short_token_rejected(self, ddns_client: TestClient, bad_token: str) -> None:
        resp = ddns_client.put(
            "/ddns/duckdns",
            json={"subdomain": "stefan-droplet", "token": bad_token},
            headers=AUTH,
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Endpoint behaviour
# ---------------------------------------------------------------------------


class TestDuckDnsGet:
    def test_unconfigured_returns_configured_false(self, ddns_client: TestClient) -> None:
        resp = ddns_client.get("/ddns/duckdns", headers=AUTH)
        assert resp.status_code == 200
        assert resp.json() == {"configured": False}


class TestDuckDnsPut:
    def test_first_put_creates_section(self, ddns_client: TestClient) -> None:
        resp = ddns_client.put(
            "/ddns/duckdns",
            json={
                "subdomain": "stefan-droplet",
                "token": "deadbeef-1234-5678-90ab-cdef00112233",
                "enabled": True,
            },
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["configured"] is True
        assert body["subdomain"] == "stefan-droplet"
        assert body["fullDomain"] == "stefan-droplet.duckdns.org"
        assert body["enabled"] is True
        # Token must NEVER come back; only a boolean signal.
        assert body["tokenSet"] is True
        assert "token" not in body
        assert "password" not in body
        # Confirm via GET round-trip.
        get_body = ddns_client.get("/ddns/duckdns", headers=AUTH).json()
        assert get_body["subdomain"] == "stefan-droplet"
        assert "token" not in get_body
        assert "password" not in get_body

    def test_second_put_updates_in_place(self, ddns_client: TestClient) -> None:
        ddns_client.put(
            "/ddns/duckdns",
            json={"subdomain": "first", "token": "deadbeef-aaaa-bbbb-cccc-dddddddddddd"},
            headers=AUTH,
        )
        resp = ddns_client.put(
            "/ddns/duckdns",
            json={"subdomain": "second", "token": "cafefade-eeee-ffff-1111-222222222222"},
            headers=AUTH,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["subdomain"] == "second"

    def test_disabled_flag_persists(self, ddns_client: TestClient) -> None:
        resp = ddns_client.put(
            "/ddns/duckdns",
            json={
                "subdomain": "staged",
                "token": "deadbeef-aaaa-bbbb-cccc-dddddddddddd",
                "enabled": False,
            },
            headers=AUTH,
        )
        assert resp.status_code == 200
        assert resp.json()["enabled"] is False


class TestDuckDnsInterfaceSelection:
    """The DuckDNS UCI section must bind `interface` to an interface that is
    actually PRESENT on this deployment shape (ADR-011).

    Root-caused live on the 192.168.1.87 single-box (LAN-only: it has no `wan`
    logical interface — its bridges are `br-lan` + the host-carried mgmt
    uplink). The handler hardcoded `interface=wan`, so ddns-scripts bound the
    section to a nonexistent interface and the update path was dead
    (`GET /api/ddns/duckdns` → `configured:false`; remote DNS "can't be
    reached"). Presence is read from `NetworkApi.get_all_interface_statuses()`,
    the same shape-detection mechanism `get_network_summary` already uses — not
    a new env var or a second presence path.

    `ip_source` stays `web` (public-IP checker) on every shape: `interface`
    only governs which hotplug events trigger an immediate re-check, so binding
    it to a present interface keeps the trigger valid without changing how the
    published IP is discovered.
    """

    _TOKEN = "deadbeef-aaaa-bbbb-cccc-dddddddddddd"

    def test_lan_only_box_does_not_bind_interface_to_absent_wan(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # LAN-only single-box shape: `lan` present, `wan` absent.
        client, store = _make_ddns_store_client(monkeypatch, present_interfaces={"lan"})

        resp = client.put(
            "/ddns/duckdns",
            json={"subdomain": "stefan-droplet", "token": self._TOKEN, "enabled": True},
            headers=AUTH,
        )

        # DuckDNS must STILL configure on a LAN-only box.
        assert resp.status_code == 200, resp.text
        assert resp.json()["configured"] is True

        written = store[main.DUCKDNS_SECTION]
        # The core bug: never bind to a `wan` that isn't on this box.
        assert written.get("interface") != "wan"
        # It binds to the present LAN-facing interface instead (the only one here).
        assert written.get("interface") == "lan"
        # The public-IP checker behaviour is unchanged regardless of shape.
        assert written["ip_source"] == "web"
        assert written["ip_url"] == "https://checkip.amazonaws.com"

    def test_wan_present_still_binds_interface_to_wan(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Multi-box / router shape: `wan` IS present → unchanged behaviour.
        client, store = _make_ddns_store_client(
            monkeypatch, present_interfaces={"lan", "wan"}
        )

        resp = client.put(
            "/ddns/duckdns",
            json={"subdomain": "stefan-droplet", "token": self._TOKEN, "enabled": True},
            headers=AUTH,
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["configured"] is True

        written = store[main.DUCKDNS_SECTION]
        # No regression: WAN is preferred when present.
        assert written.get("interface") == "wan"
        assert written["ip_source"] == "web"


class TestDuckDnsRequiresRouter:
    def test_get_503_when_disconnected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).get("/ddns/duckdns", headers=AUTH)
        assert resp.status_code == 503

    def test_put_503_when_disconnected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).put(
            "/ddns/duckdns",
            json={"subdomain": "stefan-droplet", "token": "deadbeef-aaaa-bbbb-cccc-dddddddddddd"},
            headers=AUTH,
        )
        assert resp.status_code == 503
