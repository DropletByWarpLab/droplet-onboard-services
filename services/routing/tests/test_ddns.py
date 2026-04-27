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
