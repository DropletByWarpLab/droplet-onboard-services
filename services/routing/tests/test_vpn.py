"""Tests for the WireGuard / Remote Access endpoints (Phase 1).

Three layers of coverage:

1. **Schema validation** — Pydantic rejects bad interface names, ports, CIDRs,
   and pubkeys at the REST boundary. These are pure boundary tests; no router.
2. **SDK behaviour** — `VPNApi` keypair gen, list/add/delete round-trips against
   a fake UCI store. Catches regressions in the on-disk shape.
3. **REST endpoints** — driven through FastAPI's TestClient, with the in-memory
   `MockRouter` swapped in via the existing `connected_client` machinery (we
   use a thin wrapper that swaps in a real `MockRouter` instead of a MagicMock
   so end-to-end state — setup → add peer → list → delete — actually flows).
"""

from __future__ import annotations

from base64 import b64decode

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import UbusError, VPNApi
from mock_router import MockRouter


AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def vpn_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """TestClient backed by a real MockRouter so VPN state round-trips.

    The shared `connected_client` fixture uses MagicMock, which works for
    one-shot reads but not for endpoint tests that depend on add → list →
    delete keeping the same in-memory state. So we plug in MockRouter here.
    """
    monkeypatch.setattr(main, "router_instance", MockRouter())
    return TestClient(main.app)


# ---------------------------------------------------------------------------
# 1. Schema validation
# ---------------------------------------------------------------------------


class TestVpnSetupSchema:
    """Boundary validation for POST /vpn/setup."""

    def test_defaults_accepted(self, vpn_client: TestClient) -> None:
        resp = vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["interface"] == "wg0"
        assert body["listen_port"] == 51820
        assert body["created"] is True

    @pytest.mark.parametrize(
        "bad_iface",
        [
            "WG0",          # uppercase
            "0wg",          # leading digit
            "wg-0",         # hyphen not allowed (uci section name grammar)
            "wg.0",         # dot not allowed
            "",             # empty
            "a" * 16,       # over IFNAMSIZ-1 (15 chars)
        ],
    )
    def test_invalid_interface_rejected(self, vpn_client: TestClient, bad_iface: str) -> None:
        resp = vpn_client.post("/vpn/setup", json={"interface": bad_iface}, headers=AUTH)
        assert resp.status_code == 422

    @pytest.mark.parametrize("bad_port", [0, -1, 65536, 99999])
    def test_invalid_port_rejected(self, vpn_client: TestClient, bad_port: int) -> None:
        resp = vpn_client.post("/vpn/setup", json={"listen_port": bad_port}, headers=AUTH)
        assert resp.status_code == 422

    @pytest.mark.parametrize(
        "bad_addr",
        [
            "10.13.13.1",         # missing /mask
            "10.13.13.1/33",      # mask out of range
            "fe80::1/64",         # IPv6 — out of scope for v1
            "10.13.13.256/24",    # bad octet
            "not-a-cidr",
        ],
    )
    def test_invalid_address_rejected(self, vpn_client: TestClient, bad_addr: str) -> None:
        resp = vpn_client.post("/vpn/setup", json={"address": bad_addr}, headers=AUTH)
        assert resp.status_code == 422


