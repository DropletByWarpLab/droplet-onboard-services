"""KAN-8 — routing-service routes for the router firmware path.

* ``GET  /system/firmware-check`` — read-only version compare (board_info vs the
  pinned image). Safe on any shape.
* ``POST /system/sysupgrade``     — flash a staged image. BRICK RISK.
* ``POST /system/factory-reset``  — wipe overlay + reboot. BRICK RISK.

The routing layer is the SDK's HTTP face. The AUTHORITATIVE deployment-shape gate
and the owner-only Tier-3 confirm live in the orchestrator ABOVE this; here we pin
the route shape, the bearer auth, and that the write routes dispatch the SDK
method. We do NOT exercise a real flash — the MockRouter records the call.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from mock_router import MockRouter


AUTH = {"authorization": "Bearer pytest-fake-token"}

# A pinned image whose name carries the same version the mock board reports
# (SNAPSHOT) would never compare equal; use a versioned name so the read is
# deterministic and the compare result is asserted, not just the 200.
PINNED_IMAGE = "openwrt-24.10.0-droplet-squashfs-sysupgrade.img.gz"


def _client(monkeypatch: pytest.MonkeyPatch) -> tuple[TestClient, MockRouter]:
    router = MockRouter()
    monkeypatch.setattr(main, "router_instance", router)
    return TestClient(main.app), router


class TestFirmwareCheckEndpoint:
    def test_returns_version_compare(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client, _ = _client(monkeypatch)
        resp = client.get(
            "/system/firmware-check",
            params={"pinned_image": PINNED_IMAGE},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # The mock board reports release.version == "SNAPSHOT".
        assert body["current_version"] == "SNAPSHOT"
        assert body["pinned_version"] == "24.10.0"
        # SNAPSHOT != 24.10.0 → an upgrade is available (explicit booleans).
        assert body["up_to_date"] is False
        assert body["upgrade_available"] is True

    def test_requires_bearer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client, _ = _client(monkeypatch)
        resp = client.get(
            "/system/firmware-check", params={"pinned_image": PINNED_IMAGE}
        )
        assert resp.status_code == 401

    def test_503_when_router_disconnected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "router_instance", None)
        resp = TestClient(main.app).get(
            "/system/firmware-check", params={"pinned_image": PINNED_IMAGE}, headers=AUTH
        )
        assert resp.status_code == 503


class TestSysupgradeEndpoint:
    def test_dispatches_sysupgrade_with_image(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, router = _client(monkeypatch)
        resp = client.post(
            "/system/sysupgrade",
            json={"image_path": "/tmp/openwrt-24.10.0-sysupgrade.img.gz"},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "flashing"
        # The mock recorded the call with the right image + preserve default.
        assert router.system.sysupgrade_calls == [
            ("/tmp/openwrt-24.10.0-sysupgrade.img.gz", True)
        ]

    def test_no_preserve_flag_threads_through(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, router = _client(monkeypatch)
        resp = client.post(
            "/system/sysupgrade",
            json={"image_path": "/tmp/img.gz", "preserve_config": False},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert router.system.sysupgrade_calls == [("/tmp/img.gz", False)]

    def test_rejects_missing_image_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client, router = _client(monkeypatch)
        resp = client.post("/system/sysupgrade", json={}, headers=AUTH)
        assert resp.status_code == 422  # pydantic: image_path required
        assert router.system.sysupgrade_calls == []

    def test_requires_bearer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client, router = _client(monkeypatch)
        resp = client.post(
            "/system/sysupgrade", json={"image_path": "/tmp/img.gz"}
        )
        assert resp.status_code == 401
        assert router.system.sysupgrade_calls == []


class TestFactoryResetEndpoint:
    def test_dispatches_factory_reset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client, router = _client(monkeypatch)
        resp = client.post("/system/factory-reset", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "resetting"
        assert router.system.factory_reset_calls == 1

    def test_requires_bearer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client, router = _client(monkeypatch)
        resp = client.post("/system/factory-reset")
        assert resp.status_code == 401
        assert router.system.factory_reset_calls == 0
