"""WARP-1674 — OpenWrtSwitchDriver against a fake ubus transport.

Same discipline as the Lantronix tests: NO test may ever open a socket to a
real device. The fake models rpcd's ubus-over-HTTP JSON-RPC surface for
exactly the objects the driver calls (session/system/network.device/uci/poe),
with the GS1900-10HP image's committed shapes: anonymous `poe` port sections
carrying a `name` option, `bridge-vlan` sections with "lanN:u*"/"lanN:t"
port entries, and `poe info` in realtek-poe's format (budget/consumption in
watts, ports keyed "lanN").
"""

from __future__ import annotations

import json

import httpx
import pytest

from drivers.base import (
    AuthenticationError,
    ConnectionLost,
    InvalidPortError,
    SwitchAPIError,
)
from drivers.openwrt import OpenWrtSwitchDriver

GOOD_PASSWORD = "unit-test-pw"
TOKEN = "f" * 32


class FakeUbus:
    """In-memory rpcd. Records every (obj, method, args) for assertions and
    mutates its uci state on writes so read-backs behave like the device."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []
        self.login_count = 0
        self.session_valid = True
        self.uci = {
            "network": {
                "cfg_vlan1": {
                    ".type": "bridge-vlan",
                    "device": "switch",
                    "vlan": "1",
                    "ports": ["lan1:u*", "lan3:u*", "lan9:t", "lan10:t"],
                },
                "cfg_vlan100": {
                    ".type": "bridge-vlan",
                    "device": "switch",
                    "vlan": "100",
                    "name": "cameras",
                    "ports": ["lan2:u*", "lan9:t"],
                },
                "cfg_dev": {".type": "device", "name": "switch", "type": "bridge"},
            },
            "poe": {
                "cfg_glob": {".type": "global", "budget": "77"},
                "cfg_p1": {".type": "port", "name": "lan1", "enable": "1"},
                "cfg_p2": {".type": "port", "name": "lan2", "enable": "0"},
                "cfg_p3": {".type": "port", "name": "lan3", "enable": "1"},
            },
        }
        self.devices = {
            "lan1": {
                "up": True,
                "carrier": True,
                "speed": "1000F",
                "macaddr": "70:49:a2:77:64:01",
                # WARP-1716: netifd ships counters on this same read.
                "statistics": {"rx_bytes": 1500000, "tx_bytes": 900000, "rx_packets": 4200},
            },
            "lan2": {"up": True, "carrier": False, "speed": "-1F"},
            "lan3": {"up": True, "carrier": True, "speed": "100H"},
            "lan9": {"up": True, "carrier": True, "speed": "1000F"},
            "switch": {"up": True, "macaddr": "70:49:a2:77:64:1a"},
        }
        self.poe_ports = {
            "lan1": {"priority": 2, "mode": "PoE+", "status": "Delivering power", "consumption": 2.4},
            "lan2": {"status": "Disabled"},
            "lan3": {"mode": "PoE", "status": "Searching"},
        }

    async def __call__(self, payload: dict) -> dict:
        session, obj, method, args = payload["params"]
        self.calls.append((obj, method, args))
        rid = payload["id"]

        def ok(data=None):
            result = [0] if data is None else [0, data]
            return {"jsonrpc": "2.0", "id": rid, "result": result}

        def status(code):
            return {"jsonrpc": "2.0", "id": rid, "result": [code]}

        if obj == "session" and method == "login":
            self.login_count += 1
            if args.get("password") != GOOD_PASSWORD:
                return status(6)
            self.session_valid = True
            return ok({"ubus_rpc_session": TOKEN, "timeout": 300})
        if obj == "session" and method == "destroy":
            return ok()

        if session != TOKEN or not self.session_valid:
            return status(6)

        if obj == "system" and method == "board":
            return ok({
                "hostname": "droplet-switch",
                "model": "Zyxel GS1900-10HP A1",
                "release": {"distribution": "OpenWrt", "version": "25.12.5"},
            })
        if obj == "system" and method == "info":
            return ok({"uptime": 93784})
        if obj == "network.device" and method == "status":
            if args.get("name"):
                return ok(self.devices.get(args["name"], {}))
            return ok(self.devices)
        if obj == "network" and method == "reload":
            return ok()
        if obj == "poe" and method == "info":
            return ok({
                "firmware": "v13.4",
                "budget": 77.0,
                "consumption": 2.4,
                "ports": self.poe_ports,
            })
        if obj == "poe" and method == "reload":
            return ok()
        if obj == "uci":
            config = args.get("config", "")
            if method == "configs":
                return ok({"configs": list(self.uci)})
            if method == "get":
                if config not in self.uci:
                    return status(4)  # NOT_FOUND
                return ok({"values": self.uci[config]})
            if method == "set":
                section = self.uci.get(config, {}).get(args.get("section", ""))
                if section is None:
                    return status(4)
                section.update(args.get("values", {}))
                return ok()
            if method == "add":
                sid = f"cfg_new{len(self.uci.get(config, {}))}"
                self.uci.setdefault(config, {})[sid] = {
                    ".type": args.get("type", ""),
                    **args.get("values", {}),
                }
                return ok({"section": sid})
            if method == "delete":
                self.uci.get(config, {}).pop(args.get("section", ""), None)
                return ok()
            if method == "commit":
                return ok()

        return status(3)  # METHOD_NOT_FOUND for anything unmodelled


def make_driver(fake: FakeUbus, *, password: str = GOOD_PASSWORD, plan_only: bool = True) -> OpenWrtSwitchDriver:
    return OpenWrtSwitchDriver(
        host="192.168.9.2",
        username="droplet-ai",
        password=password,
        plan_only=plan_only,
        transport=fake,
    )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class TestAuth:
    @pytest.mark.asyncio
    async def test_connect_logs_in(self):
        fake = FakeUbus()
        driver = make_driver(fake)
        await driver.connect()
        assert fake.login_count == 1

    @pytest.mark.asyncio
    async def test_wrong_password_raises_authentication_error(self):
        fake = FakeUbus()
        driver = make_driver(fake, password="stale-after-reflash")
        with pytest.raises(AuthenticationError) as excinfo:
            await driver.connect()
        assert "switch_password" in str(excinfo.value)

    @pytest.mark.asyncio
    async def test_expired_session_relogs_in_once_transparently(self):
        fake = FakeUbus()
        driver = make_driver(fake)
        await driver.connect()
        # Simulate rpcd expiring the session server-side; the re-login (NULL
        # session) revalidates it inside the fake's login handler.
        fake.session_valid = False
        info = await driver.get_system_info()
        assert info["model"] == "Zyxel GS1900-10HP A1"
        assert fake.login_count == 2

    @pytest.mark.asyncio
    async def test_transport_failure_is_connection_lost(self):
        async def dead(_payload):
            raise httpx.ConnectError("no route to host")

        driver = OpenWrtSwitchDriver(host="192.168.9.2", password=GOOD_PASSWORD, transport=dead)
        with pytest.raises(ConnectionLost):
            await driver.connect()


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------
class TestReads:
    @pytest.mark.asyncio
    async def test_system_info_maps_board_uptime_and_budget(self):
        driver = make_driver(FakeUbus())
        info = await driver.get_system_info()
        assert info["model"] == "Zyxel GS1900-10HP A1"
        assert info["firmware_version"] == "25.12.5"
        assert info["hostname"] == "droplet-switch"
        assert info["mac_address"] == "70:49:a2:77:64:1a"
        assert info["uptime"] == "1d 2h"
        assert info["port_count"] == 10
        assert info["poe_budget_mw"] == 77000.0

    @pytest.mark.asyncio
    async def test_get_ports_maps_link_speed_pvid_and_sfp(self):
        driver = make_driver(FakeUbus())
        ports = {p["port"]: p for p in await driver.get_ports()}
        assert len(ports) == 10
        assert ports[1]["link_up"] is True
        assert ports[1]["speed"] == "1 Gb"
        assert ports[1]["duplex"] == "full"
        assert ports[1]["vlan"] == 1
        assert ports[2]["link_up"] is False
        assert ports[2]["speed"] == ""
        assert ports[2]["vlan"] == 100  # lan2:u* on the cameras VLAN
        assert ports[3]["speed"] == "100 Mb"
        assert ports[3]["duplex"] == "half"
        assert ports[9]["is_sfp"] is True
        assert ports[10]["is_sfp"] is True
        assert ports[10]["link_up"] is False  # absent from netifd → down

    @pytest.mark.asyncio
    async def test_get_ports_carries_netifd_byte_counters(self):
        """WARP-1716 — counters are the only evidence the dashboard has that a
        port is carrying traffic rather than merely being plugged in."""
        driver = make_driver(FakeUbus())
        ports = {p["port"]: p for p in await driver.get_ports()}
        assert ports[1]["traffic"] == {"rx_bytes": 1500000, "tx_bytes": 900000}
        # A port netifd reports without a statistics block gets None, NOT zeros
        # — "unknown" and "nothing crossed here" are different claims.
        assert ports[3]["traffic"] is None
        assert ports[10]["traffic"] is None

    @pytest.mark.asyncio
    async def test_get_ports_rejects_malformed_counters(self):
        fake = FakeUbus()
        fake.devices["lan1"]["statistics"] = {"rx_bytes": "not-a-number", "tx_bytes": 1}
        fake.devices["lan3"]["statistics"] = {"rx_bytes": -5, "tx_bytes": 1}
        fake.devices["lan9"]["statistics"] = {"tx_bytes": 1}  # rx_bytes missing
        driver = make_driver(fake)
        ports = {p["port"]: p for p in await driver.get_ports()}
        assert ports[1]["traffic"] is None
        assert ports[3]["traffic"] is None
        assert ports[9]["traffic"] is None

    @pytest.mark.asyncio
    async def test_port_status_passes_traffic_through(self):
        """The §7 aggregation joins port_status, not get_ports — the counters
        have to survive that hop or the dashboard never sees them."""
        driver = make_driver(FakeUbus())
        rows = {r["port"]: r for r in await driver.get_port_status()}
        assert rows[1]["traffic"] == {"rx_bytes": 1500000, "tx_bytes": 900000}
        assert rows[3]["traffic"] is None

    @pytest.mark.asyncio
    async def test_get_vlans_parses_bridge_vlan_sections_without_leaking_internals(self):
        driver = make_driver(FakeUbus())
        vlans = await driver.get_vlans()
        assert [v["vlan_id"] for v in vlans] == [1, 100]
        cameras = vlans[1]
        assert cameras["name"] == "cameras"
        assert cameras["ports"] == [
            {"port": 2, "tagged": False, "member": True},
            {"port": 9, "tagged": True, "member": True},
        ]
        for vlan in vlans:
            assert "_section" not in vlan
            for p in vlan["ports"]:
                assert set(p) == {"port", "tagged", "member"}

    @pytest.mark.asyncio
    async def test_poe_status_merges_live_info_with_uci_admin_state(self):
        driver = make_driver(FakeUbus())
        poe = {p["port"]: p for p in await driver.get_poe_status()}
        assert poe[1]["delivering"] is True
        assert poe[1]["power_mw"] == 2400.0
        assert poe[1]["class"] == "PoE+"
        assert poe[1]["max_power_mw"] == 30000
        assert poe[1]["enabled"] is True
        assert poe[2]["enabled"] is False  # uci enable=0 wins over live status
        assert poe[3]["delivering"] is False
        assert poe[3]["max_power_mw"] == 15400  # plain PoE

    @pytest.mark.asyncio
    async def test_backup_config_dumps_every_uci_config_as_json(self):
        driver = make_driver(FakeUbus())
        dump = json.loads(await driver.backup_config())
        assert set(dump) == {"network", "poe"}
        assert "cfg_vlan100" in dump["network"]


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------
class TestWrites:
    @pytest.mark.asyncio
    async def test_set_port_poe_plan_only_records_no_uci_write(self):
        fake = FakeUbus()
        driver = make_driver(fake, plan_only=True)
        result = await driver.set_port_poe(2, True)
        assert result == {"port": 2, "enabled": True, "dry_run": True}
        assert not [c for c in fake.calls if c[0] == "uci" and c[1] in ("set", "commit")]

    @pytest.mark.asyncio
    async def test_set_port_poe_live_resolves_section_by_name_and_reloads(self):
        fake = FakeUbus()
        driver = make_driver(fake, plan_only=False)
        result = await driver.set_port_poe(2, True)
        assert result == {"port": 2, "enabled": True}
        sets = [c for c in fake.calls if c[0] == "uci" and c[1] == "set"]
        assert sets == [("uci", "set", {
            "config": "poe", "section": "cfg_p2", "values": {"enable": "1"},
        })]
        assert ("uci", "commit", {"config": "poe"}) in fake.calls
        assert ("poe", "reload", {}) in fake.calls
        # The fake mutated its uci state, so the read-back saw enabled=True.
        assert fake.uci["poe"]["cfg_p2"]["enable"] == "1"

    @pytest.mark.asyncio
    async def test_set_port_poe_on_sfp_port_is_invalid(self):
        driver = make_driver(FakeUbus())
        with pytest.raises(InvalidPortError):
            await driver.set_port_poe(9, True)

    @pytest.mark.asyncio
    async def test_set_port_enabled_is_explicitly_unsupported(self):
        driver = make_driver(FakeUbus())
        with pytest.raises(SwitchAPIError) as excinfo:
            await driver.set_port_enabled(1, False)
        assert excinfo.value.code == 501

    @pytest.mark.asyncio
    async def test_vlan_writes_are_plan_gated(self):
        fake = FakeUbus()
        driver = make_driver(fake, plan_only=True)
        await driver.create_vlan(200, "iot")
        await driver.delete_vlan(100)
        await driver.set_vlan_membership(100, [{"port": 1, "tagged": False, "member": True}])
        assert not [c for c in fake.calls if c[0] == "uci" and c[1] != "get"]

    @pytest.mark.asyncio
    async def test_set_vlan_membership_live_writes_uci_ports_list(self):
        fake = FakeUbus()
        driver = make_driver(fake, plan_only=False)
        await driver.set_vlan_membership(100, [
            {"port": 2, "tagged": False, "member": True},
            {"port": 4, "tagged": False, "member": True},
            {"port": 9, "tagged": True, "member": True},
            {"port": 5, "tagged": False, "member": False},
        ])
        assert fake.uci["network"]["cfg_vlan100"]["ports"] == [
            "lan2:u*", "lan4:u*", "lan9:t",
        ]
        assert ("network", "reload", {}) in fake.calls


# ---------------------------------------------------------------------------
# Higher-level
# ---------------------------------------------------------------------------
class TestDetectWanPort:
    @pytest.mark.asyncio
    async def test_prefers_linked_sfp(self):
        driver = make_driver(FakeUbus())
        result = await driver.detect_wan_port()
        assert result["wan_port"] == 9
        assert result["confidence"] == "high"

    @pytest.mark.asyncio
    async def test_falls_back_to_first_linked_copper(self):
        fake = FakeUbus()
        fake.devices["lan9"]["carrier"] = False
        driver = make_driver(fake)
        result = await driver.detect_wan_port()
        assert result["wan_port"] == 1
        assert result["confidence"] == "low"


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------
class TestFactory:
    def test_factory_builds_openwrt_driver_with_edge_router_defaults(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ):
        secret = tmp_path / "switch_password"
        secret.write_text("per-unit-pw\n", encoding="utf-8")
        monkeypatch.setenv("SWITCH_DRIVER", "openwrt")
        monkeypatch.setenv("SWITCH_PASSWORD_FILE", str(secret))
        # conftest seeds loopback-safe env defaults so `main` imports cleanly —
        # drop them to prove the factory's own edge-router defaults.
        monkeypatch.delenv("SWITCH_HOST", raising=False)
        monkeypatch.delenv("SWITCH_PORT", raising=False)
        monkeypatch.delenv("SWITCH_USERNAME", raising=False)
        monkeypatch.delenv("SWITCH_LIVE_WRITES", raising=False)
        from drivers import create_driver

        driver = create_driver()
        assert isinstance(driver, OpenWrtSwitchDriver)
        assert driver._base_url == "http://192.168.9.2:80/ubus"
        assert driver._username == "droplet-ai"
        assert driver._password == "per-unit-pw"
        assert driver.plan_only is True  # default-safe until post-flash confirmation
