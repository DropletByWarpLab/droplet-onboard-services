"""Read-only radio detail — GET /wireless/radio (no device segment).

The orchestrator reads the host AP radio's iwinfo without knowing the device
name, letting the SDK resolve DROPLET_WIFI_SCAN_DEVICE. An absent radio is data,
not a crash — radio_info() already degrades to {} (test_wireless_shape covers
the SDK side); here we pin the route surface.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

AUTH = {"authorization": "Bearer pytest-fake-token"}


class TestRadioDetailEndpoint:
    def test_returns_iwinfo_fields(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.wireless.radio_info.return_value = {
            "channel": 6,
            "htmode": "HT20",
            "txpower": 20,
            "country": "US",
            "mode": "Master",
        }
        resp = connected_client.get("/wireless/radio", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["channel"] == 6
        # device omitted → SDK resolves the configured scan device.
        mock_router.wireless.radio_info.assert_called_once_with(None)

    def test_empty_on_absent_radio(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.wireless.radio_info.return_value = {}
        resp = connected_client.get("/wireless/radio", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {}

    def test_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.get("/wireless/radio")
        assert resp.status_code == 401
