"""
Droplet Routing Service
=======================
FastAPI wrapper around the OpenWrt SDK, exposing router management
as a REST API for the orchestrator and AI gateway to consume.
"""

import os
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from droplet_openwrt_sdk import (
    DropletRouter,
    ConnectionLost,
    UbusError,
    get_network_summary,
    describe_network_for_llm,
)
from schemas import (
    HealthResponse,
    SetSsidRequest,
    SetPasswordRequest,
    SetChannelRequest,
    CreateGuestNetworkRequest,
    StaticLeaseRequest,
    SetDnsRequest,
    BlockDeviceRequest,
    UnblockDeviceRequest,
    PortForwardRequest,
    ApplyConfigRequest,
    CreateVlanRequest,
    CameraSubnetSetupRequest,
)

logger = logging.getLogger("droplet.routing")
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Router singleton
# ---------------------------------------------------------------------------
OPENWRT_HOST = os.environ.get("OPENWRT_HOST", "192.168.50.1")
OPENWRT_PORT = int(os.environ.get("OPENWRT_PORT", "80"))
OPENWRT_USERNAME = os.environ.get("OPENWRT_USERNAME", "droplet-ai")
OPENWRT_PASSWORD = os.environ.get("OPENWRT_PASSWORD")
if not OPENWRT_PASSWORD:
    raise ValueError("OPENWRT_PASSWORD environment variable is required")

router_instance: Optional[DropletRouter] = None


def get_router() -> DropletRouter:
    """Return the router singleton, raising 503 if not connected."""
    if router_instance is None:
        raise HTTPException(status_code=503, detail="Router not connected")
    return router_instance


def handle_router_error(exc: Exception):
    """Convert SDK exceptions to HTTPException raises."""
    if isinstance(exc, ConnectionLost):
        raise HTTPException(status_code=503, detail=f"Router unreachable: {exc}")
    if isinstance(exc, UbusError):
        status = 400 if exc.code in (1, 2) else 500
        raise HTTPException(status_code=status, detail=f"ubus error: {exc.status}: {exc}")
    raise HTTPException(status_code=500, detail=f"Internal error: {exc}")


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global router_instance
    try:
        router_instance = DropletRouter(
            host=OPENWRT_HOST,
            port=OPENWRT_PORT,
            username=OPENWRT_USERNAME,
            password=OPENWRT_PASSWORD,
            auto_login=True,
        )
        logger.info("Connected to OpenWrt router at %s", OPENWRT_HOST)
    except (ConnectionLost, UbusError) as exc:
        logger.warning("Could not connect to OpenWrt router: %s", exc)
        router_instance = None

    yield

    if router_instance:
        router_instance.disconnect()
        logger.info("Disconnected from OpenWrt router")


app = FastAPI(title="Droplet Routing Service", version="1.0.0", lifespan=lifespan)


@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    """Catch unhandled exceptions and return a clean 500 without leaking internals."""
    logger.error("Unhandled exception: %s", exc)
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
def health():
    if router_instance is None:
        return HealthResponse(
            status="disconnected",
            connected=False,
            router_host=OPENWRT_HOST,
            error="Router not connected at startup",
        )
    try:
        board = router_instance.system.board_info()
        return HealthResponse(status="ok", connected=True, router_host=OPENWRT_HOST, board=board)
    except (ConnectionLost, UbusError) as exc:
        return HealthResponse(
            status="error",
            connected=False,
            router_host=OPENWRT_HOST,
            error=str(exc),
        )


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
@app.get("/network/summary")
def network_summary():
    try:
        return get_network_summary(get_router())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/network/summary/text")
def network_summary_text():
    try:
        return {"text": describe_network_for_llm(get_router())}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/network/interfaces")
def network_interfaces():
    try:
        return get_router().network.get_all_interface_statuses()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/network/interfaces/{name}")
