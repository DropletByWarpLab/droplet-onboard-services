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
from typing import Any, Optional

logger = logging.getLogger("droplet.routing.mock")


# ---------------------------------------------------------------------------
# Fixtures (realistic OpenWrt shapes — see services/routing/tests/test_*.py
# for the contracts these fill).
# ---------------------------------------------------------------------------

_BOARD_INFO: dict[str, Any] = {
    "kernel": "6.6.40",
    "hostname": "droplet-mock",
    "system": "OpenWrt SNAPSHOT",
    # `model` is the human-readable system model; `board_name` is the
    # device-tree compatible string AP detection matches on (KEEP as-is —
    # it's the literal value Pi-based APs emit on /proc/device-tree/compatible).
    "model": "Droplet AP (mock)",
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

# `present: True` mirrors the canonical presence flag the real SDK stamps on
# every live interface in `get_all_interface_statuses()` (ADR-011). Without it
# the deployment-topology detector (ADR-018) — which reads presence from that
# exact flag — would treat the demo WAN as absent and report UNKNOWN.
_LAN_STATUS: dict[str, Any] = {
    "up": True,
    "present": True,
    "device": "br-lan",
    "proto": "static",
    "ipv4-address": [{"address": "10.0.0.1", "mask": 24}],
    "uptime": 12000,
}

# The mock models the single-box that motivated ADR-018: it sits DOWNSTREAM of a
# home router, so its WAN carries a DHCP-assigned address AND an upstream
# default-route gateway. The `route` entry is what the topology probe keys on to
# detect the DOWNSTREAM_ROUTER posture.
_WAN_STATUS: dict[str, Any] = {
    "up": True,
    "present": True,
    "device": "eth1",
    "l3_device": "eth1",
    "proto": "dhcp",
    "ipv4-address": [{"address": "192.168.1.87", "mask": 24}],
    "route": [
        {"target": "0.0.0.0", "mask": 0, "nexthop": "192.168.1.254", "source": ""},
    ],
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
    def __init__(self) -> None:
        # KAN-8: record the brick-risk dispatches so route tests can assert the
        # SDK was driven with the right args without flashing anything.
        self.sysupgrade_calls: list[tuple[str, bool]] = []
        self.factory_reset_calls: int = 0

    def board_info(self) -> dict[str, Any]:
        return _BOARD_INFO

    def resource_info(self) -> dict[str, Any]:
        return _RESOURCES

    def system_info(self) -> dict[str, Any]:
        return {"board": _BOARD_INFO, "resources": _RESOURCES}

    def firmware_version_check(self, pinned_image: str) -> dict[str, Any]:
        # Reuse the real compare helper so the mock can't drift from production
        # semantics (it reads the same release.version off the board fixture).
        from droplet_openwrt_sdk import compare_firmware_version

        return compare_firmware_version(_BOARD_INFO, pinned_image)

    def sysupgrade(self, image_path: str, preserve_config: bool = True) -> dict[str, Any]:
        logger.info("mock: sysupgrade %s preserve=%s — no-op", image_path, preserve_config)
        self.sysupgrade_calls.append((image_path, preserve_config))
        return {"status": "flashing", "image": image_path}

    def factory_reset(self) -> dict[str, Any]:
        logger.info("mock: factory_reset — no-op")
        self.factory_reset_calls += 1
        return {"status": "resetting"}

    def reboot(self) -> None:
        logger.info("mock: reboot requested — no-op")

    def set_hostname(self, hostname: str) -> None:
        logger.info("mock: set_hostname %s — no-op", hostname)

    def set_ntp_enabled(self, enabled: bool) -> None:
        logger.info("mock: set_ntp_enabled %s — no-op", enabled)

    def controls(self, ap_mode: str = "uci") -> dict[str, Any]:
        gated = ap_mode == "hostapd"
        return {
            "hostname": _BOARD_INFO["hostname"],
            "ntp_enabled": True,
            "status_led": {"supported": not gated, "enabled": False},
            "country": {"value": "US", "editable": not gated},
        }


class _MockNetwork:
    def interface_status(self, name: str) -> dict[str, Any]:
        if name == "lan":
            return _LAN_STATUS
        if name == "wan":
            return _WAN_STATUS
        return {"up": False, "device": name, "proto": "none"}

    def get_all_interface_statuses(self) -> dict[str, Any]:
        return {"lan": _LAN_STATUS, "wan": _WAN_STATUS}

    def list_all_interfaces(self) -> list[dict[str, Any]]:
        return [
            {"name": "lan", "device": "br-lan", "proto": "static",
             "address": "10.0.0.1/24", "zone": "lan", "up": True, "present": True},
            {"name": "wan", "device": "eth1", "proto": "dhcp",
             "address": "192.168.1.87/24", "zone": "wan", "up": True, "present": True},
        ]

    def interface_up(self, name: str) -> None:
        logger.info("mock: interface up %s — no-op", name)

    def interface_down(self, name: str) -> None:
        logger.info("mock: interface down %s — no-op", name)

    def create_interface(self, name: str, **kwargs: Any) -> None:
        logger.info("mock: create_interface %s %s — no-op", name, kwargs)

    def edit_interface(self, name: str, **kwargs: Any) -> None:
        logger.info("mock: edit_interface %s %s — no-op", name, kwargs)

    def restart(self) -> dict[str, Any]:
        logger.info("mock: network restart — no-op")
        return {}


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

    def guest_status(self, network: str = "guest") -> dict[str, Any]:
        # No guest network configured on the mock by default.
        return {"configured": False, "enabled": False, "ssid": None, "password": None}

    def remove_guest_network(self, network: str = "guest") -> None:
        logger.info("mock: remove_guest_network network=%s — no-op", network)


class _MockDhcp:
    # In-memory store of static hostrecord entries so upsert + list round-trips
    # feel realistic to the dashboard / setup script.
    _hostrecords: list[dict[str, Any]]

    def __init__(self) -> None:
        self._hostrecords = [
            {"section": "cfg01hostrecord", "hostname": "droplet-ai.lan", "ip": "10.0.0.1"},
        ]
        # In-memory LAN pool so GET/POST /dhcp/pool round-trips on the dev stack.
        self._lan_pool: dict[str, Any] = {"start": "100", "limit": "150", "leasetime": "12h"}

    def get_leases(self) -> dict[str, Any]:
        # Shape matches the real SDK response (wrap list in 'leases').
        return {"leases": _DHCP_LEASES}

    def get_leases_v6(self) -> dict[str, Any]:
        return {"leases": []}

    def active_leases(self) -> list[dict[str, Any]]:
        return _DHCP_LEASES

    def get_lan_pool(self) -> dict[str, Any]:
        return dict(self._lan_pool)

    def set_lan_pool(self, start: int, limit: int, leasetime: str) -> None:
        self._lan_pool = {
            "start": str(start),
            "limit": str(limit),
            "leasetime": leasetime,
        }
        logger.info(
            "mock: set_lan_pool start=%s limit=%s leasetime=%s", start, limit, leasetime
        )

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

    def add_rule(self, name: str, src: str, dest: str, proto: str = "tcp", dest_port: Any = None,
                 target: str = "REJECT", src_port: Any = None, enabled: str = "1") -> None:
        logger.info("mock: add_rule name=%s %s->%s target=%s — no-op", name, src, dest, target)

    def set_zone_policy(self, zone: str, input: Any = None, output: Any = None, forward: Any = None) -> None:
        logger.info("mock: set_zone_policy zone=%s in=%s out=%s fwd=%s — no-op", zone, input, output, forward)

    def block_phone_home(self, mac: str) -> None:
        logger.info("mock: block_phone_home mac=%s — no-op", mac)

    def unblock_phone_home(self, mac: str) -> None:
        logger.info("mock: unblock_phone_home mac=%s — no-op", mac)

    def set_camera_phone_home(self, blocked: bool) -> None:
        logger.info("mock: set_camera_phone_home blocked=%s — no-op", blocked)

    def upnp_status(self) -> dict[str, Any]:
        # The mock single-box has no miniupnpd — the secure default (Droplet
        # never opens ports automatically). Tests that need the available path
        # override this method.
        return {"available": False, "enabled": False}

    def set_upnp(self, enabled: bool) -> None:
        logger.info("mock: set_upnp enabled=%s — no-op", enabled)

    def reload(self) -> None:
        pass


class _MockVpn:
    """In-memory WireGuard state for ROUTING_MODE=mock.

    Mirrors the real `VPNApi` surface so dashboard / orchestrator dev against
    the mock can drive the full setup → add-peer → list → delete flow without
    a router. Keys are still real X25519 (we use the same `cryptography` path
    as the SDK) so a config rendered against the mock would actually work if
    you piped it into wg-quick.
    """

    def __init__(self) -> None:
        # interface_name -> {private_key, public_key, listen_port, addresses[]}
        self._interfaces: dict[str, dict[str, Any]] = {}
        # Flat peer list — tagged by interface so list/delete can filter.
        self._peers: list[dict[str, Any]] = []
        self._section_counter = 0
        # WARP-1389 — settable per-peer runtime `latest handshake` epoch (secs),
        # keyed by public_key. Tests set this to simulate a peer that punched.
        self._handshakes: dict[str, int] = {}
        # When False, peer_handshakes returns None (UNKNOWN) — simulates a box
        # whose ubus interface status carries no peer handshake data.
        self._handshakes_available: bool = True

    @staticmethod
    def generate_keypair() -> tuple[str, str]:
        # Same path as the real SDK so the mock isn't accidentally insecure.
        from droplet_openwrt_sdk import VPNApi
        return VPNApi.generate_keypair()

    @staticmethod
    def derive_public_key(private_key_b64: str) -> str:
        from droplet_openwrt_sdk import VPNApi
        return VPNApi.derive_public_key(private_key_b64)

    def interface_exists(self, name: str) -> bool:
        return name in self._interfaces

    def get_interface_info(self, interface: str = "wg0") -> dict[str, Any]:
        info = self._interfaces.get(interface)
        if not info:
            return {}
        return {
            "interface": interface,
            "public_key": info["public_key"],
            "listen_port": info["listen_port"],
            "addresses": list(info["addresses"]),
        }

    def create_interface(self, name: str, private_key: str,
                         listen_port: int = 51820, address: str = "10.13.13.1/24") -> None:
        self._interfaces[name] = {
            "private_key": private_key,
            "public_key": self.derive_public_key(private_key),
            "listen_port": int(listen_port),
            "addresses": [address],
        }
        logger.info("mock: VPN create_interface name=%s port=%s addr=%s", name, listen_port, address)

    def add_peer(self, interface: str, public_key: str, allowed_ips: str,
                 description: str = "", endpoint: str = "",
                 persistent_keepalive: int = 25) -> None:
        self._section_counter += 1
        section = f"cfg{self._section_counter:02d}wireguard_{interface}"
        # `allowed_ips` arrives as a comma-joined string from the SDK to match
        # how OpenWrt stores it on disk; split back to a list for in-memory.
        ip_list = [s.strip() for s in allowed_ips.split(",") if s.strip()] if allowed_ips else []
        self._peers.append({
            "section": section,
            "interface": interface,
            "public_key": public_key,
            "allowed_ips": ip_list,
            "description": description,
            "endpoint_host": endpoint,
            "persistent_keepalive": str(persistent_keepalive),
        })
        logger.info("mock: VPN add_peer iface=%s ips=%s desc=%s", interface, ip_list, description)

    def list_peers(self, interface: str = "wg0") -> list[dict[str, Any]]:
        return [
            {k: v for k, v in p.items() if k != "interface"}
            for p in self._peers
            if p["interface"] == interface
        ]

    def delete_peer(self, interface: str, public_key: str) -> int:
        before = len(self._peers)
        self._peers = [
            p for p in self._peers
            if not (p["interface"] == interface and p["public_key"] == public_key)
        ]
        return before - len(self._peers)

    def peer_handshakes(self, interface: str = "wg0"):
        """WARP-1389 — per-peer runtime `latest handshake` epoch (secs) for peers
        on `interface`. Mirrors the real VPNApi read: None = UNKNOWN (no runtime
        data), dict = available (handshook peers only). Tests seed `_handshakes`
        and toggle `_handshakes_available`."""
        if not self._handshakes_available:
            return None
        keys = {p["public_key"] for p in self._peers if p["interface"] == interface}
        return {k: v for k, v in self._handshakes.items() if k in keys}

    def setup_firewall(self, interface: str = "wg0", listen_port: int = 51820) -> None:
        logger.info("mock: VPN setup_firewall iface=%s port=%s — no-op", interface, listen_port)


class _MockAp:
    """In-memory extender-AP state for ROUTING_MODE=mock (WARP-446).

    Mirrors the real `ApApi` surface so dashboard / orchestrator dev
    against the mock can drive the full discovery → approve → push →
    decommission flow without a router. Section names are
    deterministic per-MAC, same as the real SDK.

    `_discovered` is the in-memory "seen this MAC announce on mDNS"
    list. Tests inject MACs via the `/aps/_test_seed` endpoint so the
    multicast layer doesn't need to be simulated.

    `_pushed` mirrors the wireless-iface sections that would be
    committed to /etc/config/wireless. Decommission removes the entry.
    """

    def __init__(self) -> None:
        # { mac → { model, serial, version, last_ip, hostname, first_seen, last_seen } }
        self._discovered: dict[str, dict[str, Any]] = {}
        # { mac → { iface_section, ssid, encryption, key } }
        self._pushed: dict[str, dict[str, Any]] = {}
        # Track which MACs have been decommissioned so /aps/{mac} reports
        # the right state after the row has been cleared from `_pushed`.
        self._decommissioned: set[str] = set()
        # WARP-1703: per-MAC band-steering flag mirroring the AP image's
        # `droplet.wifi.band_steering` master switch. Absent = the substrate
        # default (ON) — same semantics as an unset uci option.
        self._band_steering: dict[str, bool] = {}
        # WARP-1715: { mac -> [assoclist rows] } — stations associated to this
        # AP's own radios, seeded via /aps/_test_seed. Distinct from the
        # per-radio client COUNT in `get_ap_wireless`: attribution needs MACs.
        self._clients: dict[str, list[dict[str, Any]]] = {}
        # WARP-1712: per-MAC { ssid, key } standing in for the AP's own
        # `wireless.default_radio0` section — the household network name.
        self._wireless: dict[str, dict[str, str]] = {}

    @staticmethod
    def iface_section_for_mac(mac: str) -> str:
        # Re-uses the real SDK helper so the mock can't drift from the
        # production naming scheme.
        from droplet_openwrt_sdk import ApApi
        return ApApi.iface_section_for_mac(mac)

    def discovered(self) -> list[dict[str, Any]]:
        """Return the current discovery list, sorted by MAC for stable
        output. Mirrors the shape the orchestrator's mDNS poller will
        produce — see `iface_section_for_mac` for the section-name
        convention used at approval time.
        """
        return [
            {"mac": mac, **info}
            for mac, info in sorted(self._discovered.items())
        ]

    def seed(self, mac: str, **info: Any) -> None:
        """Inject a discovered AP. Test-only helper — production
        populates this from the mDNS poller. The MAC is uppercased on
        the way in so the rest of the SDK's normalisation invariants
        hold."""
        canonical = mac.upper()
        # WARP-1715: stations live in their own map, not in the discovery
        # record — `get()` echoes `_discovered` wholesale and an assoclist has
        # no business in the AP's mDNS identity.
        clients = info.pop("clients", None)
        if clients is not None:
            self._clients[canonical] = list(clients)
        existing = self._discovered.get(canonical, {})
        existing.update({k: v for k, v in info.items() if v is not None})
        self._discovered[canonical] = existing
        # Re-seeding a previously-decommissioned MAC re-arms it.
        self._decommissioned.discard(canonical)

    def state(self, mac: str) -> str:
        canonical = mac.upper()
        if canonical in self._decommissioned:
            return "decommissioned"
        if canonical in self._pushed:
            return "online"
        if canonical in self._discovered:
            return "discovered"
        return "unknown"

    def get(self, mac: str) -> Optional[dict[str, Any]]:
        canonical = mac.upper()
        info = self._discovered.get(canonical)
        if info is None and canonical not in self._decommissioned:
            return None
        out: dict[str, Any] = {"mac": canonical, "state": self.state(canonical)}
        if info:
            out.update(info)
        if canonical in self._pushed:
            out["wireless"] = dict(self._pushed[canonical])
        return out

    def push_wireless_config(
        self,
        mac: str,
        iface_section: str,
        radio: str,
        ssid: str,
        encryption: str,
        key: str,
        network: str = "lan",
    ) -> None:
        canonical = mac.upper()
        if canonical not in self._discovered:
            raise KeyError(f"mock: AP {canonical} not in discovery list")
        self._pushed[canonical] = {
            "iface_section": iface_section,
            "radio": radio,
            "ssid": ssid,
            "encryption": encryption,
            # We DO NOT echo the key in the mock's state read — same
            # contract the real SDK aspires to (don't leak PSKs to
            # callers that didn't supply them).
            "key_set": True,
            "network": network,
        }
        self._decommissioned.discard(canonical)
        logger.info("mock: AP push_wireless_config mac=%s ssid=%s — no-op", canonical, ssid)

    def remove_wireless_config(self, mac: str) -> None:
        canonical = mac.upper()
        self._pushed.pop(canonical, None)
        self._decommissioned.add(canonical)
        logger.info("mock: AP remove_wireless_config mac=%s — no-op", canonical)

    def get_band_steering(self, mac: str) -> bool:
        """WARP-1703: the AP image's `droplet.wifi.band_steering` master
        switch. Defaults ON — same as the substrate's unset-option default."""
        return self._band_steering.get(mac.upper(), True)

    def set_band_steering(self, mac: str, enabled: bool) -> None:
        canonical = mac.upper()
        self._band_steering[canonical] = bool(enabled)
        logger.info(
            "mock: AP set_band_steering mac=%s enabled=%s — no-op", canonical, enabled
        )

    def get_clients(self, mac: str) -> list[dict[str, Any]]:
        """WARP-1715: stations associated to this AP's own radios.

        Seeded per-MAC by `/aps/_test_seed`; an AP nobody seeded reports an
        empty list, which is the honest mock answer (an approved-but-idle AP
        really does have no stations).
        """
        return list(self._clients.get(mac.upper(), []))

    def get_ap_wireless(self, mac: str) -> dict[str, Any]:
        """WARP-1712: the AP's own network name + passphrase, mock edition.

        Mirrors the real `_shape_ap_wireless` envelope closely enough for
        dashboard dev: two radios, radio0 as the primary source of truth, and
        the 5 GHz name DERIVED from the band-steering flag exactly the way the
        AP-side applier derives it (`<ssid>` when steering is on, `<ssid>-5g`
        when off). Getting that derivation wrong in the mock would let a
        dashboard bug ship green, so it stays in lock-step.
        """
        canonical = mac.upper()
        state = self._wireless.setdefault(
            canonical, {"ssid": "Droplet", "key": "droplet-mock-psk"}
        )
        steering = self.get_band_steering(canonical)
        five = state["ssid"] if steering else f"{state['ssid']}-5g"
        return {
            "supported": True,
            "band_steering": steering,
            "primary_section": "default_radio0",
            "ssid": state["ssid"],
            "key": state["key"],
            "encryption": "psk2+ccmp",
            "five_ghz_ssid": five,
            "radios": [
                {
                    "section": "default_radio0", "radio": "radio0", "band": "2g",
                    "ssid": state["ssid"], "encryption": "psk2+ccmp",
                    "channel": "auto", "htmode": "HE20", "disabled": False,
                    "primary": True, "ifname": "phy0-ap0", "up": True,
                    "live_channel": 6, "live_htmode": "HE20", "clients": 2,
                },
                {
                    "section": "default_radio1", "radio": "radio1", "band": "5g",
                    "ssid": five, "encryption": "psk2+ccmp",
                    "channel": "auto", "htmode": "HE80", "disabled": False,
                    "primary": False, "ifname": "phy1-ap0", "up": True,
                    "live_channel": 44, "live_htmode": "HE80", "clients": 5,
                },
            ],
            "device": {
                "model": "Droplet Coverage Extender (mock)",
                "firmware": "OpenWrt 25.12 (mock)",
                "hostname": "droplet-ap-mock",
                "uptime_seconds": 86_400,
            },
        }

    def set_ap_wireless(
        self, mac: str, ssid: Optional[str], key: Optional[str]
    ) -> dict[str, Any]:
        canonical = mac.upper()
        state = self._wireless.setdefault(
            canonical, {"ssid": "Droplet", "key": "droplet-mock-psk"}
        )
        if ssid is not None:
            state["ssid"] = ssid
        if key is not None:
            state["key"] = key
        steering = self.get_band_steering(canonical)
        logger.info("mock: AP set_ap_wireless mac=%s ssid=%s — no-op", canonical, ssid)
        return {
            # Only the primary section is authored — the mock keeps the real
            # service's contract that the applier owns radio1.
            "sections_written": ["default_radio0"],
            "band_steering": steering,
            "ssid": state["ssid"],
            "five_ghz_ssid": state["ssid"] if steering else f"{state['ssid']}-5g",
        }


class _MockDiscovery:
    """In-memory non-Droplet mDNS records, seeded via `/discovery/_test_seed`.

    WARP-2019 (scan-3). Mirrors `_MockAp._discovered`: production discovery is
    multicast-driven and cannot be simulated in a test, so scan-4's scanner
    poller drives this instead of needing a real eSCL device on the wire.
    Records are stored already in `DiscoveryApi.browse_service()` shape.
    """

    def __init__(self) -> None:
        # service_type -> hostname -> record
        self._records: dict[str, dict[str, dict[str, Any]]] = {}

    def browse_service(self, service_type: str) -> list[dict[str, Any]]:
        return [
            dict(record)
            for _, record in sorted(self._records.get(service_type, {}).items())
        ]

    def seed(
        self,
        service_type: str,
        *,
        hostname: str,
        port: Optional[int] = None,
        last_ip: Optional[str] = None,
        txt: Optional[dict[str, str]] = None,
    ) -> None:
        # Blank values are omitted here too, so the seam can't produce a record
        # shape the real parser would never emit.
        kv = {k: v for k, v in (txt or {}).items() if v}
        record: dict[str, Any] = {
            "service_type": service_type,
            "hostname": hostname,
            "txt": kv,
        }
        if uuid := kv.get("uuid"):
            record["uuid"] = uuid
        if port is not None:
            record["port"] = port
        if last_ip:
            record["last_ip"] = last_ip
        self._records.setdefault(service_type, {})[hostname] = record


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


class _MockFile:
    def read(self, path: str) -> str:
        # The dev stack has no on-box ACL file — raise so /ai-access falls back
        # to its bundled canonical ACL (the real shipping scopes).
        from droplet_openwrt_sdk import UbusError

        raise UbusError(-1, f"mock: no file at {path}")


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
        self.vpn = _MockVpn()
        self.ap = _MockAp()  # WARP-446
        self.discovery = _MockDiscovery()  # WARP-2019
        self.file = _MockFile()

    def session_info(self) -> dict[str, Any]:
        # The mock has no real ubus session; report a stable active fixture so
        # the AI-access scopes card renders on the dev stack.
        return {"active": True, "expires_at": 0.0, "username": "droplet-ai"}

    def disconnect(self) -> None:
        pass

    def exec_service(self, service: str, action: str) -> dict[str, Any]:
        logger.info("mock: exec_service %s %s — no-op", service, action)
        return {"code": 0}

    def _call(self, obj: str, method: str, args: Any = None) -> dict[str, Any]:
        """Catch-all for raw ubus calls (e.g. `service event` reload nudges
        used by /vpn/setup). The real SDK exposes this for
        cases the typed sub-APIs don't cover; the mock returns success so
        endpoint code paths that depend on a nudge don't blow up."""
        logger.info("mock: _call %s.%s args=%s — no-op", obj, method, args)
        return {}

    def apply_changes(self, config: str, timeout: int = 30) -> None:
        logger.info("mock: apply_changes config=%s — no-op", config)

    # Some SDK call sites use safe_apply as a context manager.
    from contextlib import contextmanager

    @contextmanager
    def safe_apply(self, timeout: int = 60):
        logger.info("mock: safe_apply enter (timeout=%s) — no-op", timeout)
        yield self
