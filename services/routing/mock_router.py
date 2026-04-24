"""Mock router for ROUTING_MODE=mock (WARP-44).

Lets developers run the full stack on a laptop without a real OpenWrt router.
Every method returns a realistic static fixture; writes are no-ops that log
but don't raise.

The attribute hierarchy mirrors `DropletRouter` from `droplet_openwrt_sdk.py`
so the FastAPI endpoints in `main.py` can swap `router_instance` between real
and mock with zero per-endpoint branching.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("droplet.routing.mock")


# ---------------------------------------------------------------------------
# Fixtures (realistic OpenWrt shapes — see services/routing/tests/test_*.py
# for the contracts these fill).
# ---------------------------------------------------------------------------

_BOARD_INFO: dict[str, Any] = {
    "kernel": "6.6.40",
    "hostname": "droplet-mock",
    "system": "OpenWrt SNAPSHOT",
    "model": "Raspberry Pi 5 (mock)",
    "board_name": "raspberrypi,5-model-b",
    "release": {
        "distribution": "OpenWrt",
        "version": "SNAPSHOT",
        "target": "bcm27xx/bcm2712",
    },
}

_RESOURCES: dict[str, Any] = {
    "uptime": 12345,
    "localtime": 1713312345,
    "load": [0.12, 0.18, 0.20],
    "memory": {"total": 4_000_000_000, "free": 2_500_000_000, "shared": 0, "buffered": 120_000_000},
    "swap": {"total": 0, "free": 0},
}

_LAN_STATUS: dict[str, Any] = {
    "up": True,
    "device": "br-lan",
    "proto": "static",
    "ipv4-address": [{"address": "10.0.0.1", "mask": 24}],
    "uptime": 12000,
}

_WAN_STATUS: dict[str, Any] = {
    "up": True,
    "device": "eth1",
    "proto": "dhcp",
    "ipv4-address": [{"address": "203.0.113.42", "mask": 24}],
    "uptime": 11800,
}

_WIRELESS_STATUS: dict[str, Any] = {
    "radio0": {
        "up": True,
        "channel": 36,
        "ssid": "Droplet-Mock-5G",
        "encryption": "sae-mixed",
    },
    "radio1": {
        "up": True,
        "channel": 6,
        "ssid": "Droplet-Mock",
        "encryption": "sae-mixed",
    },
}

_WIRELESS_CLIENTS: list[dict[str, Any]] = [
    {"mac": "AA:BB:CC:11:22:33", "signal": -45, "rx_rate": 866700, "tx_rate": 866700},
    {"mac": "AA:BB:CC:44:55:66", "signal": -60, "rx_rate": 433300, "tx_rate": 433300},
]

_DHCP_LEASES: list[dict[str, Any]] = [
    {"hostname": "MacBook-Pro", "macaddr": "AA:BB:CC:11:22:33", "ipaddr": "10.0.0.42", "expire": 1713400000},
    {"hostname": "Kitchen-TV", "macaddr": "AA:BB:CC:44:55:66", "ipaddr": "10.0.0.51", "expire": 1713400000},
    {"hostname": "iPhone", "macaddr": "AA:BB:CC:77:88:99", "ipaddr": "10.0.0.88", "expire": 1713400000},
]

_FIREWALL_ZONES: dict[str, Any] = {
    "values": {
        "cfg01lan": {".anonymous": False, ".type": "zone", ".name": "cfg01lan", "name": "lan", "network": ["lan"], "input": "ACCEPT", "output": "ACCEPT", "forward": "ACCEPT"},
        "cfg02wan": {".anonymous": False, ".type": "zone", ".name": "cfg02wan", "name": "wan", "network": ["wan"], "input": "REJECT", "output": "ACCEPT", "forward": "REJECT", "masq": "1"},
    }
}

_FIREWALL_RULES: dict[str, Any] = {
    "values": {
        "cfg03ssh": {".type": "rule", "name": "Allow-SSH", "src": "wan", "proto": "tcp", "dest_port": "22", "target": "ACCEPT", "enabled": "1"},
    }
}

_FIREWALL_REDIRECTS: dict[str, Any] = {
    "values": {
        "cfg04web": {".type": "redirect", "name": "web", "src": "wan", "dest": "lan", "proto": "tcp", "src_dport": "8080", "dest_ip": "10.0.0.42", "dest_port": "80", "target": "DNAT", "enabled": "1"},
    }
}

_SCAN_RESULTS: list[dict[str, Any]] = [
    {"ssid": "Droplet-Mock-5G", "bssid": "AA:BB:CC:DD:EE:FF", "signal": -35, "channel": 36, "encryption": "sae-mixed"},
    {"ssid": "Neighbor-Wifi", "bssid": "11:22:33:44:55:66", "signal": -75, "channel": 6, "encryption": "wpa2-psk"},
]


# ---------------------------------------------------------------------------
# Namespace mocks — attribute layout matches the real SDK.
# ---------------------------------------------------------------------------

class _MockSystem:
    def board_info(self) -> dict[str, Any]:
        return _BOARD_INFO

    def resource_info(self) -> dict[str, Any]:
        return _RESOURCES

    def system_info(self) -> dict[str, Any]:
        return {"board": _BOARD_INFO, "resources": _RESOURCES}

    def reboot(self) -> None:
        logger.info("mock: reboot requested — no-op")


class _MockNetwork:
    def interface_status(self, name: str) -> dict[str, Any]:
        if name == "lan":
            return _LAN_STATUS
        if name == "wan":
            return _WAN_STATUS
        return {"up": False, "device": name, "proto": "none"}

    def get_all_interface_statuses(self) -> dict[str, Any]:
        return {"lan": _LAN_STATUS, "wan": _WAN_STATUS}

    def interface_up(self, name: str) -> None:
        logger.info("mock: interface up %s — no-op", name)

    def interface_down(self, name: str) -> None:
        logger.info("mock: interface down %s — no-op", name)


class _MockWireless:
    def status(self) -> dict[str, Any]:
        return _WIRELESS_STATUS

    def scan(self, device: str = "wlan0") -> dict[str, Any]:
        return {"results": _SCAN_RESULTS}

    def connected_clients(self, device: str = "wlan0") -> list[dict[str, Any]]:
        return _WIRELESS_CLIENTS

    def radio_info(self, device: str = "wlan0") -> dict[str, Any]:
        return _WIRELESS_STATUS.get("radio0", {})

    def set_ssid(self, radio: str, iface_section: str, ssid: str) -> None:
        logger.info("mock: set_ssid radio=%s ssid=%s — no-op", radio, ssid)

    def set_password(self, iface_section: str, password: str, encryption: str = "sae-mixed") -> None:
        logger.info("mock: set_password iface=%s — no-op", iface_section)

    def set_channel(self, radio_section: str, channel: Any) -> None:
        logger.info("mock: set_channel %s channel=%s — no-op", radio_section, channel)

    def create_guest_network(self, radio: str, ssid: str, password: str, network: str = "guest") -> None:
        logger.info("mock: create_guest_network ssid=%s — no-op", ssid)


class _MockDhcp:
    # In-memory store of static hostrecord entries so upsert + list round-trips
    # feel realistic to the dashboard / setup script.
    _hostrecords: list[dict[str, Any]]

    def __init__(self) -> None:
        self._hostrecords = [
            {"section": "cfg01hostrecord", "hostname": "droplet-ai.lan", "ip": "10.0.0.1"},
        ]

    def get_leases(self) -> dict[str, Any]:
        # Shape matches the real SDK response (wrap list in 'leases').
        return {"leases": _DHCP_LEASES}

    def get_leases_v6(self) -> dict[str, Any]:
        return {"leases": []}

    def active_leases(self) -> list[dict[str, Any]]:
        return _DHCP_LEASES

    def add_static_lease(self, name: str, mac: str, ip: str, leasetime: str = "infinite") -> None:
        logger.info("mock: add_static_lease name=%s mac=%s ip=%s — no-op", name, mac, ip)

    def set_dns_servers(self, servers: list[str]) -> None:
        logger.info("mock: set_dns_servers %s — no-op", servers)

    def list_hostrecords(self) -> list[dict[str, Any]]:
        return list(self._hostrecords)

    def set_hostrecord(self, hostname: str, ip: str) -> dict[str, Any]:
        for entry in self._hostrecords:
            if entry["hostname"].lower() == hostname.lower():
                entry["ip"] = ip
                entry["hostname"] = hostname
                return {"section": entry["section"], "hostname": hostname, "ip": ip, "action": "updated"}
        section = f"cfgmock{len(self._hostrecords) + 1:02d}hostrecord"
        self._hostrecords.append({"section": section, "hostname": hostname, "ip": ip})
        return {"section": section, "hostname": hostname, "ip": ip, "action": "created"}

    def delete_hostrecord(self, hostname: str) -> int:
        target = hostname.lower()
        before = len(self._hostrecords)
        self._hostrecords = [e for e in self._hostrecords if e["hostname"].lower() != target]
        return before - len(self._hostrecords)


class _MockFirewall:
    def get_zones(self) -> dict[str, Any]:
        return _FIREWALL_ZONES

    def get_rules(self) -> dict[str, Any]:
        return _FIREWALL_RULES

    def get_redirects(self) -> dict[str, Any]:
        return _FIREWALL_REDIRECTS

    def block_device(self, mac: str, name: Any = None) -> None:
        logger.info("mock: block_device mac=%s — no-op", mac)

    def unblock_device(self, mac: str) -> None:
        logger.info("mock: unblock_device mac=%s — no-op", mac)

    def add_port_forward(self, name: str, src_port: str, dest_ip: str, dest_port: str, proto: str = "tcp") -> None:
        logger.info("mock: add_port_forward name=%s %s->%s:%s — no-op", name, src_port, dest_ip, dest_port)

    def reload(self) -> None:
        pass


class _MockUci:
    """Minimal uci mock — safe_apply happy path only."""

    def set(self, *args, **kwargs) -> None:
        logger.info("mock: uci.set — no-op")

    def add(self, *args, **kwargs) -> Any:
        logger.info("mock: uci.add — no-op")
        return {"section": "mock-section"}

    def delete(self, *args, **kwargs) -> None:
        logger.info("mock: uci.delete — no-op")

    def commit(self, *args, **kwargs) -> None:
        logger.info("mock: uci.commit — no-op")

    def apply(self, *args, **kwargs) -> None:
        logger.info("mock: uci.apply — no-op")

    def confirm(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def get(self, *args, **kwargs) -> dict[str, Any]:
        # Used by camera subnet helpers; return an empty set.
        return {"values": {}}


class MockRouter:
    """Drop-in replacement for `DropletRouter` when ROUTING_MODE=mock.

    Only the read + write methods exercised by the REST endpoints are
    implemented. Tests that use the real SDK are unaffected because they
    instantiate `DropletRouter` directly.
    """

    def __init__(self) -> None:
        self.system = _MockSystem()
        self.network = _MockNetwork()
        self.wireless = _MockWireless()
        self.dhcp = _MockDhcp()
        self.firewall = _MockFirewall()
        self.uci = _MockUci()

    def disconnect(self) -> None:
        pass

    def exec_service(self, service: str, action: str) -> dict[str, Any]:
        logger.info("mock: exec_service %s %s — no-op", service, action)
        return {"code": 0}

    def apply_changes(self, config: str, timeout: int = 30) -> None:
        logger.info("mock: apply_changes config=%s — no-op", config)

    # Some SDK call sites use safe_apply as a context manager.
    from contextlib import contextmanager

    @contextmanager
    def safe_apply(self, timeout: int = 60):
        logger.info("mock: safe_apply enter (timeout=%s) — no-op", timeout)
        yield self
