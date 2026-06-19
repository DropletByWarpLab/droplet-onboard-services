"""DHCP LAN pool range + lease-time editor (full stack, buildable-now).

Three layers, mirroring test_upnp.py:

1. **SDK behaviour** — `DHCPApi.get_lan_pool` reads the `dhcp lan` UCI section
   (start/limit/leasetime); `set_lan_pool` writes those three fields + commits.
2. **Schema** — `DhcpPoolRequest` bounds start 2-254, limit 1-253, and accepts
   only dnsmasq lease-time formats (`12h`, `2m`, `infinite`).
3. **REST endpoints** — GET reflects the pool; POST writes + reloads dnsmasq.
4. **Auth** — bearer required for the write.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from droplet_openwrt_sdk import DHCPApi
from schemas import DhcpPoolRequest

AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# 1. SDK behaviour
# ---------------------------------------------------------------------------


class TestDhcpApiPool:
    def test_get_lan_pool_reads_section(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {
            ".type": "dhcp",
            "interface": "lan",
            "start": "100",
            "limit": "150",
            "leasetime": "12h",
        }
        pool = DHCPApi(router).get_lan_pool()
        router.uci.get.assert_called_once_with("dhcp", "lan")
        assert pool == {"start": "100", "limit": "150", "leasetime": "12h"}

    def test_get_lan_pool_tolerates_missing_fields(self) -> None:
        # A `dhcp lan` section can omit any of the three (defaults apply).
        router = MagicMock()
        router.uci.get.return_value = {".type": "dhcp", "interface": "lan"}
        pool = DHCPApi(router).get_lan_pool()
        assert pool == {"start": None, "limit": None, "leasetime": None}

    def test_set_lan_pool_writes_three_fields_and_commits(self) -> None:
        router = MagicMock()
        DHCPApi(router).set_lan_pool(100, 150, "12h")
        cfg, section, values = router.uci.set.call_args.args
        assert cfg == "dhcp" and section == "lan"
        assert values == {"start": "100", "limit": "150", "leasetime": "12h"}
        router.uci.commit.assert_called_once_with("dhcp")


# ---------------------------------------------------------------------------
# 2. Schema validation
# ---------------------------------------------------------------------------


class TestDhcpPoolRequest:
    def test_accepts_valid(self) -> None:
        req = DhcpPoolRequest(start=100, limit=150, leasetime="12h")
        assert req.start == 100 and req.limit == 150 and req.leasetime == "12h"

    def test_accepts_infinite_leasetime(self) -> None:
        assert DhcpPoolRequest(start=2, limit=1, leasetime="infinite").leasetime == "infinite"

    @pytest.mark.parametrize("start", [1, 0, 255, 300])
    def test_rejects_out_of_range_start(self, start: int) -> None:
        with pytest.raises(ValidationError):
            DhcpPoolRequest(start=start, limit=150, leasetime="12h")

    @pytest.mark.parametrize("limit", [0, 254, 500])
    def test_rejects_out_of_range_limit(self, limit: int) -> None:
        with pytest.raises(ValidationError):
            DhcpPoolRequest(start=100, limit=limit, leasetime="12h")

    @pytest.mark.parametrize("lt", ["", "forever", "12hh", "abc", "12 h", "-1h"])
    def test_rejects_bad_leasetime(self, lt: str) -> None:
        with pytest.raises(ValidationError):
            DhcpPoolRequest(start=100, limit=150, leasetime=lt)


# ---------------------------------------------------------------------------
# 3. REST endpoints
# ---------------------------------------------------------------------------


class TestDhcpPoolEndpoints:
    def test_get_reflects_pool(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.dhcp.get_lan_pool.return_value = {
            "start": "100",
            "limit": "150",
            "leasetime": "12h",
        }
        resp = connected_client.get("/dhcp/pool", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"start": "100", "limit": "150", "leasetime": "12h"}

    def test_post_writes_and_reloads(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post(
            "/dhcp/pool",
            json={"start": 120, "limit": 130, "leasetime": "24h"},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "ok"
        mock_router.dhcp.set_lan_pool.assert_called_once_with(120, 130, "24h")
        # dnsmasq must re-read the pool — same reload the static-lease route uses.
        mock_router.exec_service.assert_called_once_with("dnsmasq", "restart")

    def test_post_422_on_bad_bounds(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post(
            "/dhcp/pool",
            json={"start": 1, "limit": 150, "leasetime": "12h"},
            headers=AUTH,
        )
        assert resp.status_code == 422, resp.text
        mock_router.dhcp.set_lan_pool.assert_not_called()


# ---------------------------------------------------------------------------
# 4. Auth
# ---------------------------------------------------------------------------


class TestDhcpPoolAuth:
    def test_write_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.post(
            "/dhcp/pool", json={"start": 100, "limit": 150, "leasetime": "12h"}
        )
        assert resp.status_code == 401
