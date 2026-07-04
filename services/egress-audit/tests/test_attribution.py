"""WARP-268 — src-IP → compose-service attribution."""
from __future__ import annotations

from conftest import FIXTURES
from attribution import Attributor, build_ip_map, service_from_container_name

NETWORK_JSON = (FIXTURES / "docker_network_inspect.json").read_text()
IP_ADDR_JSON = (FIXTURES / "ip_addr.json").read_text()


class TestNameMapping:
    def test_compose_replica_names(self):
        assert service_from_container_name("droplet-ai-gateway-1") == "ai-gateway"
        assert service_from_container_name("droplet-web-dashboard-2") == "web-dashboard"

    def test_explicit_container_names(self):
        assert service_from_container_name("droplet-openwrt") == "openwrt"
        assert service_from_container_name("/droplet-cloudflared") == "cloudflared"


class TestBuildIpMap:
    def test_container_ips_and_subnet(self):
        m = build_ip_map(NETWORK_JSON, IP_ADDR_JSON)
        assert m.by_ip["172.18.0.7"] == "ai-gateway"
        assert m.by_ip["172.18.0.12"] == "openwrt"
        assert str(m.subnets[0]) == "172.18.0.0/16"

    def test_host_ips_exclude_loopback(self):
        m = build_ip_map(NETWORK_JSON, IP_ADDR_JSON)
        assert "192.168.1.87" in m.host_ips
        assert "172.18.0.1" in m.host_ips
        assert "127.0.0.1" not in m.host_ips


def _attributor(network_json=NETWORK_JSON, clock=None, **kw):
    fetches = {"n": 0}
    def fetch_network():
        fetches["n"] += 1
        return network_json if isinstance(network_json, str) else network_json[min(fetches["n"], len(network_json)) - 1]
    a = Attributor(
        fetch_network_json=fetch_network,
        fetch_ip_addr_json=lambda: IP_ADDR_JSON,
        clock=clock or (lambda: 0.0),
        **kw,
    )
    return a, fetches


class TestAttributor:
    def test_container_host_and_out_of_scope(self):
        a, _ = _attributor()
        assert a.resolve("172.18.0.7") == "ai-gateway"
        assert a.resolve("192.168.1.87") == "host"
        assert a.resolve("192.168.20.55") is None  # LAN client — out of scope

    def test_unknown_in_subnet_ip_triggers_refresh(self):
        updated = NETWORK_JSON.replace(
            '"droplet-db-1",           "IPv4Address": "172.18.0.9/16"',
            '"droplet-db-1",           "IPv4Address": "172.18.0.99/16"',
        )
        a, fetches = _attributor(network_json=[NETWORK_JSON, updated])
        assert a.resolve("172.18.0.99") == "db"
        assert fetches["n"] == 2  # initial load + miss-triggered refresh

    def test_miss_refresh_is_rate_limited(self):
        now = [0.0]
        a, fetches = _attributor(clock=lambda: now[0], miss_refresh_min_sec=10.0)
        assert a.resolve("172.18.0.200") == "unknown-container"
        assert a.resolve("172.18.0.201") == "unknown-container"
        assert fetches["n"] == 2  # initial + ONE miss refresh within the 10 s window
        now[0] = 11.0
        a.resolve("172.18.0.202")
        assert fetches["n"] == 3

    def test_interval_refresh(self):
        now = [0.0]
        a, fetches = _attributor(clock=lambda: now[0], refresh_sec=60.0)
        a.resolve("172.18.0.7")
        now[0] = 61.0
        a.resolve("172.18.0.7")
        assert fetches["n"] == 2

    def test_fetch_failure_keeps_stale_map(self):
        calls = {"n": 0}
        def flaky():
            calls["n"] += 1
            if calls["n"] > 1:
                raise RuntimeError("docker daemon unavailable")
            return NETWORK_JSON
        now = [0.0]
        a = Attributor(fetch_network_json=flaky,
                       fetch_ip_addr_json=lambda: IP_ADDR_JSON,
                       clock=lambda: now[0], refresh_sec=60.0)
        assert a.resolve("172.18.0.7") == "ai-gateway"
        now[0] = 61.0
        assert a.resolve("172.18.0.7") == "ai-gateway"  # stale map survives
