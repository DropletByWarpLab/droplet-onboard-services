"""System controls — hostname + NTP (real on the container) and the honest
read-only country + status-LED gate.

Layers, mirroring test_upnp.py:

1. **SDK** — `SystemApi.set_ntp_enabled` writes the in-container sysntpd flag +
   commits; `SystemApi.controls` reads hostname + ntp + a country value, and
   reports status-LED / country-edit as unsupported on the container shape.
2. **Schema** — `HostnameRequest` enforces the hostname grammar; `NtpRequest`
   is a plain bool.
3. **REST endpoints** — GET /system/controls reflects state; POST /system/hostname
   + POST /system/ntp dispatch.
4. **Auth** — bearer required for the writes.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from droplet_openwrt_sdk import SystemApi
from schemas import HostnameRequest, NtpRequest

AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# 1. SDK behaviour
# ---------------------------------------------------------------------------


class TestSystemApiNtp:
    def test_set_ntp_enabled_true_writes_and_commits(self) -> None:
        router = MagicMock()
        SystemApi(router).set_ntp_enabled(True)
        cfg, section, values = router.uci.set.call_args.args
        assert cfg == "system" and section == "@timeserver[0]"
        assert values == {"enabled": "1", "enable_server": "1"}
        router.uci.commit.assert_called_with("system")

    def test_set_ntp_enabled_false_writes_zeros(self) -> None:
        router = MagicMock()
        SystemApi(router).set_ntp_enabled(False)
        _, _, values = router.uci.set.call_args.args
        assert values == {"enabled": "0", "enable_server": "0"}


class TestSystemApiControls:
    def test_controls_reads_hostname_ntp_and_gates_led_country(self) -> None:
        router = MagicMock()
        # board_info() goes through router._call("system", "board") in the SDK.
        router._call.return_value = {"hostname": "droplet-rack-01"}

        def uci_get(config, section=None, option=None, **kwargs):
            if config == "system" and section == "@timeserver[0]" and option == "enabled":
                return {"value": "1"}
            if config == "wireless":
                return {"radio0": {"country": "US"}}
            return {}

        router.uci.get.side_effect = uci_get
        controls = SystemApi(router).controls(ap_mode="hostapd")

        assert controls["hostname"] == "droplet-rack-01"
        assert controls["ntp_enabled"] is True
        # Honest gate on the container shape: no system.led surface, no live radio.
        assert controls["status_led"]["supported"] is False
        assert controls["country"]["editable"] is False
        # ...but the live country value is still surfaced read-only.
        assert controls["country"]["value"] == "US"

    def test_controls_ntp_disabled_when_flag_zero(self) -> None:
        router = MagicMock()
        router._call.return_value = {"hostname": "h"}

        def uci_get(config, section=None, option=None, **kwargs):
            if config == "system" and section == "@timeserver[0]" and option == "enabled":
                return {"value": "0"}
            return {}

        router.uci.get.side_effect = uci_get
        controls = SystemApi(router).controls(ap_mode="hostapd")
        assert controls["ntp_enabled"] is False


# ---------------------------------------------------------------------------
# 2. Schema validation
# ---------------------------------------------------------------------------


class TestHostnameRequest:
    def test_accepts_valid(self) -> None:
        assert HostnameRequest(hostname="droplet-rack-01").hostname == "droplet-rack-01"

    @pytest.mark.parametrize("bad", ["", "-leading", "trailing-", "Has Space", "UPPER".lower() + "_x"])
    def test_rejects_bad_hostname(self, bad: str) -> None:
        with pytest.raises(ValidationError):
            HostnameRequest(hostname=bad)

    def test_ntp_request_is_bool(self) -> None:
        assert NtpRequest(enabled=True).enabled is True


# ---------------------------------------------------------------------------
# 3. REST endpoints
# ---------------------------------------------------------------------------


class TestSystemControlsEndpoints:
    def test_get_controls_reflects_state(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.system.controls.return_value = {
            "hostname": "droplet-rack-01",
            "ntp_enabled": True,
            "status_led": {"supported": False, "enabled": False},
            "country": {"value": "US", "editable": False},
        }
        resp = connected_client.get("/system/controls", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["hostname"] == "droplet-rack-01"
        assert body["status_led"]["supported"] is False
        assert body["country"]["editable"] is False

    def test_post_hostname_dispatches(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post(
            "/system/hostname", json={"hostname": "studio-droplet"}, headers=AUTH
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "ok"
        mock_router.system.set_hostname.assert_called_once_with("studio-droplet")

    def test_post_hostname_422_on_bad(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post("/system/hostname", json={"hostname": "Bad Name"}, headers=AUTH)
        assert resp.status_code == 422, resp.text
        mock_router.system.set_hostname.assert_not_called()

    def test_post_ntp_dispatches(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post("/system/ntp", json={"enabled": False}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "ok"
        mock_router.system.set_ntp_enabled.assert_called_once_with(False)


# ---------------------------------------------------------------------------
# 4. Auth
# ---------------------------------------------------------------------------


class TestSystemControlsAuth:
    def test_hostname_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.post("/system/hostname", json={"hostname": "x"})
        assert resp.status_code == 401

    def test_ntp_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.post("/system/ntp", json={"enabled": True})
        assert resp.status_code == 401
