"""WARP-1721: the AP-approval router-staging gate must fail CLOSED on the
edge-router shape.

The old gate (`bool(wireless.status())`) counted a bare radio envelope as
"router has AP radios". The real Pi edge router answers exactly that shape —
radio up, disabled false, ZERO interfaces (its `disabled='1'` lives on the
wifi-iface, not the wifi-device) — so approving the discovered AP would have
staged a router-side wifi-iface and put an ON-BOX AP on the air, violating
the ADR-033 §3 founder rule ("onboard radios are never APs"). Verified live
2026-08-04, the same day WARP-1720 made discovery work and armed the path.

Two rules under test:
1. SHAPE RULE — an AP credential provisioned ⇒ staging NEVER allowed,
   deterministically, regardless of what the radio probe says.
2. LEGACY PROBE — without a credential, stage only when a radio actually
   SERVES something (non-empty `interfaces`, or the historical inline-ssid
   shape). Probe errors still fail open there, because on single-box the
   router-side write IS the approval and skipping it would be a silent no-op.
"""

from __future__ import annotations

from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import ConnectionLost
from main import _router_side_staging_allowed
from mock_router import MockRouter


# The VERBATIM shape the real Pi edge router returned on 2026-08-04
# (`ubus call network.wireless status` on droplet-edge). If this fixture
# ever needs changing, capture it from hardware again — do not invent it.
LIVE_PI_ENVELOPE = {
    "radio0": {
        "up": True,
        "pending": False,
        "autostart": True,
        "disabled": False,
        "retry_setup_failed": False,
        "config": {"channel": "34", "htmode": "NOHT"},
        "interfaces": [],
    }
}

# A router whose radio genuinely serves wireless (real netifd shape).
SERVING_ENVELOPE = {
    "radio0": {
        "up": True,
        "disabled": False,
        "interfaces": [
            {"section": "default_radio0", "ifname": "wlan0",
             "config": {"ssid": "Droplet", "mode": "ap"}},
        ],
    }
}


class _StubWireless:
    def __init__(self, envelope=None, raises=None):
        self._envelope = envelope
        self._raises = raises

    def status(self):
        if self._raises is not None:
            raise self._raises
        return self._envelope


class _StubRouter:
    def __init__(self, envelope=None, raises=None):
        self.wireless = _StubWireless(envelope, raises)


class TestShapeRule:
    """Rule 1: credential provisioned ⇒ never stage, no probe consulted."""

    def test_credential_wins_over_serving_radios(self, monkeypatch):
        monkeypatch.setattr(main, "AP_PASSWORD", "per-unit-ap-pw")
        assert _router_side_staging_allowed(_StubRouter(SERVING_ENVELOPE)) is False

    def test_credential_wins_over_probe_errors(self, monkeypatch):
        # Even a broken probe cannot re-open the path: the shape rule
        # short-circuits before any I/O.
        monkeypatch.setattr(main, "AP_PASSWORD", "per-unit-ap-pw")
        assert _router_side_staging_allowed(
            _StubRouter(raises=ConnectionLost("down"))
        ) is False

    def test_credential_wins_over_mock_shape(self, monkeypatch):
        monkeypatch.setattr(main, "AP_PASSWORD", "per-unit-ap-pw")
        assert _router_side_staging_allowed(MockRouter()) is False


class TestLegacyProbe:
    """Rule 2: no credential — stage only for a radio that serves."""

    @pytest.fixture(autouse=True)
    def _no_credential(self, monkeypatch):
        monkeypatch.setattr(main, "AP_PASSWORD", "")

    def test_live_pi_envelope_is_not_a_serving_router(self):
        # THE WARP-1721 regression: up-with-zero-interfaces must not count.
        assert _router_side_staging_allowed(_StubRouter(LIVE_PI_ENVELOPE)) is False

    def test_serving_radio_still_stages(self):
        assert _router_side_staging_allowed(_StubRouter(SERVING_ENVELOPE)) is True

    def test_inline_ssid_shape_still_stages(self):
        # The historical status shape (and the mock's): ssid on the radio.
        assert _router_side_staging_allowed(MockRouter()) is True

    def test_empty_status_is_radio_less(self):
        assert _router_side_staging_allowed(_StubRouter({})) is False

    def test_probe_error_fails_open_on_legacy(self):
        # Unchanged legacy semantics: single-box approval must not become a
        # silent no-op on a transient read error.
        assert _router_side_staging_allowed(
            _StubRouter(raises=ConnectionLost("transient"))
        ) is True

    def test_router_without_wireless_api_fails_open(self):
        class Bare:
            pass

        assert _router_side_staging_allowed(Bare()) is True


