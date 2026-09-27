"""WARP-3193 SEC-INJ-4 — static-lease and upstream-DNS writes are typed.

Both requests land in UCI and from there in dnsmasq's generated config, one
directive per line. Before this, `ip`, `name`, `leasetime` and each DNS server
were bare strings, so a newline in any of them was one hop away from an extra
dnsmasq directive (e.g. `address=/bank.example/10.0.0.66`, a LAN-wide DNS
hijack). The schema is now the boundary: anything that is not an address, a
hostname label or a dnsmasq lease time is a 422 and never reaches the router.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from schemas import SetDnsRequest, StaticLeaseRequest

AUTH = {"authorization": "Bearer pytest-fake-token"}
MAC = "AA:BB:CC:DD:EE:FF"


class TestStaticLeaseSchema:
    def test_ordinary_lease_is_accepted(self) -> None:
        req = StaticLeaseRequest(name="living-room-tv", mac=MAC, ip="192.168.50.20")
        assert (req.name, req.ip, req.leasetime) == ("living-room-tv", "192.168.50.20", "infinite")

    @pytest.mark.parametrize(
        "ip",
        [
            "192.168.50.20\naddress=/bank.example/10.0.0.66",
            "192.168.50.20 ",
            "192.168.50.256",
            "fe80::1",
            "host.lan",
            "",
        ],
    )
    def test_ip_must_be_a_literal_ipv4(self, ip: str) -> None:
        with pytest.raises(ValidationError):
            StaticLeaseRequest(name="tv", mac=MAC, ip=ip)

    @pytest.mark.parametrize(
        "name",
        [
            "tv\naddress=/bank.example/10.0.0.66",
            "Living Room TV",
            "tv,192.168.50.99",
            "-tv",
            "tv-",
            "a" * 64,
            "",
        ],
    )
    def test_name_must_be_a_hostname_label(self, name: str) -> None:
        with pytest.raises(ValidationError):
            StaticLeaseRequest(name=name, mac=MAC, ip="192.168.50.20")

    @pytest.mark.parametrize("leasetime", ["12h\ndhcp-option=6,10.0.0.66", "forever", "12", ""])
    def test_leasetime_must_be_a_dnsmasq_value(self, leasetime: str) -> None:
        with pytest.raises(ValidationError):
            StaticLeaseRequest(name="tv", mac=MAC, ip="192.168.50.20", leasetime=leasetime)

    @pytest.mark.parametrize("leasetime", ["infinite", "12h", "30m", "1d"])
    def test_dnsmasq_leasetimes_are_accepted(self, leasetime: str) -> None:
        assert StaticLeaseRequest(name="tv", mac=MAC, ip="192.168.50.20", leasetime=leasetime).leasetime == leasetime

    def test_mac_with_trailing_newline_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            StaticLeaseRequest(name="tv", mac=MAC + "\n", ip="192.168.50.20")


class TestSetDnsSchema:
    def test_ipv4_and_ipv6_servers_are_accepted(self) -> None:
        req = SetDnsRequest(servers=["1.1.1.1", "2606:4700:4700::1111"])
        assert req.servers == ["1.1.1.1", "2606:4700:4700::1111"]

    @pytest.mark.parametrize(
        "servers",
        [
            ["1.1.1.1\nserver=/bank.example/10.0.0.66"],
            ["1.1.1.1 8.8.8.8"],
            ["dns.google"],
            [""],
            [],
            ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9"],
        ],
    )
    def test_servers_must_be_one_to_four_ip_literals(self, servers: list[str]) -> None:
        with pytest.raises(ValidationError):
            SetDnsRequest(servers=servers)


class TestRoutesRefuseBeforeTouchingTheRouter:
    def test_static_lease_newline_is_a_422_and_no_uci_write(self, connected_client: TestClient, mock_router) -> None:
        resp = connected_client.post(
            "/dhcp/static-lease",
            json={"name": "tv", "mac": MAC, "ip": "192.168.50.20\naddress=/bank.example/10.0.0.66"},
            headers=AUTH,
        )
        assert resp.status_code == 422
        mock_router.uci.add.assert_not_called()

    def test_dns_newline_is_a_422_and_no_uci_write(self, connected_client: TestClient, mock_router) -> None:
        resp = connected_client.post(
            "/dhcp/dns",
            json={"servers": ["1.1.1.1\nserver=/bank.example/10.0.0.66"]},
            headers=AUTH,
        )
        assert resp.status_code == 422
        mock_router.uci.set.assert_not_called()

    def test_valid_static_lease_writes_the_canonical_values(self, connected_client: TestClient, mock_router) -> None:
        resp = connected_client.post(
            "/dhcp/static-lease",
            json={"name": "tv", "mac": MAC, "ip": "192.168.50.20"},
            headers=AUTH,
        )
        assert resp.status_code == 200, resp.text
        mock_router.dhcp.add_static_lease.assert_called_once_with("tv", MAC, "192.168.50.20", "infinite")