class TestVpnPeerCreateSchema:
    """Boundary validation for POST /vpn/peers."""

    @staticmethod
    def _setup(client: TestClient) -> None:
        # /vpn/peers requires the interface exists; bring it up first so we
        # exercise the schema layer instead of getting a 409 every time.
        resp = client.post("/vpn/setup", json={}, headers=AUTH)
        assert resp.status_code == 200

    def test_minimal_payload_accepted(self, vpn_client: TestClient) -> None:
        self._setup(vpn_client)
        resp = vpn_client.post(
            "/vpn/peers",
            json={"allowed_ips": ["10.13.13.5/32"]},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text

    def test_allowed_ips_required(self, vpn_client: TestClient) -> None:
        self._setup(vpn_client)
        resp = vpn_client.post("/vpn/peers", json={}, headers=AUTH)
        assert resp.status_code == 422

    def test_allowed_ips_cannot_be_empty_list(self, vpn_client: TestClient) -> None:
        self._setup(vpn_client)
        resp = vpn_client.post(
            "/vpn/peers", json={"allowed_ips": []}, headers=AUTH,
        )
        assert resp.status_code == 422

    @pytest.mark.parametrize(
        "bad_cidr",
        [
            "10.13.13.5",          # missing mask
            "10.13.13.5/33",       # mask out of range
            "10.13.13.999/32",     # bad octet
            "garbage",
        ],
    )
    def test_per_element_cidr_validation(self, vpn_client: TestClient, bad_cidr: str) -> None:
        self._setup(vpn_client)
        # Bad element among otherwise-valid entries still trips the validator.
        resp = vpn_client.post(
            "/vpn/peers",
            json={"allowed_ips": ["10.13.13.5/32", bad_cidr]},
            headers=AUTH,
        )
        assert resp.status_code == 422

    def test_keepalive_bounds(self, vpn_client: TestClient) -> None:
        self._setup(vpn_client)
        resp = vpn_client.post(
            "/vpn/peers",
            json={"allowed_ips": ["10.13.13.5/32"], "persistent_keepalive": -1},
            headers=AUTH,
        )
        assert resp.status_code == 422


class TestVpnPeerDeleteSchema:
    """Boundary validation for DELETE /vpn/peers."""

    @pytest.mark.parametrize(
        "bad_pub",
        [
            "",                                        # empty
            "A" * 43,                                  # missing trailing '='
            "A" * 44,                                  # 44 chars but no '=' at end
            "A" * 42 + "==",                           # too much padding
            "!!!" + "A" * 40 + "=",                    # non-base64 chars
        ],
    )
    def test_invalid_pubkey_rejected(self, vpn_client: TestClient, bad_pub: str) -> None:
        resp = vpn_client.request(
            "DELETE", "/vpn/peers",
            json={"public_key": bad_pub},
            headers=AUTH,
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# 2. SDK behaviour
# ---------------------------------------------------------------------------


class TestVpnApiKeyGen:
    """Static keygen helpers — pure crypto, no router needed."""

    def test_generate_keypair_shape(self) -> None:
        priv, pub = VPNApi.generate_keypair()
        # Both keys are 32 bytes encoded as 44-char base64 with one '=' pad.
        assert len(priv) == 44 and priv.endswith("=")
        assert len(pub) == 44 and pub.endswith("=")
        assert len(b64decode(priv)) == 32
        assert len(b64decode(pub)) == 32
        # Each call returns a fresh keypair.
        priv2, pub2 = VPNApi.generate_keypair()
        assert (priv, pub) != (priv2, pub2)

    def test_derive_public_key_matches_generate(self) -> None:
        priv, pub = VPNApi.generate_keypair()
        # Re-deriving from the same priv must yield the same pub. This is the
        # invariant `get_interface_info` relies on so we don't have to store
        # the pubkey separately in uci.
        assert VPNApi.derive_public_key(priv) == pub

    def test_derive_public_key_rejects_garbage(self) -> None:
        # Padding is required for base64; reject decode failures with a clear
        # exception type (cryptography raises ValueError for bad lengths).
        with pytest.raises((ValueError, Exception)):
            VPNApi.derive_public_key("not-base64")


# Reusable fake UCI for SDK round-trip tests. Same pattern as
# tests/test_dns_hostnames.py::_FakeUci, slimmed for network-config use.

class _FakeUci:
    def __init__(self) -> None:
        self.sections: dict[str, dict] = {}
        self._counter = 0
        self.commits: list[str] = []

    def get(self, config, section=None, option=None, type=None):
        assert config == "network"
        if section:
            sec = self.sections.get(section)
            if sec is None:
                raise UbusError(4, f"section {section!r} not found")
            return {"values": dict(sec)}
        if type:
            values = {k: v for k, v in self.sections.items() if v.get(".type") == type}
            return {"values": values}
        return {"values": dict(self.sections)}

    def set(self, config, section, values):
        assert config == "network"
        body = self.sections.setdefault(section, {})
        body.setdefault(".type", "interface")
        body.update(values)

    def add(self, config, type, values=None, name=None):
        assert config == "network"
        self._counter += 1
        section = name or f"cfg{self._counter:02d}{type}"
        body = {".type": type}
        if values:
            body.update(values)
        self.sections[section] = body
        return {"section": section}

    def delete(self, config, section, option=None):
        assert config == "network"
        self.sections.pop(section, None)

    def commit(self, config):
        self.commits.append(config)


class _FakeRouter:
    def __init__(self) -> None:
        self.uci = _FakeUci()


@pytest.fixture
def vpn_api():
    router = _FakeRouter()
    return VPNApi(router), router


class TestVpnApiPeerLifecycle:
    """add_peer → list_peers → delete_peer round-trips on the fake UCI."""

    def test_interface_exists_false_when_unset(self, vpn_api) -> None:
        api, _ = vpn_api
        assert api.interface_exists("wg0") is False

    def test_create_then_get_interface_info(self, vpn_api) -> None:
        api, _ = vpn_api
        priv, pub = VPNApi.generate_keypair()
        api.create_interface("wg0", priv, listen_port=51820, address="10.13.13.1/24")

        assert api.interface_exists("wg0") is True
        info = api.get_interface_info("wg0")
        assert info["interface"] == "wg0"
        assert info["public_key"] == pub
        assert info["listen_port"] == 51820
        assert info["addresses"] == ["10.13.13.1/24"]

    def test_add_and_list_peers(self, vpn_api) -> None:
        api, _ = vpn_api
        priv, _ = VPNApi.generate_keypair()
        api.create_interface("wg0", priv)

        _, pub_a = VPNApi.generate_keypair()
        _, pub_b = VPNApi.generate_keypair()
        api.add_peer("wg0", pub_a, "10.13.13.2/32", description="iPhone")
        api.add_peer("wg0", pub_b, "10.13.13.3/32", description="laptop")

        peers = api.list_peers("wg0")
        keys = sorted(p["public_key"] for p in peers)
        assert keys == sorted([pub_a, pub_b])
        ips = {p["public_key"]: p["allowed_ips"] for p in peers}
        assert ips[pub_a] == ["10.13.13.2/32"]
        assert ips[pub_b] == ["10.13.13.3/32"]

    def test_delete_peer_removes_matching_only(self, vpn_api) -> None:
        api, _ = vpn_api
        priv, _ = VPNApi.generate_keypair()
        api.create_interface("wg0", priv)
        _, pub_a = VPNApi.generate_keypair()
        _, pub_b = VPNApi.generate_keypair()
        api.add_peer("wg0", pub_a, "10.13.13.2/32")
        api.add_peer("wg0", pub_b, "10.13.13.3/32")

        removed = api.delete_peer("wg0", pub_a)
        assert removed == 1
        remaining = [p["public_key"] for p in api.list_peers("wg0")]
        assert remaining == [pub_b]

    def test_delete_missing_returns_zero(self, vpn_api) -> None:
        api, _ = vpn_api
        priv, _ = VPNApi.generate_keypair()
        api.create_interface("wg0", priv)
        _, pub_unknown = VPNApi.generate_keypair()
        assert api.delete_peer("wg0", pub_unknown) == 0


# ---------------------------------------------------------------------------
# 3. REST endpoints (with MockRouter)
# ---------------------------------------------------------------------------


class TestVpnSetupEndpoint:
    def test_first_call_creates_interface(self, vpn_client: TestClient) -> None:
        resp = vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        assert resp.status_code == 200
        body = resp.json()
        assert body["created"] is True
        assert body["interface"] == "wg0"
        # Server pubkey is exposed so the orchestrator can render peer .conf.
        assert body["public_key"] and body["public_key"].endswith("=")
        assert body["listen_port"] == 51820

    def test_idempotent_on_second_call(self, vpn_client: TestClient) -> None:
        first = vpn_client.post("/vpn/setup", json={}, headers=AUTH).json()
        second = vpn_client.post("/vpn/setup", json={}, headers=AUTH).json()
        assert second["created"] is False
        # Pubkey is stable across calls — second invocation must NOT regenerate
        # the keypair, otherwise every peer config we've handed out would
        # silently stop authenticating.
        assert second["public_key"] == first["public_key"]


class TestVpnStatusEndpoint:
    def test_404_before_setup(self, vpn_client: TestClient) -> None:
        resp = vpn_client.get("/vpn/status", headers=AUTH)
        assert resp.status_code == 404

    def test_returns_info_after_setup(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        resp = vpn_client.get("/vpn/status", headers=AUTH)
        assert resp.status_code == 200
        body = resp.json()
        assert body["interface"] == "wg0"
        assert body["peer_count"] == 0
        assert body["public_key"].endswith("=")

    def test_peer_count_tracks_adds(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        vpn_client.post(
            "/vpn/peers", json={"allowed_ips": ["10.13.13.2/32"]}, headers=AUTH,
        )
        resp = vpn_client.get("/vpn/status", headers=AUTH)
        assert resp.json()["peer_count"] == 1


class TestVpnPeersEndpoint:
    def test_create_requires_setup(self, vpn_client: TestClient) -> None:
        resp = vpn_client.post(
            "/vpn/peers", json={"allowed_ips": ["10.13.13.2/32"]}, headers=AUTH,
        )
        assert resp.status_code == 409
        assert "setup" in resp.json()["detail"].lower()

    def test_create_returns_keypair(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        resp = vpn_client.post(
            "/vpn/peers",
            json={"allowed_ips": ["10.13.13.2/32"], "description": "iPhone"},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Both keys returned exactly once — orchestrator builds the .conf
        # from this response and never re-fetches the priv.
        assert body["private_key"].endswith("=")
        assert body["public_key"].endswith("=")
        assert body["allowed_ips"] == ["10.13.13.2/32"]
        assert body["description"] == "iPhone"
        # And derive(priv) must equal pub — invariant the orchestrator
        # relies on if it ever cross-checks.
        assert VPNApi.derive_public_key(body["private_key"]) == body["public_key"]

    def test_list_returns_added_peers(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        a = vpn_client.post(
            "/vpn/peers",
            json={"allowed_ips": ["10.13.13.2/32"], "description": "iPhone"},
            headers=AUTH,
        ).json()
        b = vpn_client.post(
            "/vpn/peers",
            json={"allowed_ips": ["10.13.13.3/32"], "description": "Laptop"},
            headers=AUTH,
        ).json()

        resp = vpn_client.get("/vpn/peers", headers=AUTH)
        assert resp.status_code == 200
        peers = resp.json()["peers"]
        keys = {p["public_key"] for p in peers}
        # The list MUST NOT leak any private key fields — only the orchestrator
        # gets those, and only at create time.
        for p in peers:
            assert "private_key" not in p
        assert keys == {a["public_key"], b["public_key"]}

    def test_delete_removes_peer(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        peer = vpn_client.post(
            "/vpn/peers", json={"allowed_ips": ["10.13.13.2/32"]}, headers=AUTH,
        ).json()

        resp = vpn_client.request(
            "DELETE", "/vpn/peers",
            json={"public_key": peer["public_key"]},
            headers=AUTH,
        )
        assert resp.status_code == 200
        assert resp.json()["removed"] == 1

        # Peer is gone from the list.
        listed = vpn_client.get("/vpn/peers", headers=AUTH).json()["peers"]
        assert listed == []

    def test_delete_missing_returns_404(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub_unknown = VPNApi.generate_keypair()
        resp = vpn_client.request(
            "DELETE", "/vpn/peers",
            json={"public_key": pub_unknown},
            headers=AUTH,
        )
        assert resp.status_code == 404


class TestVpnOverlayPeerEndpoint:
    """WARP-1385 — POST /vpn/peers/overlay installs a caller-keyed direct-punch
    peer with an endpoint + keepalive (no server-side keygen)."""

    def test_requires_setup(self, vpn_client: TestClient) -> None:
        _, pub = VPNApi.generate_keypair()
        resp = vpn_client.post(
            "/vpn/peers/overlay",
            json={
                "public_key": pub,
                "endpoint": "203.0.113.7:51820",
                "allowed_ips": ["10.13.13.9/32"],
            },
            headers=AUTH,
        )
        assert resp.status_code == 409
        assert "setup" in resp.json()["detail"].lower()

    def test_installs_peer_with_endpoint_and_keepalive(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub = VPNApi.generate_keypair()
        resp = vpn_client.post(
            "/vpn/peers/overlay",
            json={
                "public_key": pub,
                "endpoint": "203.0.113.7:51820",
                "allowed_ips": ["10.13.13.9/32"],
                "persistent_keepalive": 25,
                "description": "overlay sess-42",
            },
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Never mints or returns a private key — the phone brings its own key.
        assert "private_key" not in body
        assert body["public_key"] == pub
        assert body["endpoint"] == "203.0.113.7:51820"

        # The installed peer carries the phone's key + observed endpoint + keepalive.
        peers = vpn_client.get("/vpn/peers", headers=AUTH).json()["peers"]
        match = [p for p in peers if p["public_key"] == pub]
        assert len(match) == 1
        assert match[0]["endpoint_host"] == "203.0.113.7:51820"
        assert str(match[0]["persistent_keepalive"]) == "25"
        assert match[0]["allowed_ips"] == ["10.13.13.9/32"]

    def test_reinstall_refreshes_endpoint_no_duplicate(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub = VPNApi.generate_keypair()
        base = {
            "public_key": pub,
            "allowed_ips": ["10.13.13.9/32"],
            "persistent_keepalive": 25,
        }
        vpn_client.post("/vpn/peers/overlay", json={**base, "endpoint": "203.0.113.7:51820"}, headers=AUTH)
        # Re-connect from a new observed endpoint — must REFRESH, not duplicate.
        vpn_client.post("/vpn/peers/overlay", json={**base, "endpoint": "198.51.100.9:40000"}, headers=AUTH)
        peers = vpn_client.get("/vpn/peers", headers=AUTH).json()["peers"]
        match = [p for p in peers if p["public_key"] == pub]
        assert len(match) == 1  # refreshed in place, no duplicate section
        assert match[0]["endpoint_host"] == "198.51.100.9:40000"

    def test_installs_peer_without_an_endpoint(self, vpn_client: TestClient) -> None:
        """WARP-1757 — a client-initiated peer needs no endpoint.

        WireGuard learns a peer's endpoint from its first authenticated
        handshake. The box needs one configured only when the BOX must initiate
        (the NAT hole-punch). A peer installed at approval time — before any
        punch, and for a box that is its own edge router, behind a successful
        port map, or reached over the LAN — must install WITHOUT one, or those
        paths would be forced through a rendezvous they don't need.
        """
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub = VPNApi.generate_keypair()
        resp = vpn_client.post(
            "/vpn/peers/overlay",
            json={
                "public_key": pub,
                "allowed_ips": ["10.13.13.9/32"],
                "persistent_keepalive": 25,
                "description": "Phone",
            },
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["endpoint"] is None
        assert "private_key" not in resp.json()

        peers = vpn_client.get("/vpn/peers", headers=AUTH).json()["peers"]
        match = [p for p in peers if p["public_key"] == pub]
        assert len(match) == 1
        # endpoint_host must be ABSENT (or empty), never the literal "None".
        assert not match[0].get("endpoint_host")
        assert match[0]["allowed_ips"] == ["10.13.13.9/32"]

    def test_punch_can_add_an_endpoint_to_a_peer_installed_without_one(
        self, vpn_client: TestClient
    ) -> None:
        """The connect tick still upgrades an endpoint-less peer when a punch
        genuinely is needed — approval-time install must not foreclose it."""
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub = VPNApi.generate_keypair()
        base = {"public_key": pub, "allowed_ips": ["10.13.13.9/32"], "persistent_keepalive": 25}
        vpn_client.post("/vpn/peers/overlay", json=base, headers=AUTH)
        vpn_client.post(
            "/vpn/peers/overlay",
            json={**base, "endpoint": "198.51.100.9:40000"},
            headers=AUTH,
        )
        peers = vpn_client.get("/vpn/peers", headers=AUTH).json()["peers"]
        match = [p for p in peers if p["public_key"] == pub]
        assert len(match) == 1  # refreshed in place, no duplicate section
        assert match[0]["endpoint_host"] == "198.51.100.9:40000"

    @pytest.mark.parametrize("bad_ep", ["notanip", "203.0.113.7", "203.0.113.7:", "203.0.113.7:99999999"])
    def test_rejects_bad_endpoint(self, vpn_client: TestClient, bad_ep: str) -> None:
        """A PRESENT endpoint is still strictly validated — WARP-1757 made it
        optional, not unvalidated."""
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub = VPNApi.generate_keypair()
        resp = vpn_client.post(
            "/vpn/peers/overlay",
            json={"public_key": pub, "endpoint": bad_ep, "allowed_ips": ["10.13.13.9/32"]},
            headers=AUTH,
        )
        assert resp.status_code == 422


class TestVpnPeerHandshakeEnrichment:
    """WARP-1389 — GET /vpn/peers enriches each peer with `latest_handshake`
    (runtime epoch, 0 = never/unknown) for the overlay punch-success telemetry."""

    def test_list_peers_carries_latest_handshake_zero_by_default(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub = VPNApi.generate_keypair()
        vpn_client.post(
            "/vpn/peers/overlay",
            json={"public_key": pub, "endpoint": "203.0.113.7:51820", "allowed_ips": ["10.13.13.9/32"]},
            headers=AUTH,
        )
        peers = vpn_client.get("/vpn/peers", headers=AUTH).json()["peers"]
        match = [p for p in peers if p["public_key"] == pub]
        assert len(match) == 1
        # Field present, 0 when the peer has not handshook.
        assert match[0]["latest_handshake"] == 0

    def test_list_peers_reflects_a_real_handshake(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub = VPNApi.generate_keypair()
        vpn_client.post(
            "/vpn/peers/overlay",
            json={"public_key": pub, "endpoint": "203.0.113.7:51820", "allowed_ips": ["10.13.13.9/32"]},
            headers=AUTH,
        )
        # Simulate the peer completing a handshake (punch succeeded).
        main.router_instance.vpn._handshakes[pub] = 1_784_000_000
        peers = vpn_client.get("/vpn/peers", headers=AUTH).json()["peers"]
        match = [p for p in peers if p["public_key"] == pub]
        assert match[0]["latest_handshake"] == 1_784_000_000

    def test_peer_handshakes_scopes_to_known_peers(self, vpn_client: TestClient) -> None:
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        # A handshake for a pubkey with no peer section must not leak into the list.
        main.router_instance.vpn._handshakes["GHOSTKEY"] = 999
        assert main.router_instance.vpn.peer_handshakes("wg0") == {}

    def test_list_peers_OMITS_latest_handshake_when_runtime_data_unavailable(self, vpn_client: TestClient) -> None:
        # UNKNOWN (ubus status carries no peer data) must be DISTINCT from an
        # observed 0 — the field is omitted entirely, never defaulted to 0, or
        # the orchestrator would score every torn-down peer as a false failure.
        vpn_client.post("/vpn/setup", json={}, headers=AUTH)
        _, pub = VPNApi.generate_keypair()
        vpn_client.post(
            "/vpn/peers/overlay",
            json={"public_key": pub, "endpoint": "203.0.113.7:51820", "allowed_ips": ["10.13.13.9/32"]},
            headers=AUTH,
        )
        main.router_instance.vpn._handshakes_available = False
        assert main.router_instance.vpn.peer_handshakes("wg0") is None
        peers = vpn_client.get("/vpn/peers", headers=AUTH).json()["peers"]
        match = [p for p in peers if p["public_key"] == pub]
        assert len(match) == 1
        assert "latest_handshake" not in match[0]  # UNKNOWN → field absent


class TestVpnEndpointsRequireRouter:
    def test_setup_503_when_disconnected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).post("/vpn/setup", json={}, headers=AUTH)
        assert resp.status_code == 503

    def test_status_503_when_disconnected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).get("/vpn/status", headers=AUTH)
        assert resp.status_code == 503
