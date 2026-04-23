"""
Droplet OpenWrt SDK
===================
Python client for the Jetson AI module to control all aspects of the
OpenWrt routing layer via the ubus JSON-RPC API.

Usage:
    from droplet_openwrt_sdk import DropletRouter

    router = DropletRouter("10.0.0.1", username="droplet-ai", password="SECRET")

    # Get network status
    status = router.network.interface_status("lan")

    # Change WiFi SSID
    router.wireless.set_ssid("radio0", "default_radio0", "My-New-SSID")
    router.apply_changes("wireless")

    # Block a device
    router.firewall.block_device("AA:BB:CC:DD:EE:FF", name="Kids-iPad")

    # Safe apply with auto-rollback
    with router.safe_apply(timeout=60):
        router.uci.set("network", "lan", {"ipaddr": "192.168.2.1"})
        router.uci.commit("network")
"""

import json
import time
import logging
from contextlib import contextmanager
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger("droplet.openwrt")


# ---------------------------------------------------------------------------
# ubus return codes
# ---------------------------------------------------------------------------
UBUS_STATUS = {
    0: "OK",
    1: "INVALID_COMMAND",
    2: "INVALID_ARGUMENT",
    3: "METHOD_NOT_FOUND",
    4: "NOT_FOUND",
    5: "NO_DATA",
    6: "PERMISSION_DENIED",
    7: "TIMEOUT",
}

NULL_SESSION = "00000000000000000000000000000000"


class UbusError(Exception):
    """Raised when a ubus call returns a non-zero status code."""

    def __init__(self, code: int, message: str = ""):
        self.code = code
        self.status = UBUS_STATUS.get(code, f"UNKNOWN({code})")
        super().__init__(message or f"ubus error: {self.status}")


class ConnectionLost(Exception):
    """Raised when the Jetson can no longer reach the OpenWrt device."""
    pass