class _FakeApDevice:
    """Stands in for main.DropletRouter in the AP-direct push. Records the
    uci writes so the test can assert the AP itself was configured."""

    instances: list["_FakeApDevice"] = []

    def __init__(self, host, port, username, password, **kwargs):
        self.host = host
        self.writes: list[tuple] = []
        _FakeApDevice.instances.append(self)

    class _Uci:
        def __init__(self, outer):
            self._o = outer

        def set(self, *a, **kw):
            self._o.writes.append(("set", a, kw))

        def commit(self, *a, **kw):
            self._o.writes.append(("commit", a, kw))

        def get(self, *a, **kw):
            # The shape `_push_ap_wireless` enumerates before writing —
            # same fixture shape as test_aps_direct's _FakeApDevice.
            return {"values": {
                "default_radio0": {".type": "wifi-iface"},
                "default_radio1": {".type": "wifi-iface"},
            }}

        def __getattr__(self, name):
            # App startup (scheduler warmup) may dial this fake before the
            # test's request does — answer anything benignly.
            def _noop(*a, **kw):
                return {}

            return _noop

    @property
    def uci(self):
        return _FakeApDevice._Uci(self)

    def _call(self, *a, **kw):
        return {}

    @contextmanager
    def safe_apply(self, timeout=60):
        # The AP-side apply guard — a no-op here; the assertion that matters
        # is that the ROUTER's safe_apply is never entered.
        yield

    def close(self):
        pass


class TestApproveEndToEndOnEdgeRouterShape:
    """The endpoint-level guarantee: with an AP credential, approve returns
    router_staged=False, never touches the router's safe_apply, and still
    configures the AP itself."""

    @pytest.fixture
    def client(self, monkeypatch):
        router = MockRouter()
        calls = {"safe_apply": 0}
        original = router.safe_apply

        def counting_safe_apply(*a, **kw):
            calls["safe_apply"] += 1
            return original(*a, **kw)

        monkeypatch.setattr(router, "safe_apply", counting_safe_apply)
        monkeypatch.setattr(main, "router_instance", router)
        monkeypatch.setattr(main, "AP_PASSWORD", "per-unit-ap-pw")
        monkeypatch.setattr(main, "DropletRouter", _FakeApDevice)
        _FakeApDevice.instances.clear()
        client = TestClient(main.app)
        client._calls = calls  # type: ignore[attr-defined]
        client._router = router  # type: ignore[attr-defined]
        return client

    AUTH = {"authorization": "Bearer pytest-fake-token"}

    def test_approve_is_ap_direct_only(self, client):
        mac = "B8:27:EB:12:34:56"
        # Mock discovery must know the AP so approval can resolve an address.
        seed = client.post(
            "/aps/_test_seed",
            json={"mac": mac, "last_ip": "192.168.9.180"},
            headers=self.AUTH,
        )
        assert seed.status_code == 200, seed.text

        resp = client.post(
            f"/aps/{mac}/approve",
            json={"ssid": "droplet-net", "encryption_key": "longenoughpw"},
            headers=self.AUTH,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["router_staged"] is False
        assert body["ap_configured"] is True
        assert client._calls["safe_apply"] == 0
        assert any(
            i.host == "192.168.9.180" for i in _FakeApDevice.instances
        ), "AP itself was never dialed at its discovered address"