def network_interface_status(name: str):
    try:
        return get_router().network.interface_status(name)
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/network/interfaces/{name}/up")
def network_interface_up(name: str):
    try:
        get_router().network.interface_up(name)
        return {"status": "ok", "interface": name, "action": "up"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/network/interfaces/{name}/down")
def network_interface_down(name: str):
    try:
        get_router().network.interface_down(name)
        return {"status": "ok", "interface": name, "action": "down"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Wireless
# ---------------------------------------------------------------------------
@app.get("/wireless/status")
def wireless_status():
    try:
        return get_router().wireless.status()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/wireless/scan")
def wireless_scan(device: str = "wlan0"):
    try:
        return {"results": get_router().wireless.scan(device)}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/wireless/clients")
def wireless_clients(device: str = "wlan0"):
    try:
        return {"clients": get_router().wireless.connected_clients(device)}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/wireless/radio/{device}")
def wireless_radio_info(device: str = "wlan0"):
    try:
        return get_router().wireless.radio_info(device)
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/wireless/ssid")
def set_ssid(req: SetSsidRequest):
    try:
        r = get_router()
        r.wireless.set_ssid(req.radio, req.iface_section, req.ssid)
        r.apply_changes("wireless")
        return {"status": "ok", "ssid": req.ssid}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/wireless/password")
def set_password(req: SetPasswordRequest):
    try:
        r = get_router()
        r.wireless.set_password(req.iface_section, req.password, req.encryption)
        r.apply_changes("wireless")
        return {"status": "ok"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/wireless/channel")
def set_channel(req: SetChannelRequest):
    try:
        r = get_router()
        r.wireless.set_channel(req.radio_section, req.channel)
        r.apply_changes("wireless")
        return {"status": "ok", "channel": req.channel}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/wireless/guest")
def create_guest_network(req: CreateGuestNetworkRequest):
    try:
        r = get_router()
        r.wireless.create_guest_network(req.radio, req.ssid, req.password, req.network)
        r.apply_changes("wireless")
        return {"status": "ok", "ssid": req.ssid, "network": req.network}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# DHCP
# ---------------------------------------------------------------------------
@app.get("/dhcp/leases")
def dhcp_leases():
    try:
        return {"leases": get_router().dhcp.active_leases()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/dhcp/leases/v6")
def dhcp_leases_v6():
    try:
        return {"leases": get_router().dhcp.active_leases_v6()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/dhcp/static-lease")
def add_static_lease(req: StaticLeaseRequest):
    try:
        r = get_router()
        r.dhcp.add_static_lease(req.name, req.mac, req.ip, req.leasetime)
        r.exec_service("dnsmasq", "restart")
        return {"status": "ok", "name": req.name, "mac": req.mac, "ip": req.ip}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/dhcp/dns")
def set_dns(req: SetDnsRequest):
    try:
        r = get_router()
        r.dhcp.set_dns_servers(req.servers)
        r.apply_changes("network")
        return {"status": "ok", "servers": req.servers}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
@app.get("/firewall/zones")
def firewall_zones():
    try:
        return get_router().firewall.get_zones()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/firewall/rules")
def firewall_rules():
    try:
        return get_router().firewall.get_rules()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/firewall/redirects")
def firewall_redirects():
    try:
        return get_router().firewall.get_redirects()
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/block-device")
def block_device(req: BlockDeviceRequest):
    try:
        get_router().firewall.block_device(req.mac, req.name)
        return {"status": "ok", "mac": req.mac, "action": "blocked"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/unblock-device")
def unblock_device(req: UnblockDeviceRequest):
    try:
        get_router().firewall.unblock_device(req.mac)
        return {"status": "ok", "mac": req.mac, "action": "unblocked"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/firewall/port-forward")
def add_port_forward(req: PortForwardRequest):
    try:
        get_router().firewall.add_port_forward(
            req.name, req.src_port, req.dest_ip, req.dest_port, req.proto,
        )
        return {"status": "ok", "name": req.name}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# VLANs / Camera Subnet
# ---------------------------------------------------------------------------
@app.get("/network/vlans")
def list_vlans():
    """List all configured VLANs by scanning UCI network config for VLAN interfaces."""
    try:
        r = get_router()
        # Get all network interfaces and filter for VLAN devices (contain '.')
        config = r.uci.get("network")
        vlans = []
        if isinstance(config, dict):
            for name, section in config.items():
                if isinstance(section, dict):
                    device = section.get("device", "")
                    if "." in str(device) and section.get("proto") == "static":
                        vlans.append({
                            "name": name,
                            "device": device,
                            "ipaddr": section.get("ipaddr"),
                            "netmask": section.get("netmask"),
                            "proto": section.get("proto"),
                        })
        return {"vlans": vlans}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/network/vlans")
def create_vlan(req: CreateVlanRequest):
    """Create a new VLAN interface."""
    try:
        r = get_router()
        r.network.add_vlan(
            name=req.name,
            vid=req.vid,
            parent_device=req.parent_device,
            ipaddr=req.ipaddr,
            netmask=req.netmask,
        )
        r.apply_changes("network")
        return {"status": "ok", "name": req.name, "vid": req.vid, "ipaddr": req.ipaddr}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/network/subnets/cameras")
def get_camera_subnet():
    """Get camera subnet configuration status."""
    try:
        r = get_router()
        # Check if the cameras interface exists
        try:
            iface = r.uci.get("network", "cameras")
            zone = None
            # Find the cameras firewall zone
            fw_config = r.uci.get("firewall")
            if isinstance(fw_config, dict):
                for name, section in fw_config.items():
                    if isinstance(section, dict) and section.get("name") == "cameras":
                        zone = section
                        break
            # Check DHCP pool
            dhcp_pool = None
            try:
                dhcp_pool = r.uci.get("dhcp", "cameras")
            except Exception:
                pass

            return {
                "enabled": True,
                "interface": iface if isinstance(iface, dict) else {},
                "firewall_zone": zone,
                "dhcp_pool": dhcp_pool if isinstance(dhcp_pool, dict) else None,
                "subnet": iface.get("ipaddr", "192.168.100.1") if isinstance(iface, dict) else None,
                "netmask": iface.get("netmask", "255.255.255.0") if isinstance(iface, dict) else None,
            }
        except Exception:
            return {"enabled": False}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/network/subnets/cameras/setup")
def setup_camera_subnet(req: CameraSubnetSetupRequest):
    """One-click camera subnet setup: VLAN + firewall zone + DHCP + isolation rules.

    Uses safe-apply with automatic rollback on connectivity loss.
    Future: This endpoint abstracts the implementation so it can switch
    from software VLANs to ASIC hardware VLANs without API changes.
    """
    try:
        r = get_router()

        with r.safe_apply(timeout=30):
            # 1. Create VLAN interface
            device_name = f"br-lan.{req.vlan_id}"
            r.uci.set("network", "cameras", {
                "proto": "static",
                "device": device_name,
                "ipaddr": req.subnet,
                "netmask": req.netmask,
            })

            # 2. Create bridge-vlan entry
            r.uci.add("network", "bridge-vlan", {
                "device": "br-lan",
                "vlan": str(req.vlan_id),
                "ports": "eth1:t",
            })
            r.uci.commit("network")

            # 3. Create firewall zone (isolated: REJECT input, REJECT forward)
            r.uci.add("firewall", "zone", {
                "name": "cameras",
                "network": "cameras",
                "input": "REJECT",
                "output": "ACCEPT",
                "forward": "REJECT",
            })

            # 4. Allow LAN (Droplet) → cameras (for RTSP/ONVIF access)
            r.uci.add("firewall", "forwarding", {
                "src": "lan",
                "dest": "cameras",
            })

            # 5. Allow cameras → WAN (NTP, DNS, firmware updates)
            r.uci.add("firewall", "forwarding", {
                "src": "cameras",
                "dest": "wan",
            })

            # 6. Allow camera DHCP and DNS to router
            r.uci.add("firewall", "rule", {
                "name": "Allow-Camera-DHCP",
                "src": "cameras",
                "proto": "udp",
                "dest_port": "67-68",
                "target": "ACCEPT",
            })
            r.uci.add("firewall", "rule", {
                "name": "Allow-Camera-DNS",
                "src": "cameras",
                "proto": "tcpudp",
                "dest_port": "53",
                "target": "ACCEPT",
            })
            r.uci.commit("firewall")

            # 7. Create DHCP pool for camera subnet
            r.uci.set("dhcp", "cameras", {
                "interface": "cameras",
                "start": str(req.dhcp_start),
                "limit": str(req.dhcp_limit),
                "leasetime": req.leasetime,
            })
            r.uci.commit("dhcp")

        return {
            "status": "ok",
            "vlan_id": req.vlan_id,
            "subnet": req.subnet,
            "netmask": req.netmask,
            "dhcp_range": f"{req.subnet.rsplit('.', 1)[0]}.{req.dhcp_start} - .{req.dhcp_start + req.dhcp_limit - 1}",
            "firewall": "cameras zone created with LAN→cameras and cameras→WAN forwarding",
        }

    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost during camera subnet setup — rolling back",
                "detail": str(exc),
                "rollback_pending": True,
            },
        )
    except (UbusError) as exc:
        handle_router_error(exc)


@app.delete("/network/subnets/cameras")
def teardown_camera_subnet():
    """Remove the camera subnet (VLAN, firewall zone, DHCP pool)."""
    try:
        r = get_router()

        with r.safe_apply(timeout=30):
            # Remove network interface
            try:
                r.uci.delete("network", "cameras")
                r.uci.commit("network")
            except Exception:
                pass

            # Remove firewall zone and rules related to cameras
            fw_config = r.uci.get("firewall")
            if isinstance(fw_config, dict):
                to_delete = []
                for name, section in fw_config.items():
                    if not isinstance(section, dict):
                        continue
                    # Delete cameras zone
                    if section.get("name") == "cameras" and section.get(".type") == "zone":
                        to_delete.append(name)
                    # Delete forwarding rules involving cameras
                    if section.get(".type") == "forwarding":
                        if section.get("src") == "cameras" or section.get("dest") == "cameras":
                            to_delete.append(name)
                    # Delete camera-specific rules
                    if section.get(".type") == "rule":
                        rule_name = section.get("name", "")
                        if "Camera" in rule_name and section.get("src") == "cameras":
                            to_delete.append(name)

                for name in to_delete:
                    try:
                        r.uci.delete("firewall", name)
                    except Exception:
                        pass
                r.uci.commit("firewall")

            # Remove DHCP pool
            try:
                r.uci.delete("dhcp", "cameras")
                r.uci.commit("dhcp")
            except Exception:
                pass

        return {"status": "ok", "action": "camera_subnet_removed"}

    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={"error": "Connectivity lost during teardown", "detail": str(exc)},
        )
    except (UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------
@app.get("/system/info")
def system_info():
    try:
        r = get_router()
        return {
            "board": r.system.board_info(),
            "resources": r.system.resource_info(),
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/system/reboot")
def system_reboot():
    try:
        get_router().system.reboot()
        return {"status": "ok", "action": "reboot"}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Config apply (safe-apply with rollback)
# ---------------------------------------------------------------------------
@app.post("/config/apply")
def apply_config(req: ApplyConfigRequest):
    try:
        r = get_router()
        with r.safe_apply(timeout=req.timeout):
            for config in req.configs:
                r.uci.commit(config)
        return {"status": "ok", "configs": req.configs, "confirmed": True}
    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost after apply",
                "detail": str(exc),
                "rollback_pending": True,
                "timeout": req.timeout,
            },
        )
    except UbusError as exc:
        handle_router_error(exc)
