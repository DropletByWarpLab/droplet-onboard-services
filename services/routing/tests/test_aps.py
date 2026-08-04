"""Tests for the coverage-extender AP onboarding endpoints (WARP-446).

Three layers, mirroring the WARP-174 VPN test structure:

1. **Schema validation** — Pydantic rejects bad MAC formats, SSIDs, IPs
   at the REST boundary. Pure boundary, no router.
2. **SDK behaviour** — `ApApi` (in droplet_openwrt_sdk.py) round-trips
   discovered → list → push-config → remove against a fake UCI store.
   Catches regressions in the on-disk shape.
3. **REST endpoints** — driven through FastAPI's TestClient against the
   in-memory `MockRouter`, exercising the full state machine
   DISCOVERED → AWAITING_APPROVAL → PROVISIONING → ONLINE → DECOMMISSIONED.

The fake-UCI pattern is lifted straight from test_vpn.py; the MockRouter
is extended in mock_router.py with the same in-memory shape so end-to-end
state flows.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import ApApi, UbusError
from mock_router import MockRouter


AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def ap_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """TestClient backed by a fresh MockRouter so the full AP state machine
    round-trips: discovery → approval → push → decommission keep the same
    in-memory state inside one test.
    """
    monkeypatch.setattr(main, "router_instance", MockRouter())
    return TestClient(main.app)


# ---------------------------------------------------------------------------
# 1. Schema validation
# ---------------------------------------------------------------------------


class TestApDiscoveredSchema:
    """GET /aps/discovered is a read with no body — minimal schema test."""

    def test_returns_list_shape(self, ap_client: TestClient) -> None:
        resp = ap_client.get("/aps/discovered", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "discovered" in body
        assert isinstance(body["discovered"], list)


class TestApApproveSchema:
    """Boundary validation for POST /aps/{mac}/approve."""

    VALID_MAC = "B8:27:EB:12:34:56"

    @pytest.mark.parametrize(
        "bad_mac",
        [
            "B8:27:EB:12:34",         # too short
            "B8-27-EB-12-34-56",      # wrong delimiter
            "ZZ:27:EB:12:34:56",      # non-hex
            "",                       # empty
        ],
    )
    def test_invalid_mac_rejected(self, ap_client: TestClient, bad_mac: str) -> None:
        resp = ap_client.post(
            f"/aps/{bad_mac}/approve",
            json={"ssid": "Droplet", "encryption_key": "longenoughpw"},
            headers=AUTH,
        )
        # FastAPI returns 422 on path-param validation OR 404 if the path
        # doesn't match any registered route shape; both are acceptable
        # rejections of a malformed MAC. The contract is "no 200".
        assert resp.status_code in (404, 422)

    def test_missing_ssid_rejected(self, ap_client: TestClient) -> None:
        # Pre-seed the AP so we exercise the SCHEMA path, not the not-found
        # path. mock router's auto-discover doesn't fire in test harness.
        ap_client.post("/aps/_test_seed", json={"mac": self.VALID_MAC}, headers=AUTH)
        resp = ap_client.post(
            f"/aps/{self.VALID_MAC}/approve",
            json={"encryption_key": "longenoughpw"},
            headers=AUTH,
        )
        assert resp.status_code == 422

    def test_short_psk_rejected(self, ap_client: TestClient) -> None:
        # WPA2 min-length is 8 chars; the endpoint enforces this so we
        # don't push a config the AP's hostapd will reject.
        resp = ap_client.post(
            f"/aps/{self.VALID_MAC}/approve",
            json={"ssid": "Droplet", "encryption_key": "short"},
            headers=AUTH,
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# 2. SDK behaviour — ApApi against a fake UCI store
# ---------------------------------------------------------------------------


class _FakeUci:
    """Same shape as test_vpn._FakeUci — slimmed to network + wireless."""

    def __init__(self) -> None:
        # Keyed by `(config, section)` so wireless and network don't collide.
        self.sections: dict[tuple[str, str], dict] = {}
        self._counter = 0
        self.commits: list[str] = []

    def get(self, config, section=None, option=None, type=None):
        if section is not None:
            key = (config, section)
            sec = self.sections.get(key)
            if sec is None:
                raise UbusError(4, f"section {section!r} not found in {config!r}")
            return {"values": dict(sec)}
        if type is not None:
            values = {
                s: v for (c, s), v in self.sections.items()
                if c == config and v.get(".type") == type
            }
            return {"values": values}
        # whole-config read
        values = {s: v for (c, s), v in self.sections.items() if c == config}
        return values

    def set(self, config, section, values):
        body = self.sections.setdefault((config, section), {})
        # Default `.type` mirrors what `add` would have set; harmless for
        # tests that don't care about the wrap shape.
        body.setdefault(".type", "wifi-iface" if config == "wireless" else "interface")
        body.update(values)

    def add(self, config, type, values=None, name=None):
        self._counter += 1
        section = name or f"cfg{self._counter:02d}{type}"
        body = {".type": type}
        if values:
            body.update(values)
        self.sections[(config, section)] = body
        return {"section": section}

    def delete(self, config, section, option=None):
        self.sections.pop((config, section), None)

    def commit(self, config):
        self.commits.append(config)


class _FakeRouter:
    def __init__(self) -> None:
        self.uci = _FakeUci()


@pytest.fixture
def ap_api():
    router = _FakeRouter()
    return ApApi(router), router


class TestApApiPushWirelessConfig:
    """`ApApi.push_wireless_config()` round-trips on a fake UCI store."""

    def test_push_writes_wifi_iface_section(self, ap_api) -> None:
        api, router = ap_api
        api.push_wireless_config(
            iface_section="ap_extender_b827eb123456",
            radio="radio0",
            ssid="Droplet",
            encryption="psk2+ccmp",
            key="longenoughpw",
        )

        # Should land in (wireless, ap_extender_b827eb123456) with the
        # standard hostapd-compatible field set.
        sec = router.uci.sections.get(("wireless", "ap_extender_b827eb123456"))
        assert sec is not None
        assert sec[".type"] == "wifi-iface"
        assert sec["device"] == "radio0"
        assert sec["mode"] == "ap"
        assert sec["ssid"] == "Droplet"
        assert sec["encryption"] == "psk2+ccmp"
        assert sec["key"] == "longenoughpw"
        # 802.11r (FT) flags are baked in per ADR-005 — fast handoff
        # depends on these being set consistently across every AP.
        assert sec.get("ieee80211r") == "1"
        assert sec.get("ft_over_ds") == "0"
        assert sec.get("ft_psk_generate_local") == "1"
        # 802.11k/v neighbor reporting — dawn needs these for steering
        # to work, even when dawn itself is enabled per-AP.
        assert sec.get("ieee80211k") == "1"
        assert sec.get("bss_transition") == "1"

    def test_remove_drops_the_iface_section(self, ap_api) -> None:
        api, router = ap_api
        api.push_wireless_config(
            iface_section="ap_test",
            radio="radio0",
            ssid="Droplet",
            encryption="psk2+ccmp",
            key="longenoughpw",
        )
        assert ("wireless", "ap_test") in router.uci.sections
        api.remove_wireless_config(iface_section="ap_test")
        assert ("wireless", "ap_test") not in router.uci.sections

    def test_iface_section_for_mac_is_deterministic(self) -> None:
        # Same MAC → same section name → idempotent re-push. The
        # canonical shape is `ap_extender_<mac-lowercase-no-colons>`.
        assert (
            ApApi.iface_section_for_mac("B8:27:EB:12:34:56")
            == "ap_extender_b827eb123456"
        )
        # Normalization tolerates input variants.
        assert (
            ApApi.iface_section_for_mac("b8-27-eb-12-34-56")
            == "ap_extender_b827eb123456"
        )

    def test_iface_section_rejects_garbage_mac(self) -> None:
        with pytest.raises(ValueError):
            ApApi.iface_section_for_mac("not a mac")


class TestApApiBrowseDiscovered:
    """WARP-446 (blocker #1) — `ApApi.browse_discovered()` parses
    `ubus call umdns browse` output into the orchestrator's
    discovered-AP shape so production discovery actually works.
    """

    def _api_with_umdns(self, umdns_response):
        """Build an ApApi against a router whose `_call("umdns", "browse")`
        returns `umdns_response`."""
        class _FakeRouter:
            def __init__(self) -> None:
                self.calls: list[tuple[str, str]] = []

            def _call(self, obj: str, method: str, args=None):
                self.calls.append((obj, method))
                if isinstance(umdns_response, Exception):
                    raise umdns_response
                return umdns_response

        router = _FakeRouter()
        return ApApi(router), router

    def test_parses_droplet_ap_txt_records_into_observation_shape(self) -> None:
        api, _ = self._api_with_umdns({
            "_droplet-ap._tcp": {
                "droplet-ap-b827eb123456": {
                    "ipv4": "192.168.50.42",
                    "port": 80,
                    "txt": [
                        "mac=B8:27:EB:12:34:56",
                        "model=raspberrypi,5-model-b",
                        "serial=AP-00000000a1b2c3d4",
                        "version=1.0",
                        "role=extender",
                    ],
                },
            }
        })
        result = api.browse_discovered()
        assert len(result) == 1
        rec = result[0]
        assert rec["mac"] == "B8:27:EB:12:34:56"
        assert rec["model"] == "raspberrypi,5-model-b"
        assert rec["serial"] == "AP-00000000a1b2c3d4"
        assert rec["version"] == "1.0"
        assert rec["last_ip"] == "192.168.50.42"
        assert rec["hostname"] == "droplet-ap-b827eb123456"

    def test_ignores_records_without_mac_txt(self) -> None:
        # A non-droplet TXT record that happens to share the service
        # name shouldn't crash the parser — drop it silently and move on.
        api, _ = self._api_with_umdns({
            "_droplet-ap._tcp": {
                "stranger": {"txt": ["foo=bar"]},
                "real": {
                    "ipv4": "192.168.50.43",
                    "txt": ["mac=B8:27:EB:AA:BB:CC"],
                },
            }
        })
        result = api.browse_discovered()
        assert [r["mac"] for r in result] == ["B8:27:EB:AA:BB:CC"]

    def test_returns_empty_when_no_droplet_ap_service_announced(self) -> None:
        # Common case on first boot — umdns is up but nothing is
        # advertising `_droplet-ap._tcp` yet.
        api, _ = self._api_with_umdns({"_http._tcp": {}})
        assert api.browse_discovered() == []

    def test_returns_empty_when_umdns_service_unavailable(self) -> None:
        # UbusError code 4 (NOT_FOUND) means umdns isn't registered on
        # this build — the orchestrator's poller treats empty as
        # success so we return [] rather than raising.
        api, _ = self._api_with_umdns(UbusError(4, "umdns not found"))
        assert api.browse_discovered() == []

    def test_propagates_unexpected_ubus_errors(self) -> None:
        # Any non-NOT_FOUND code means something's actually wrong (auth,
        # transport, etc.) — bubble it so handle_router_error() can
        # surface a real 5xx rather than masking with []. The
        # orchestrator's poller swallows the resulting RouterError
        # itself (belt-and-suspenders), so the operator still doesn't
        # see a runaway error cascade.
        with pytest.raises(UbusError):
            api, _ = self._api_with_umdns(UbusError(99, "auth failed"))
            api.browse_discovered()


# ---------------------------------------------------------------------------
# 3. REST endpoints (MockRouter + state-machine round-trip)
# ---------------------------------------------------------------------------


class TestApDiscoveryEndpoint:
    """GET /aps/discovered surfaces the in-memory discovery list."""

    def test_empty_when_no_announces(self, ap_client: TestClient) -> None:
        resp = ap_client.get("/aps/discovered", headers=AUTH)
        assert resp.json()["discovered"] == []

    def test_lists_seeded_announces(self, ap_client: TestClient) -> None:
        # The mock router exposes `_test_seed` so tests can inject mDNS
        # announce events without simulating the multicast layer.
        ap_client.post(
            "/aps/_test_seed",
            json={"mac": "B8:27:EB:12:34:56", "model": "raspberrypi,5-model-b"},
            headers=AUTH,
        )
        ap_client.post(
            "/aps/_test_seed",
            json={"mac": "B8:27:EB:AA:BB:CC", "model": "raspberrypi,5-model-b"},
            headers=AUTH,
        )

        resp = ap_client.get("/aps/discovered", headers=AUTH)
        macs = sorted(d["mac"] for d in resp.json()["discovered"])
        # MACs come back uppercase + canonicalized.
        assert macs == ["B8:27:EB:12:34:56", "B8:27:EB:AA:BB:CC"]


class TestApApproveEndpoint:
    """POST /aps/{mac}/approve pushes the wireless config and reports status."""

    VALID_MAC = "B8:27:EB:12:34:56"

    def test_approve_returns_operation_id(self, ap_client: TestClient) -> None:
        ap_client.post(
            "/aps/_test_seed",
            json={"mac": self.VALID_MAC},
            headers=AUTH,
        )
        resp = ap_client.post(
            f"/aps/{self.VALID_MAC}/approve",
            json={"ssid": "Droplet", "encryption_key": "longenoughpw"},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Operation-Id surfaces in both the response body AND the response
        # header (per ADR-002 §"Phase 0.5" item 5).
        assert "operation_id" in body
        assert resp.headers.get("X-Operation-Id") == body["operation_id"]
        assert body["status"] == "ok"
        assert body["mac"] == self.VALID_MAC
        assert body["ssid"] == "Droplet"

    def test_approve_unknown_mac_returns_404(self, ap_client: TestClient) -> None:
        resp = ap_client.post(
            f"/aps/{self.VALID_MAC}/approve",
            json={"ssid": "Droplet", "encryption_key": "longenoughpw"},
            headers=AUTH,
        )
        # An MAC that was never seen by the discovery poller can't be
        # approved — the orchestrator wouldn't have a peer entry either.
        assert resp.status_code == 404


class TestApStatusEndpoint:
    """GET /aps/{mac} returns the discovered state for a known AP."""

    VALID_MAC = "B8:27:EB:12:34:56"

    def test_unknown_mac_404(self, ap_client: TestClient) -> None:
        resp = ap_client.get(f"/aps/{self.VALID_MAC}", headers=AUTH)
        assert resp.status_code == 404

    def test_known_ap_reports_state(self, ap_client: TestClient) -> None:
        ap_client.post(
            "/aps/_test_seed",
            json={"mac": self.VALID_MAC, "model": "raspberrypi,5-model-b"},
            headers=AUTH,
        )
        resp = ap_client.get(f"/aps/{self.VALID_MAC}", headers=AUTH)
        assert resp.status_code == 200
        body = resp.json()
        assert body["mac"] == self.VALID_MAC
        # Fresh discovery → discovered state (no approval yet).
        assert body["state"] == "discovered"
        assert body["model"] == "raspberrypi,5-model-b"


class TestApDecommissionEndpoint:
    """DELETE /aps/{mac} removes the wireless config + transitions state."""

    VALID_MAC = "B8:27:EB:12:34:56"

    def test_decommission_requires_known_ap(self, ap_client: TestClient) -> None:
        resp = ap_client.request(
            "DELETE", f"/aps/{self.VALID_MAC}", headers=AUTH,
        )
        assert resp.status_code == 404

    def test_decommission_clears_state(self, ap_client: TestClient) -> None:
        # Seed → approve → decommission round-trip.
        ap_client.post(
            "/aps/_test_seed",
            json={"mac": self.VALID_MAC},
            headers=AUTH,
        )
        ap_client.post(
            f"/aps/{self.VALID_MAC}/approve",
            json={"ssid": "Droplet", "encryption_key": "longenoughpw"},
            headers=AUTH,
        )

        resp = ap_client.request(
            "DELETE", f"/aps/{self.VALID_MAC}", headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "ok"

        # State endpoint reflects the decommission.
        status = ap_client.get(f"/aps/{self.VALID_MAC}", headers=AUTH).json()
        assert status["state"] == "decommissioned"


class TestApEndpointsRequireRouter:
    """Endpoints 503 when router_instance is None — same posture as VPN."""

    def test_discovered_503_when_disconnected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).get("/aps/discovered", headers=AUTH)
        assert resp.status_code == 503

    def test_approve_503_when_disconnected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).post(
            "/aps/B8:27:EB:12:34:56/approve",
            json={"ssid": "Droplet", "encryption_key": "longenoughpw"},
            headers=AUTH,
        )
        assert resp.status_code == 503


# ---------------------------------------------------------------------------
# 4. AP-attached stations (WARP-1715)
# ---------------------------------------------------------------------------


class TestApClients:
    """GET /aps/{mac}/clients — the read that lets the dashboard attribute a
    station to the AP it actually joined.

    Without it the device list is built purely from the ROUTER's assoclist, so
    every device on a standalone AP's radios rendered as wired with no signal.
    """

    VALID_MAC = "B8:27:EB:AA:BB:CC"
    STATIONS = [
        {"mac": "AA:BB:CC:00:00:01", "signal": -52, "rx_rate": 300000},
        {"mac": "AA:BB:CC:00:00:02", "signal": -71},
    ]

    def _seed(self, ap_client: TestClient, **extra) -> None:
        payload = {"mac": self.VALID_MAC, "last_ip": "192.168.9.183", **extra}
        resp = ap_client.post("/aps/_test_seed", json=payload, headers=AUTH)
        assert resp.status_code == 200, resp.text

    def test_returns_the_stations_associated_to_this_ap(self, ap_client: TestClient) -> None:
        self._seed(ap_client, clients=self.STATIONS)
        resp = ap_client.get(f"/aps/{self.VALID_MAC}/clients", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["supported"] is True
        assert [c["mac"] for c in body["clients"]] == [
            "AA:BB:CC:00:00:01",
            "AA:BB:CC:00:00:02",
        ]
        assert body["clients"][0]["signal"] == -52

    def test_an_idle_ap_reports_no_stations_not_an_error(self, ap_client: TestClient) -> None:
        self._seed(ap_client)
        resp = ap_client.get(f"/aps/{self.VALID_MAC}/clients", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"supported": True, "clients": [], "ap_detail": "mock AP"}

    def test_404_for_a_mac_that_never_announced(self, ap_client: TestClient) -> None:
        resp = ap_client.get("/aps/B8:27:EB:99:99:99/clients", headers=AUTH)
        assert resp.status_code == 404

    def test_rejects_a_malformed_mac_at_the_boundary(self, ap_client: TestClient) -> None:
        # `_validate_mac` answers 404 for a bad MAC in the path — a malformed
        # MAC names no resource. Same posture as the other /aps/{mac} routes.
        resp = ap_client.get("/aps/not-a-mac/clients", headers=AUTH)
        assert resp.status_code == 404

    def test_503_when_disconnected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).get(f"/aps/{self.VALID_MAC}/clients", headers=AUTH)
        assert resp.status_code == 503

    def test_seeding_clients_does_not_pollute_the_ap_identity(
        self, ap_client: TestClient
    ) -> None:
        """`GET /aps/{mac}` echoes the discovery record wholesale — an
        assoclist leaking into it would ship stations as AP metadata."""
        self._seed(ap_client, clients=self.STATIONS)
        body = ap_client.get(f"/aps/{self.VALID_MAC}", headers=AUTH).json()
        assert "clients" not in body
