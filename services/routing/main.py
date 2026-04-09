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
)

logger = logging.getLogger("droplet.routing")
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Router singleton
# ---------------------------------------------------------------------------
OPENWRT_HOST = os.environ.get("OPENWRT_HOST", "10.0.0.1")
OPENWRT_PORT = int(os.environ.get("OPENWRT_PORT", "80"))
OPENWRT_USERNAME = os.environ.get("OPENWRT_USERNAME", "droplet-ai")
OPENWRT_PASSWORD = os.environ.get("OPENWRT_PASSWORD", "")

router_instance: Optional[DropletRouter] = None


def get_router() -> DropletRouter:
    """Return the router singleton, raising 503 if not connected."""
    if router_instance is None:
        raise HTTPException(status_code=503, detail="Router not connected")
    return router_instance


def handle_router_error(exc: Exception) -> JSONResponse:
    """Convert SDK exceptions to HTTP responses."""
    if isinstance(exc, ConnectionLost):
        return JSONResponse(status_code=503, content={"error": "Router unreachable", "detail": str(exc)})
    if isinstance(exc, UbusError):
        status = 400 if exc.code in (1, 2) else 500
        return JSONResponse(status_code=status, content={"error": f"ubus error: {exc.status}", "detail": str(exc)})
    return JSONResponse(status_code=500, content={"error": "Internal error", "detail": str(exc)})


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
        return handle_router_error(exc)


@app.get("/network/summary/text")
def network_summary_text():
    try:
        return {"text": describe_network_for_llm(get_router())}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.get("/network/interfaces")
def network_interfaces():
    try:
        return get_router().network.get_all_interface_statuses()
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.get("/network/interfaces/{name}")
def network_interface_status(name: str):
    try:
        return get_router().network.interface_status(name)
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/network/interfaces/{name}/up")
def network_interface_up(name: str):
    try:
        get_router().network.interface_up(name)
        return {"status": "ok", "interface": name, "action": "up"}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/network/interfaces/{name}/down")
def network_interface_down(name: str):
    try:
        get_router().network.interface_down(name)
        return {"status": "ok", "interface": name, "action": "down"}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


# ---------------------------------------------------------------------------
# Wireless
# ---------------------------------------------------------------------------
@app.get("/wireless/status")
def wireless_status():
    try:
        return get_router().wireless.status()
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.get("/wireless/scan")
def wireless_scan(device: str = "wlan0"):
    try:
        return {"results": get_router().wireless.scan(device)}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.get("/wireless/clients")
def wireless_clients(device: str = "wlan0"):
    try:
        return {"clients": get_router().wireless.connected_clients(device)}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.get("/wireless/radio/{device}")
def wireless_radio_info(device: str = "wlan0"):
    try:
        return get_router().wireless.radio_info(device)
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/wireless/ssid")
def set_ssid(req: SetSsidRequest):
    try:
        r = get_router()
        r.wireless.set_ssid(req.radio, req.iface_section, req.ssid)
        r.apply_changes("wireless")
        return {"status": "ok", "ssid": req.ssid}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/wireless/password")
def set_password(req: SetPasswordRequest):
    try:
        r = get_router()
        r.wireless.set_password(req.iface_section, req.password, req.encryption)
        r.apply_changes("wireless")
        return {"status": "ok"}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/wireless/channel")
def set_channel(req: SetChannelRequest):
    try:
        r = get_router()
        r.wireless.set_channel(req.radio_section, req.channel)
        r.apply_changes("wireless")
        return {"status": "ok", "channel": req.channel}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/wireless/guest")
def create_guest_network(req: CreateGuestNetworkRequest):
    try:
        r = get_router()
        r.wireless.create_guest_network(req.radio, req.ssid, req.password, req.network)
        r.apply_changes("wireless")
        return {"status": "ok", "ssid": req.ssid, "network": req.network}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


# ---------------------------------------------------------------------------
# DHCP
# ---------------------------------------------------------------------------
@app.get("/dhcp/leases")
def dhcp_leases():
    try:
        return {"leases": get_router().dhcp.active_leases()}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.get("/dhcp/leases/v6")
def dhcp_leases_v6():
    try:
        return {"leases": get_router().dhcp.active_leases_v6()}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/dhcp/static-lease")
def add_static_lease(req: StaticLeaseRequest):
    try:
        r = get_router()
        r.dhcp.add_static_lease(req.name, req.mac, req.ip, req.leasetime)
        r.exec_service("dnsmasq", "restart")
        return {"status": "ok", "name": req.name, "mac": req.mac, "ip": req.ip}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/dhcp/dns")
def set_dns(req: SetDnsRequest):
    try:
        r = get_router()
        r.dhcp.set_dns_servers(req.servers)
        r.apply_changes("network")
        return {"status": "ok", "servers": req.servers}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
@app.get("/firewall/zones")
def firewall_zones():
    try:
        return get_router().firewall.get_zones()
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.get("/firewall/rules")
def firewall_rules():
    try:
        return get_router().firewall.get_rules()
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.get("/firewall/redirects")
def firewall_redirects():
    try:
        return get_router().firewall.get_redirects()
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/firewall/block-device")
def block_device(req: BlockDeviceRequest):
    try:
        get_router().firewall.block_device(req.mac, req.name)
        return {"status": "ok", "mac": req.mac, "action": "blocked"}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/firewall/unblock-device")
def unblock_device(req: UnblockDeviceRequest):
    try:
        get_router().firewall.unblock_device(req.mac)
        return {"status": "ok", "mac": req.mac, "action": "unblocked"}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


@app.post("/firewall/port-forward")
def add_port_forward(req: PortForwardRequest):
    try:
        get_router().firewall.add_port_forward(
            req.name, req.src_port, req.dest_ip, req.dest_port, req.proto,
        )
        return {"status": "ok", "name": req.name}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


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
        return handle_router_error(exc)


@app.post("/system/reboot")
def system_reboot():
    try:
        get_router().system.reboot()
        return {"status": "ok", "action": "reboot"}
    except (ConnectionLost, UbusError) as exc:
        return handle_router_error(exc)


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
        return handle_router_error(exc)