# ---------------------------------------------------------------------------
# Core JSON-RPC client
# ---------------------------------------------------------------------------
class UbusClient:
    """Low-level JSON-RPC 2.0 client for OpenWrt ubus over HTTP."""

    def __init__(self, host: str, port: int = 80, scheme: str = "http", timeout: int = 10):
        self.base_url = f"{scheme}://{host}:{port}/ubus"
        self.timeout = timeout
        self._request_id = 0

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def raw_call(self, method: str, params: list) -> dict:
        """Send a single JSON-RPC request and return the parsed response."""
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": method,
            "params": params,
        }
        data = json.dumps(payload).encode("utf-8")
        req = Request(self.base_url, data=data, headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except URLError as exc:
            raise ConnectionLost(f"Cannot reach OpenWrt at {self.base_url}: {exc}") from exc

    def call(self, session: str, obj: str, method: str, args: Optional[dict] = None) -> Any:
        """
        Call a ubus method and return the response data.

        Raises UbusError on non-zero return codes.
        """
        args = args or {}
        resp = self.raw_call("call", [session, obj, method, args])

        if "error" in resp:
            raise UbusError(-1, resp["error"].get("message", str(resp["error"])))

        result = resp.get("result", [])
        if not result:
            raise UbusError(-1, "Empty result")

        code = result[0]
        if code != 0:
            raise UbusError(code)

        return result[1] if len(result) > 1 else {}

    def batch_call(self, session: str, calls: list[tuple[str, str, dict]]) -> list[Any]:
        """
        Send multiple ubus calls in a single HTTP request.

        calls: list of (object, method, args) tuples
        Returns: list of response data dicts (same order)
        """
        payloads = []
        request_ids = []
        for obj, method, args in calls:
            req_id = self._next_id()
            request_ids.append(req_id)
            payloads.append({
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "call",
                "params": [session, obj, method, args or {}],
            })

        data = json.dumps(payloads).encode("utf-8")
        req = Request(self.base_url, data=data, headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                responses = json.loads(resp.read().decode("utf-8"))
        except URLError as exc:
            raise ConnectionLost(f"Batch call failed: {exc}") from exc

        # Match responses by ID (JSON-RPC batch responses may arrive in any order)
        response_by_id = {r["id"]: r for r in responses}
        results = []
        for req_id in request_ids:
            r = response_by_id.get(req_id)
            if r is None:
                raise UbusError(-1, f"Missing response for request {req_id}")
            res = r.get("result", [])
            code = res[0] if res else -1
            if code != 0:
                raise UbusError(code)
            results.append(res[1] if len(res) > 1 else {})
        return results

    def list_objects(self, session: str, pattern: str = "*") -> dict:
        """List available ubus objects matching a pattern."""
        resp = self.raw_call("list", [session, pattern])
        return resp.get("result", {})


# ---------------------------------------------------------------------------
# Session manager
# ---------------------------------------------------------------------------
class SessionManager:
    """Handles authentication, session refresh, and logout."""

    def __init__(self, client: UbusClient, username: str, password: str):
        self.client = client
        self.username = username
        self.password = password
        self.token: Optional[str] = None
        self.expires_at: float = 0

    def login(self) -> str:
        """Authenticate and store the session token."""
        result = self.client.call(NULL_SESSION, "session", "login", {
            "username": self.username,
            "password": self.password,
        })
        self.token = result["ubus_rpc_session"]
        timeout = result.get("timeout", 300)
        self.expires_at = time.time() + timeout
        logger.info("Authenticated as %s (expires in %ds)", self.username, timeout)
        return self.token

    def ensure_valid(self) -> str:
        """Return a valid session token, re-authenticating if needed."""
        if self.token is None or time.time() > (self.expires_at - 30):
            self.login()
        return self.token

    def logout(self):
        """Destroy the current session."""
        if self.token:
            try:
                self.client.call(self.token, "session", "destroy", {
                    "ubus_rpc_session": self.token,
                })
            except (UbusError, ConnectionLost):
                pass
            self.token = None


# ---------------------------------------------------------------------------
# High-level API: UCI
# ---------------------------------------------------------------------------
class UCIApi:
    """Read/write OpenWrt configuration via the UCI ubus interface."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def configs(self) -> list[str]:
        """List all available config files."""
        result = self._r._call("uci", "configs")
        return result.get("configs", [])

    def get(self, config: str, section: Optional[str] = None,
            option: Optional[str] = None, type: Optional[str] = None) -> Any:
        """Read a config file, section, or individual option."""
        args = {"config": config}
        if section:
            args["section"] = section
        if option:
            args["option"] = option
        if type:
            args["type"] = type
        return self._r._call("uci", "get", args)

    def set(self, config: str, section: str, values: dict) -> Any:
        """Set one or more values on a config section."""
        return self._r._call("uci", "set", {
            "config": config, "section": section, "values": values,
        })

    def add(self, config: str, type: str, values: Optional[dict] = None, name: Optional[str] = None) -> Any:
        """Add a new anonymous or named section."""
        args: dict[str, Any] = {"config": config, "type": type}
        if values:
            args["values"] = values
        if name:
            args["name"] = name
        return self._r._call("uci", "add", args)

    def delete(self, config: str, section: str, option: Optional[str] = None) -> Any:
        """Delete a section or a single option."""
        args: dict[str, Any] = {"config": config, "section": section}
        if option:
            args["option"] = option
        return self._r._call("uci", "delete", args)

    def commit(self, config: str) -> Any:
        """Write staged changes to disk."""
        return self._r._call("uci", "commit", {"config": config})

    def apply(self, timeout: int = 30, rollback: bool = True) -> Any:
        """Apply committed changes with optional rollback safety."""
        return self._r._call("uci", "apply", {"timeout": timeout, "rollback": rollback})

    def confirm(self) -> Any:
        """Confirm applied changes (cancels auto-rollback timer)."""
        return self._r._call("uci", "confirm")

    def rollback(self) -> Any:
        """Manually rollback unapplied changes."""
        return self._r._call("uci", "rollback")


# ---------------------------------------------------------------------------
# High-level API: Network
# ---------------------------------------------------------------------------
class NetworkApi:
    """Network interface management."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def interface_status(self, name: str) -> dict:
        """Get full status of an interface (lan, wan, etc.)."""
        return self._r._call(f"network.interface.{name}", "status")

    def interface_up(self, name: str) -> dict:
        """Bring an interface up."""
        return self._r._call(f"network.interface.{name}", "up")

    def interface_down(self, name: str) -> dict:
        """Bring an interface down."""
        return self._r._call(f"network.interface.{name}", "down")

    def device_status(self) -> dict:
        """Get status of all network devices (physical and virtual)."""
        return self._r._call("network.device", "status")

    def restart(self) -> dict:
        """Restart the entire networking stack."""
        return self._r._call("network", "restart")

    def get_all_interface_statuses(self) -> dict[str, dict]:
        """Batch-fetch status of lan, wan, and wan6 interfaces."""
        results = self._r._batch_call([
            (f"network.interface.lan", "status", {}),
            (f"network.interface.wan", "status", {}),
        ])
        return {"lan": results[0], "wan": results[1]}

    def set_lan_ip(self, ipaddr: str, netmask: str = "255.255.255.0"):
        """Change the LAN IP address via UCI."""
        self._r.uci.set("network", "lan", {"ipaddr": ipaddr, "netmask": netmask})
        self._r.uci.commit("network")

    def set_wan_protocol(self, proto: str, **kwargs):
        """
        Set WAN protocol.

        proto: "dhcp", "static", "pppoe", etc.
        kwargs: additional options (ipaddr, netmask, username, password, etc.)
        """
        values = {"proto": proto, **kwargs}
        self._r.uci.set("network", "wan", values)
        self._r.uci.commit("network")

    def add_vlan(self, name: str, vid: int, parent_device: str = "br-lan",
                 ipaddr: str = None, netmask: str = "255.255.255.0"):
        """Create a new VLAN interface."""
        device_name = f"{parent_device}.{vid}"
        self._r.uci.set("network", name, {
            "proto": "static",
            "device": device_name,
            "ipaddr": ipaddr or f"192.168.{vid}.1",
            "netmask": netmask,
        })
        self._r.uci.commit("network")


# ---------------------------------------------------------------------------
# High-level API: Wireless
# ---------------------------------------------------------------------------
class WirelessApi:
    """WiFi radio and interface management."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def status(self) -> dict:
        """Get status of all wireless radios and interfaces."""
        return self._r._call("network.wireless", "status")

    def up(self) -> dict:
        """Enable all wireless interfaces."""
        return self._r._call("network.wireless", "up")

    def down(self) -> dict:
        """Disable all wireless interfaces."""
        return self._r._call("network.wireless", "down")

    def scan(self, device: str = "wlan0") -> list[dict]:
        """Scan for nearby WiFi networks."""
        result = self._r._call("iwinfo", "scan", {"device": device})
        return result.get("results", [])

    def connected_clients(self, device: str = "wlan0") -> list[dict]:
        """Get list of connected wireless clients."""
        result = self._r._call("iwinfo", "assoclist", {"device": device})
        return result.get("results", [])

    def radio_info(self, device: str = "wlan0") -> dict:
        """Get radio information (frequency, txpower, channel, etc.)."""
        return self._r._call("iwinfo", "info", {"device": device})

    def set_ssid(self, radio: str, iface_section: str, ssid: str):
        """Change the SSID of a wireless interface."""
        self._r.uci.set("wireless", iface_section, {"ssid": ssid})
        self._r.uci.commit("wireless")

    def set_password(self, iface_section: str, password: str,
                     encryption: str = "sae-mixed"):
        """Change WiFi password and encryption method."""
        self._r.uci.set("wireless", iface_section, {
            "key": password,
            "encryption": encryption,
        })
        self._r.uci.commit("wireless")

    def set_channel(self, radio_section: str, channel: int | str):
        """Set the WiFi channel (or 'auto')."""
        self._r.uci.set("wireless", radio_section, {"channel": str(channel)})
        self._r.uci.commit("wireless")

    def create_guest_network(self, radio: str, ssid: str, password: str,
                             network: str = "guest"):
        """Create an isolated guest WiFi network."""
        self._r.uci.add("wireless", "wifi-iface", {
            "device": radio,
            "mode": "ap",
            "ssid": ssid,
            "encryption": "sae-mixed",
            "key": password,
            "network": network,
            "isolate": "1",
        })
        self._r.uci.commit("wireless")

    def reload(self):
        """Reload wireless (down then up) to apply config changes."""
        self.down()
        time.sleep(1)
        self.up()


# ---------------------------------------------------------------------------
# High-level API: DHCP
# ---------------------------------------------------------------------------
class DHCPApi:
    """DHCP server and DNS management."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def active_leases(self) -> list[dict]:
        """Get all active IPv4 DHCP leases.

        ``ubus call dhcp ipv4leases`` is the documented object on mainline
        OpenWrt, but on 24.10.x it consistently returns an empty object
        even when odhcpd/dnsmasq have live entries in /tmp/dhcp.leases.
        The ``luci-rpc`` object reads the same files and DOES return the
        populated list, so we try it first and fall back to the native
        call only when luci-rpc isn't installed (build without luci).
        """
        try:
            result = self._r._call("luci-rpc", "getDHCPLeases")
            leases = result.get("dhcp_leases") or []
            if leases:
                return leases
        except UbusError as exc:
            # luci-rpc missing or permission denied — fall through. Any
            # other ubus error from luci-rpc is treated as non-fatal so
            # the native path still has a chance.
            logger.debug("luci-rpc getDHCPLeases unavailable: %s", exc)
        result = self._r._call("dhcp", "ipv4leases")
        return result.get("dhcp_leases", [])

    def active_leases_v6(self) -> list[dict]:
        """Get all active IPv6 DHCP leases.

        Same fallback logic as :meth:`active_leases` — ``luci-rpc
        getDHCPLeases`` returns both v4 and v6 under ``dhcp6_leases``.
        """
        try:
            result = self._r._call("luci-rpc", "getDHCPLeases")
            leases = result.get("dhcp6_leases") or []
            if leases:
                return leases
        except UbusError as exc:
            logger.debug("luci-rpc getDHCPLeases unavailable: %s", exc)
        result = self._r._call("dhcp", "ipv6leases")
        return result.get("dhcp_leases", [])

    def find_device_by_hostname(self, hostname_fragment: str) -> Optional[dict]:
        """Find a DHCP lease by partial hostname match (case-insensitive)."""
        fragment = hostname_fragment.lower()
        for lease in self.active_leases():
            if fragment in lease.get("hostname", "").lower():
                return lease
        return None

    def add_static_lease(self, name: str, mac: str, ip: str, leasetime: str = "infinite"):
        """Add a static DHCP reservation."""
        self._r.uci.add("dhcp", "host", {
            "name": name,
            "mac": mac,
            "ip": ip,
            "leasetime": leasetime,
        })
        self._r.uci.commit("dhcp")

    def set_dns_servers(self, servers: list[str]):
        """Set custom upstream DNS servers on WAN."""
        self._r.uci.set("network", "wan", {
            "peerdns": "0",
            "dns": " ".join(servers),
        })
        self._r.uci.commit("network")

    def reload(self):
        """Restart dnsmasq to apply DHCP/DNS changes."""
        self._r.exec_service("dnsmasq", "restart")


# ---------------------------------------------------------------------------
# High-level API: Firewall
# ---------------------------------------------------------------------------
class FirewallApi:
    """Firewall zones, rules, and port forwards."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def get_zones(self) -> dict:
        """Read all firewall zones."""
        return self._r.uci.get("firewall", type="zone")

    def get_rules(self) -> dict:
        """Read all firewall rules."""
        return self._r.uci.get("firewall", type="rule")

    def get_redirects(self) -> dict:
        """Read all port forward / NAT redirect rules."""
        return self._r.uci.get("firewall", type="redirect")

    def block_device(self, mac: str, name: Optional[str] = None):
        """Block a device (by MAC address) from accessing the internet."""
        rule_name = name or f"block-{mac.replace(':', '')}"
        self._r.uci.add("firewall", "rule", {
            "name": rule_name,
            "src": "lan",
            "dest": "wan",
            "src_mac": mac,
            "target": "REJECT",
            "enabled": "1",
        })
        self._r.uci.commit("firewall")
        self.reload()

    def unblock_device(self, mac: str):
        """Remove all firewall rules blocking a specific MAC address."""
        config = self._r.uci.get("firewall", type="rule")
        for section_name, section_data in config.get("values", {}).items():
            if section_data.get("src_mac", "").upper() == mac.upper():
                if section_data.get("target") == "REJECT":
                    self._r.uci.delete("firewall", section_name)
        self._r.uci.commit("firewall")
        self.reload()

    def add_port_forward(self, name: str, src_port: str, dest_ip: str,
                         dest_port: str, proto: str = "tcp"):
        """Add a port forwarding rule (WAN -> LAN device)."""
        self._r.uci.add("firewall", "redirect", {
            "name": name,
            "src": "wan",
            "dest": "lan",
            "proto": proto,
            "src_dport": src_port,
            "dest_ip": dest_ip,
            "dest_port": dest_port,
            "target": "DNAT",
            "enabled": "1",
        })
        self._r.uci.commit("firewall")
        self.reload()

    def create_zone(self, name: str, input: str = "REJECT",
                    output: str = "ACCEPT", forward: str = "REJECT",
                    network: Optional[str] = None, masq: bool = False):
        """Create a new firewall zone."""
        values = {
            "name": name,
            "input": input,
            "output": output,
            "forward": forward,
        }
        if network:
            values["network"] = network
        if masq:
            values["masq"] = "1"
        self._r.uci.add("firewall", "zone", values)
        self._r.uci.commit("firewall")

    def add_forwarding(self, src: str, dest: str):
        """Allow traffic forwarding between two zones."""
        self._r.uci.add("firewall", "forwarding", {"src": src, "dest": dest})
        self._r.uci.commit("firewall")

    def reload(self):
        """Reload the firewall to apply changes."""
        self._r.exec_service("firewall", "reload")


# ---------------------------------------------------------------------------
# High-level API: System
# ---------------------------------------------------------------------------
class SystemApi:
    """System-level operations."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def board_info(self) -> dict:
        """Get hardware and OS info (kernel, hostname, model, release)."""
        return self._r._call("system", "board")

    def resource_info(self) -> dict:
        """Get CPU load, memory usage, and uptime."""
        return self._r._call("system", "info")

    def reboot(self):
        """Reboot the OpenWrt device."""
        return self._r._call("system", "reboot")

    def set_hostname(self, hostname: str):
        """Change the system hostname."""
        self._r.uci.set("system", "@system[0]", {"hostname": hostname})
        self._r.uci.commit("system")

    def set_timezone(self, zonename: str, timezone_string: str):
        """
        Set the timezone.

        zonename: e.g. "America/New_York"
        timezone_string: POSIX TZ string, e.g. "EST5EDT,M3.2.0,M11.1.0"
        """
        self._r.uci.set("system", "@system[0]", {
            "zonename": zonename,
            "timezone": timezone_string,
        })
        self._r.uci.commit("system")

    def uptime_seconds(self) -> int:
        """Return system uptime in seconds."""
        info = self.resource_info()
        return info.get("uptime", 0)


# ---------------------------------------------------------------------------
# High-level API: VPN (WireGuard)
# ---------------------------------------------------------------------------
class VPNApi:
    """WireGuard VPN management."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def generate_keypair(self) -> tuple[str, str]:
        """Generate a WireGuard keypair on the OpenWrt device."""
        priv_result = self._r.exec_command("wg", ["genkey"])
        private_key = priv_result.get("stdout", "").strip()

        # Write the private key to a temp file to avoid shell injection
        self._r.file.write("/tmp/.wg_privkey", private_key)
        pub_result = self._r.exec_command("sh", ["-c", "wg pubkey < /tmp/.wg_privkey && rm -f /tmp/.wg_privkey"])
        public_key = pub_result.get("stdout", "").strip()

        return private_key, public_key

    def create_interface(self, name: str, private_key: str,
                         listen_port: int = 51820, address: str = "10.0.100.1/24"):
        """Create a WireGuard network interface."""
        self._r.uci.set("network", name, {
            "proto": "wireguard",
            "private_key": private_key,
            "listen_port": str(listen_port),
            "addresses": address,
        })
        self._r.uci.commit("network")

    def add_peer(self, interface: str, public_key: str, allowed_ips: str,
                 description: str = "", endpoint: str = "",
                 persistent_keepalive: int = 25):
        """Add a WireGuard peer to an interface."""
        values = {
            "public_key": public_key,
            "allowed_ips": allowed_ips,
            "persistent_keepalive": str(persistent_keepalive),
        }
        if description:
            values["description"] = description
        if endpoint:
            values["endpoint_host"] = endpoint
        self._r.uci.add("network", f"wireguard_{interface}", values)
        self._r.uci.commit("network")

    def setup_firewall(self, interface: str = "wg0"):
        """Create firewall zone and rules for WireGuard."""
        self._r.firewall.create_zone(
            name="wg", input="ACCEPT", output="ACCEPT",
            forward="ACCEPT", network=interface, masq=True,
        )
        self._r.firewall.add_forwarding("wg", "lan")
        self._r.firewall.add_forwarding("wg", "wan")

        # Allow WireGuard port through WAN
        self._r.uci.add("firewall", "rule", {
            "name": "Allow-WireGuard",
            "src": "wan",
            "proto": "udp",
            "dest_port": "51820",
            "target": "ACCEPT",
            "enabled": "1",
        })
        self._r.uci.commit("firewall")
        self._r.firewall.reload()


# ---------------------------------------------------------------------------
# High-level API: File operations
# ---------------------------------------------------------------------------
class FileApi:
    """File system operations on the OpenWrt device."""

    def __init__(self, router: "DropletRouter"):
        self._r = router

    def read(self, path: str) -> str:
        """Read a file and return its contents."""
        result = self._r._call("file", "read", {"path": path})
        return result.get("data", "")

    def write(self, path: str, data: str) -> dict:
        """Write data to a file."""
        return self._r._call("file", "write", {"path": path, "data": data})

    def list_dir(self, path: str) -> list[dict]:
        """List directory contents."""
        result = self._r._call("file", "list", {"path": path})
        return result.get("entries", [])

    def stat(self, path: str) -> dict:
        """Get file metadata (size, permissions, timestamps)."""
        return self._r._call("file", "stat", {"path": path})

    def exec(self, command: str, params: Optional[list[str]] = None) -> dict:
        """Execute a command and return stdout, stderr, and exit code."""
        args: dict[str, Any] = {"command": command}
        if params:
            args["params"] = params
        return self._r._call("file", "exec", args)


# ---------------------------------------------------------------------------
# Main router class
# ---------------------------------------------------------------------------
class DropletRouter:
    """
    Top-level client for controlling the Droplet's OpenWrt routing layer.

    Provides authenticated access to all network configuration APIs via
    the ubus JSON-RPC interface.
    """

    def __init__(self, host: str = "192.168.50.1", port: int = 80,
                 username: str = "droplet-ai", password: str = "",
                 scheme: str = "http", timeout: int = 10,
                 auto_login: bool = True):
        self._client = UbusClient(host, port, scheme, timeout)
        self._session = SessionManager(self._client, username, password)

        # Initialize sub-APIs
        self.uci = UCIApi(self)
        self.network = NetworkApi(self)
        self.wireless = WirelessApi(self)
        self.dhcp = DHCPApi(self)
        self.firewall = FirewallApi(self)
        self.system = SystemApi(self)
        self.vpn = VPNApi(self)
        self.file = FileApi(self)

        if auto_login:
            self._session.login()

    @property
    def session_token(self) -> str:
        return self._session.ensure_valid()

    def _call(self, obj: str, method: str, args: Optional[dict] = None) -> Any:
        """Make an authenticated ubus call."""
        return self._client.call(self.session_token, obj, method, args)

    def _batch_call(self, calls: list[tuple[str, str, dict]]) -> list[Any]:
        """Make multiple authenticated ubus calls in a single request."""
        return self._client.batch_call(self.session_token, calls)

    def exec_command(self, command: str, params: Optional[list[str]] = None) -> dict:
        """Execute a shell command on the OpenWrt device."""
        return self.file.exec(command, params)

    def exec_service(self, service: str, action: str) -> dict:
        """Run a service init script action (start, stop, restart, reload)."""
        return self.exec_command(f"/etc/init.d/{service}", [action])

    def list_objects(self, pattern: str = "*") -> dict:
        """List all available ubus objects."""
        return self._client.list_objects(self.session_token, pattern)

    def apply_changes(self, config: str, timeout: int = 30):
        """Commit and safely apply config changes with auto-rollback."""
        self.uci.commit(config)
        self.uci.apply(timeout=timeout, rollback=True)

        # Verify we still have connectivity
        try:
            self.system.board_info()
            self.uci.confirm()
            logger.info("Changes to '%s' applied and confirmed.", config)
        except ConnectionLost:
            logger.warning(
                "Lost connectivity after applying '%s'. "
                "Changes will auto-rollback in %ds.", config, timeout
            )
            raise

    @contextmanager
    def safe_apply(self, timeout: int = 60):
        """
        Context manager for safe configuration changes.

        Usage:
            with router.safe_apply(timeout=60):
                router.uci.set("network", "lan", {"ipaddr": "192.168.2.1"})
                router.uci.commit("network")

        Changes are applied with a rollback timer. If connectivity is lost,
        OpenWrt will automatically revert after `timeout` seconds.

        Default is 60s to match the orchestrator's confirmation-token TTL
        (WARP-41) — a Tier 2 token can never outlive the apply window.
        """
        yield self

        # Apply all pending changes
        self.uci.apply(timeout=timeout, rollback=True)

        # Verify connectivity
        try:
            self.system.board_info()
            self.uci.confirm()
            logger.info("Safe apply: changes confirmed.")
        except ConnectionLost:
            logger.warning(
                "Safe apply: connectivity lost. Auto-rollback in %ds.", timeout
            )
            raise

    def disconnect(self):
        """Logout and clean up."""
        self._session.logout()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.disconnect()


# ---------------------------------------------------------------------------
# Convenience: AI agent integration helpers
# ---------------------------------------------------------------------------
def get_network_summary(router: DropletRouter) -> dict:
    """
    Get a complete network summary for the AI model's context.

    Returns a dict with interfaces, wireless, DHCP leases, and system info
    that can be fed into the LLM's context window.
    """
    return {
        "system": router.system.board_info(),
        "resources": router.system.resource_info(),
        "lan": router.network.interface_status("lan"),
        "wan": router.network.interface_status("wan"),
        "wireless": router.wireless.status(),
        "dhcp_leases": router.dhcp.active_leases(),
        "firewall_zones": router.firewall.get_zones(),
    }


def describe_network_for_llm(router: DropletRouter) -> str:
    """
    Generate a natural-language summary of the network state
    that can be injected into an LLM system prompt.
    """
    summary = get_network_summary(router)

    lan = summary["lan"]
    wan = summary["wan"]
    resources = summary["resources"]
    leases = summary["dhcp_leases"]

    lan_ip = "unknown"
    if lan.get("ipv4-address"):
        lan_ip = lan["ipv4-address"][0]["address"]

    wan_ip = "unknown"
    if wan.get("ipv4-address"):
        wan_ip = wan["ipv4-address"][0]["address"]

    uptime_hours = resources.get("uptime", 0) // 3600
    mem_total = resources.get("memory", {}).get("total", 0) // (1024 * 1024)
    mem_free = resources.get("memory", {}).get("free", 0) // (1024 * 1024)

    lines = [
        f"Network Status: LAN IP {lan_ip}, WAN IP {wan_ip}",
        f"Uptime: {uptime_hours} hours",
        f"Memory: {mem_free}MB free / {mem_total}MB total",
        f"Connected devices (DHCP): {len(leases)}",
    ]

    for lease in leases:
        lines.append(f"  - {lease.get('hostname', 'Unknown')} ({lease.get('ipaddr')}, MAC: {lease.get('macaddr')})")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI quick-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    host = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.1"
    password = sys.argv[2] if len(sys.argv) > 2 else ""

    with DropletRouter(host=host, password=password) as router:
        print("=== System Board Info ===")
        print(json.dumps(router.system.board_info(), indent=2))

        print("\n=== LAN Status ===")
        print(json.dumps(router.network.interface_status("lan"), indent=2))

        print("\n=== DHCP Leases ===")
        for lease in router.dhcp.active_leases():
            print(f"  {lease['hostname']:30s} {lease['ipaddr']:15s} {lease['macaddr']}")

        print("\n=== Network Summary for AI ===")
        print(describe_network_for_llm(router))
