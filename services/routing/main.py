"""
Droplet Routing Service
=======================
FastAPI wrapper around the OpenWrt SDK, exposing router management
as a REST API for the orchestrator and AI gateway to consume.
"""

import sys as _sys

# WARP-229: FIPS 140-3 boot self-test. Env-gated; see
# services/_shared/fips_selftest.py for the contract.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("routing")
except ImportError:
    pass

import hmac
import os
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

import operations
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
    DnsHostnameRequest,
    BlockDeviceRequest,
    UnblockDeviceRequest,
    PortForwardRequest,
    ApplyConfigRequest,
    CreateVlanRequest,
    CameraSubnetSetupRequest,
    FirewallZoneCollection,
    FirewallRuleCollection,
    FirewallRedirectCollection,
    VpnSetupRequest,
    VpnPeerCreateRequest,
    VpnPeerDeleteRequest,
    DuckDnsConfigRequest,
    ApApproveRequest,
    ApTestSeedRequest,
)
import re

logger = logging.getLogger("droplet.routing")
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Router singleton
# ---------------------------------------------------------------------------
OPENWRT_HOST = os.environ.get("OPENWRT_HOST", "192.168.50.1")
OPENWRT_PORT = int(os.environ.get("OPENWRT_PORT", "80"))
OPENWRT_USERNAME = os.environ.get("OPENWRT_USERNAME", "droplet-ai")

# WARP-44: `real` connects to OpenWrt; `mock` swaps in a fixture-returning
# stub so dev laptops without a router get a realistic UI; `disabled` is an
# orchestrator-side flag — routing still runs for consistency.
ROUTING_MODE = os.environ.get("ROUTING_MODE", "real").strip().lower()
if ROUTING_MODE not in ("real", "mock", "disabled"):
    logger.warning(
        "Unknown ROUTING_MODE=%r — falling back to 'real'. Valid values: real / mock / disabled.",
        ROUTING_MODE,
    )
    ROUTING_MODE = "real"


def _load_openwrt_password() -> str:
    """Load the rpcd password, preferring the Docker secret file (WARP-37).

    Resolution order:
      1. /run/secrets/openwrt_password — Docker Compose file-based secret (preferred).
      2. $OPENWRT_PASSWORD env var — deprecated, kept for dev / legacy bring-up.

    Returns an empty string when nothing is configured; the service still starts
    but logs a warning and every authenticated ubus call will fail at login —
    which is how the service has always behaved when the router is unreachable.
    """
    secret_path = os.environ.get("OPENWRT_PASSWORD_FILE", "/run/secrets/openwrt_password")
    try:
        with open(secret_path, "r", encoding="utf-8") as fh:
            value = fh.read().strip()
        if value:
            return value
        logger.warning(
            "OpenWrt password secret file %s is empty — set OPENWRT_PASSWORD in .env "
            "and re-run ./scripts/setup.sh --sync-secrets",
            secret_path,
        )
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("Could not read OpenWrt password from %s: %s", secret_path, exc)

    env_value = os.environ.get("OPENWRT_PASSWORD", "")
    if env_value:
        logger.warning(
            "OPENWRT_PASSWORD env var is deprecated — migrate to the Docker secret "
            "at /run/secrets/openwrt_password (WARP-37). Falling back to env for now."
        )
    return env_value


OPENWRT_PASSWORD = _load_openwrt_password()
if not OPENWRT_PASSWORD:
    logger.warning(
        "OpenWrt password is not configured — router control will be unavailable "
        "until /run/secrets/openwrt_password (or OPENWRT_PASSWORD) is set."
    )

# Shared bearer for orchestrator / camera-discovery → routing (WARP-36).
# When unset the service runs open — intended for local dev only; production
# bring-up via scripts/setup.sh always generates a token.
ROUTING_SERVICE_TOKEN = os.environ.get("ROUTING_SERVICE_TOKEN", "").strip()
if not ROUTING_SERVICE_TOKEN:
    logger.warning(
        "ROUTING_SERVICE_TOKEN is empty — auth disabled. Set it in production."
    )

# Paths exempt from bearer auth (used by Docker healthcheck / orchestrator health roll-up).
AUTH_EXEMPT_PATHS = frozenset({"/health"})


def require_bearer(request: Request) -> None:
    """Reject requests without a matching `Authorization: Bearer <token>` header."""
    if not ROUTING_SERVICE_TOKEN:
        return
    if request.url.path in AUTH_EXEMPT_PATHS:
        return
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip(), ROUTING_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


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
    if ROUTING_MODE == "mock":
        # WARP-44: fixture-driven router — dev laptops, CI, demos.
        from mock_router import MockRouter

        router_instance = MockRouter()
        logger.info("Started in ROUTING_MODE=mock — serving fixtures, no real OpenWrt connection.")
        yield
        return

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


class OperationTrackingMiddleware(BaseHTTPMiddleware):
    """Assign an operation id to every write (POST/PUT/DELETE) and surface it
    via `X-Operation-Id`. The dashboard polls `GET /operations/{id}` to track
    apply vs. rollback. See WARP-40.

    Skipped for:
      - GETs (reads don't change router state)
      - /operations/* (polling the tracker itself shouldn't create new records)
      - /health (exempt from auth + tracking for Docker healthchecks)
    """

    _TRACKED_METHODS = frozenset({"POST", "PUT", "DELETE"})
    _SKIP_PATH_PREFIXES = ("/operations", "/health")

    async def dispatch(self, request: Request, call_next):
        if request.method not in self._TRACKED_METHODS or any(
            request.url.path.startswith(p) for p in self._SKIP_PATH_PREFIXES
        ):
            return await call_next(request)

        op_id = operations.register()
        request.state.operation_id = op_id
        try:
            response = await call_next(request)
        except Exception as exc:
            operations.mark_rolled_back(op_id, f"handler raised: {exc.__class__.__name__}")
            raise

        # 2xx = router accepted the change.
        # 5xx = upstream failure, conservatively mark as rolled back so the
        #       dashboard warns the user.
        # 4xx = caller error (bad input, auth, etc.) — no router state change,
        #       treat as applied so the dashboard doesn't scare the user.
        if 200 <= response.status_code < 400:
            operations.mark_applied(op_id)
        elif response.status_code >= 500:
            operations.mark_rolled_back(op_id, f"HTTP {response.status_code}")
        else:
            operations.mark_applied(op_id)

        response.headers["X-Operation-Id"] = op_id
        return response


app = FastAPI(
    title="Droplet Routing Service",
    version="1.0.0",
    lifespan=lifespan,
    dependencies=[Depends(require_bearer)],
)
app.add_middleware(OperationTrackingMiddleware)


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
# Operations (WARP-40)
# ---------------------------------------------------------------------------
@app.get("/operations/{op_id}")
def get_operation(op_id: str):
    """Look up an in-flight or recently-finished operation.

    Records live for 5 minutes. After the TTL, returns 404 — the dashboard
    interprets this as "operation is too old to track" and falls back to
    polling the target resource directly.
    """
    op = operations.get(op_id)
    if op is None:
        raise HTTPException(status_code=404, detail="Operation not found or expired")
    return {
        "id": op.id,
        "state": op.state,
        "startedAt": op.started_at,
        "finishedAt": op.finished_at,
        "reason": op.reason,
    }


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
# DNS hostname entries (dnsmasq static name → IP)
# ---------------------------------------------------------------------------
# Same grammar as schemas._HOSTNAME_PATTERN, compiled once for path validation.
_HOSTNAME_PATH_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$"
)


@app.get("/dhcp/hostnames")
def list_dns_hostnames():
    try:
        return {"entries": get_router().dhcp.list_hostrecords()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# Why this specific reload path:
#   1. `exec_service("dnsmasq","restart")` → `file.exec` — denied by the
#      droplet-ai rpcd ACL (openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json
#      deliberately does NOT grant `file.exec`).
#   2. `service.signal` with SIGHUP — permitted, but dnsmasq reads its config
#      from /var/etc/dnsmasq.conf.cfg*, which is *generated* from /etc/config/
#      dhcp by the init script at start/reload time. SIGHUP reloads hostnames
#      from /etc/hosts but NOT the UCI-derived host-records, so our change
#      would persist in UCI but never reach live DNS.
#   3. `uci.apply` with pending (uncommitted) changes — permitted, and this
#      IS what triggers /sbin/reload_config → ucitrack → dnsmasq reload,
#      which regenerates /var/etc/dnsmasq.conf.*. This is why the SDK's
#      set_hostrecord deliberately does NOT pre-commit: apply only emits
#      the reload event when there's something still pending.
# rollback=False so apply doesn't start a rollback timer (there's nothing to
# rollback against — a bad DNS entry can't partition the router). timeout=5
# is well under the 30s default and keeps the HTTP response snappy.
def _commit_and_reload_dhcp(router) -> None:
    router.uci.apply(timeout=5, rollback=False)


@app.post("/dhcp/hostnames")
def upsert_dns_hostname(req: DnsHostnameRequest):
    try:
        r = get_router()
        result = r.dhcp.set_hostrecord(req.hostname, req.ip)
        _commit_and_reload_dhcp(r)
        return {"status": "ok", **result}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.delete("/dhcp/hostnames/{hostname}")
def delete_dns_hostname(hostname: str):
    if not _HOSTNAME_PATH_RE.fullmatch(hostname):
        raise HTTPException(status_code=400, detail="Invalid hostname")
    try:
        r = get_router()
        removed = r.dhcp.delete_hostrecord(hostname)
        if removed == 0:
            raise HTTPException(status_code=404, detail="Hostname not found")
        _commit_and_reload_dhcp(r)
        return {"status": "ok", "hostname": hostname, "removed": removed}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
@app.get("/firewall/zones", response_model=FirewallZoneCollection)
def firewall_zones() -> FirewallZoneCollection:
    # WARP-42: typed through the response model so schema drift becomes a
    # Pydantic validation error at the boundary instead of a silent break
    # in the dashboard.
    try:
        return FirewallZoneCollection.model_validate(get_router().firewall.get_zones())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/firewall/rules", response_model=FirewallRuleCollection)
def firewall_rules() -> FirewallRuleCollection:
    try:
        return FirewallRuleCollection.model_validate(get_router().firewall.get_rules())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/firewall/redirects", response_model=FirewallRedirectCollection)
def firewall_redirects() -> FirewallRedirectCollection:
    try:
        return FirewallRedirectCollection.model_validate(get_router().firewall.get_redirects())
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

        with r.safe_apply(timeout=60):
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

        with r.safe_apply(timeout=60):
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
# VPN (WireGuard)
# ---------------------------------------------------------------------------
#
# Phase 1 of the Remote Access feature. These endpoints wrap VPNApi from the
# OpenWrt SDK and are consumed by the orchestrator (`/api/vpn/peers`), which
# layers user identity + IP allocation + QR rendering on top. Nothing here
# knows about Nextcloud users — peers are anonymous from the router's POV.
#
# Setup is idempotent: calling /vpn/setup twice is fine and just returns the
# existing interface info on the second call. This means the orchestrator can
# treat "ensure VPN is configured" as a single request without coordination.
#
# Server priv keys live in /etc/config/network (uci) — that's how OpenWrt's
# native luci-proto-wireguard stores them. Client priv keys are returned ONCE
# in the /vpn/peers POST response and never persisted server-side.


@app.post("/vpn/setup")
def vpn_setup(req: VpnSetupRequest):
    """Idempotently bring up the WireGuard server interface + firewall.

    First call: generates a fresh server keypair, creates the wg interface,
    opens the listen port on WAN, allows VPN→LAN forwarding.
    Subsequent calls: returns the existing interface info untouched.
    """
    try:
        r = get_router()

        if r.vpn.interface_exists(req.interface):
            info = r.vpn.get_interface_info(req.interface)
            return {"status": "ok", "created": False, **info}

        # Wrap in safe_apply so a misconfigured firewall change can't lock
        # the orchestrator out of the router. 60s timeout matches /config/apply.
        with r.safe_apply(timeout=60):
            private_key, _public_key = r.vpn.generate_keypair()
            r.vpn.create_interface(
                req.interface,
                private_key=private_key,
                listen_port=req.listen_port,
                address=req.address,
            )
            r.vpn.setup_firewall(req.interface, listen_port=req.listen_port)

        # OpenWrt 24.10 has an ordering quirk: when both `network` and
        # `firewall` are committed by the same `uci.apply`, the iface ifup
        # hotplug fires `firewall reload` *during* network reload, before
        # the new firewall config has fully landed for fw4. ucitrack does
        # not always re-fire firewall reload afterward. The narrow fix is
        # to send a `config.change` service event ourselves once apply has
        # settled, which is exactly what `/sbin/reload_config` does.
        try:
            r._call("service", "event", {
                "type": "config.change",
                "data": {"package": "firewall"},
            })
        except (ConnectionLost, UbusError) as exc:
            logger.warning("vpn: firewall reload nudge failed (rule may need manual reload): %s", exc)

        info = r.vpn.get_interface_info(req.interface)
        return {"status": "ok", "created": True, **info}

    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost during VPN setup — rolling back",
                "detail": str(exc),
                "rollback_pending": True,
            },
        )
    except UbusError as exc:
        handle_router_error(exc)


@app.get("/vpn/status")
def vpn_status(interface: str = "wg0"):
    """Return server-side info for a WireGuard interface.

    404 when the interface hasn't been bootstrapped yet — the dashboard uses
    that as the cue to show the "Set up Remote Access" prompt.
    """
    try:
        r = get_router()
        if not r.vpn.interface_exists(interface):
            raise HTTPException(status_code=404, detail=f"VPN interface '{interface}' not configured")
        info = r.vpn.get_interface_info(interface)
        peers = r.vpn.list_peers(interface)
        return {**info, "peer_count": len(peers)}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/vpn/peers")
def vpn_list_peers(interface: str = "wg0"):
    """List peers configured on the interface. Empty list if none."""
    try:
        r = get_router()
        if not r.vpn.interface_exists(interface):
            raise HTTPException(status_code=404, detail=f"VPN interface '{interface}' not configured")
        return {"interface": interface, "peers": r.vpn.list_peers(interface)}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/vpn/peers")
def vpn_create_peer(req: VpnPeerCreateRequest):
    """Mint a peer: generate a keypair, install the pubkey on the router,
    return the priv key + pubkey to the caller.

    The returned `private_key` is one-shot: it's never stored server-side and
    cannot be re-fetched. If the user loses their config they revoke + re-mint.
    """
    try:
        r = get_router()
        if not r.vpn.interface_exists(req.interface):
            raise HTTPException(
                status_code=409,
                detail=f"VPN interface '{req.interface}' not configured — POST /vpn/setup first",
            )

        private_key, public_key = r.vpn.generate_keypair()
        # uci stores allowed_ips as a single comma-joined string.
        allowed_ips_uci = ",".join(req.allowed_ips)
        r.vpn.add_peer(
            interface=req.interface,
            public_key=public_key,
            allowed_ips=allowed_ips_uci,
            description=req.description,
            persistent_keepalive=req.persistent_keepalive,
        )

        # Bring the new peer online without a full network restart by reloading
        # the wg interface. apply (without rollback timer) is the same path used
        # by the DNS hostnames endpoint — it triggers ucitrack -> wg reload.
        try:
            r.uci.apply(timeout=5, rollback=False)
        except Exception as exc:  # noqa: BLE001 — apply failure shouldn't fail the request
            logger.warning("vpn: uci.apply after add_peer failed (peer is staged): %s", exc)

        return {
            "status": "ok",
            "interface": req.interface,
            "public_key": public_key,
            "private_key": private_key,
            "allowed_ips": list(req.allowed_ips),
            "description": req.description,
            "persistent_keepalive": req.persistent_keepalive,
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.delete("/vpn/peers")
def vpn_delete_peer(req: VpnPeerDeleteRequest):
    """Remove every peer matching `public_key` from `interface`.

    404 when there's nothing to remove — the orchestrator treats that as a
    success-equivalent (peer already gone). Multiple matches are deleted in
    one shot; the response carries the count.
    """
    try:
        r = get_router()
        if not r.vpn.interface_exists(req.interface):
            raise HTTPException(status_code=404, detail=f"VPN interface '{req.interface}' not configured")
        removed = r.vpn.delete_peer(req.interface, req.public_key)
        if removed == 0:
            raise HTTPException(status_code=404, detail="Peer not found")
        try:
            r.uci.apply(timeout=5, rollback=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("vpn: uci.apply after delete_peer failed: %s", exc)
        return {"status": "ok", "interface": req.interface, "removed": removed}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


# ---------------------------------------------------------------------------
# DDNS (DuckDNS)
# ---------------------------------------------------------------------------
#
# Tiny surface — there's only one provider in v1 and one config section.
# `GET` returns a redacted view (no token); `PUT` upserts the section with
# the standard DuckDNS template and restarts the ddns service so the
# rotation kicks in immediately.

DUCKDNS_SECTION = "duckdns"


def _read_duckdns(router) -> dict:
    """Read the duckdns ddns section, returning a redacted view.

    Returns `{"configured": False}` when the section doesn't exist yet,
    otherwise carries subdomain + enabled + tokenSet (never the token itself).
    """
    try:
        result = router.uci.get("ddns", DUCKDNS_SECTION)
    except UbusError as exc:
        if exc.code in (4, 5):  # NOT_FOUND / NO_DATA
            return {"configured": False}
        raise
    if not isinstance(result, dict):
        return {"configured": False}
    section = result.get("values", result) if isinstance(result, dict) else {}
    if not isinstance(section, dict) or not section.get("service_name"):
        return {"configured": False}
    return {
        "configured": True,
        "subdomain": section.get("domain", ""),
        "fullDomain": f"{section.get('domain', '')}.duckdns.org" if section.get("domain") else "",
        "enabled": str(section.get("enabled", "0")) == "1",
        "tokenSet": bool(section.get("password")),
        "lastUpdate": section.get("last_update", ""),
    }


@app.get("/ddns/duckdns")
def ddns_duckdns_status():
    """Return the DuckDNS section's current config (token redacted)."""
    try:
        return _read_duckdns(get_router())
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.put("/ddns/duckdns")
def ddns_duckdns_set(req: DuckDnsConfigRequest):
    """Upsert the DuckDNS service section + restart ddns-scripts.

    Idempotent: writes the same set of options every time, so calling this
    repeatedly with the same inputs is a no-op apart from a service restart.
    """
    try:
        r = get_router()

        # uci.set requires the section to exist; use uci.add(name=...) on first
        # call (mirrors the same pattern used for the wireguard interface).
        try:
            existing = r.uci.get("ddns", DUCKDNS_SECTION)
            section_exists = isinstance(existing, dict) and bool(
                existing.get("values") or existing.get(".type")
            )
        except UbusError as exc:
            if exc.code in (4, 5):
                section_exists = False
            else:
                raise

        # When the caller omits the token, keep the value already on disk
        # (the wizard's "keep stored token" path so returning customers
        # don't have to re-type it). Only seed `password` when we have a
        # new token to write; otherwise uci.set merges the remaining
        # fields and leaves the existing password untouched.
        values: dict[str, str] = {
            "service_name": "duckdns.org",
            "domain": req.subdomain,
            "enabled": "1" if req.enabled else "0",
            # Watch WAN for IP changes; DuckDNS is for IPv4 by default.
            "interface": "wan",
            # Use `web` (not `network`): the WAN interface address may itself
            # be a private IP behind another NAT layer (common when the
            # Droplet is plugged into a home router as a downstream device).
            # `web` mode has ddns-scripts query a public checker URL so the
            # IP we publish to DuckDNS is the actual public-facing one.
            "ip_source": "web",
            "ip_url": "https://checkip.amazonaws.com",
            "use_ipv6": "0",
            # Honest user-agent so DuckDNS's logs show this Droplet rather
            # than the generic ddns-scripts default. Helps debugging.
            "use_https": "1",
            # Update at most once per 10 minutes when the IP hasn't changed,
            # plus on every IP change. Default is 72h which is too slow.
            "check_interval": "10",
            "check_unit": "minutes",
            "force_interval": "72",
            "force_unit": "hours",
        }

        if req.token is not None:
            values["password"] = req.token
        elif not section_exists:
            # First-time setup with no token in the request body is a
            # programming error: there's nothing on disk to keep, and
            # ddns-scripts requires a non-empty password to do anything.
            # Surface a clean 422 rather than write a half-formed section.
            raise HTTPException(
                status_code=422,
                detail=(
                    "token is required on first DuckDNS setup; only re-saves "
                    "of an already-configured DuckDNS section may omit it."
                ),
            )

        if section_exists:
            r.uci.set("ddns", DUCKDNS_SECTION, values)
        else:
            r.uci.add("ddns", "service", values=values, name=DUCKDNS_SECTION)

        # uci.apply commits + reloads ddns config (like the DNS hostnames flow).
        r.uci.apply(timeout=5, rollback=False)

        # Nudge ddns-scripts to pick up the new config without waiting for the
        # next scheduled run. service_event triggers ucitrack -> /etc/init.d/ddns.
        try:
            r._call("service", "event", {
                "type": "config.change",
                "data": {"package": "ddns"},
            })
        except (ConnectionLost, UbusError) as exc:
            logger.warning("ddns: reload nudge failed (will pick up on next scheduled run): %s", exc)

        return {"status": "ok", **_read_duckdns(r)}
    except (ConnectionLost, UbusError) as exc:
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


# ---------------------------------------------------------------------------
# Coverage extender APs (WARP-446)
# ---------------------------------------------------------------------------
#
# Per ADR-005. The discovery list itself is owned by the orchestrator's
# mDNS poller; the routing service only sees an already-discovered MAC
# and pushes a wireless config to it. In mock mode the in-memory
# `_MockAp` mirrors the contract — production wires the same shape
# against the real router.
#
# Auth: same Bearer-token + safe_apply discipline as the rest of the
# service. RBAC (which session is allowed to call) lives one layer up
# in the orchestrator's `/api/aps/*` routes.


# Canonical MAC for path-param validation. Lowercase + uppercase
# hex are both accepted; the SDK normalises to uppercase at the boundary.
_MAC_PATH_RE = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")


def _validate_mac(mac: str) -> str:
    if not _MAC_PATH_RE.fullmatch(mac):
        raise HTTPException(status_code=404, detail="Invalid MAC")
    return mac.upper()


def _get_ap_namespace(router):
    """Return the AP namespace from a router, supporting both real and mock.

    The real `DropletRouter.ap` is an `ApApi` instance whose contract is
    "push/remove wireless config + iface_section helpers". The mock's
    `_MockAp` adds the in-memory discovery list on top. Endpoints below
    branch on `hasattr(.., "discovered")` because the real production
    discovery story is orchestrator-side (mDNS poller), not router-side.
    """
    return router.ap


@app.get("/aps/discovered")
def aps_discovered():
    """Return the live mDNS discovery snapshot.

    Two layers:
      - Mock mode (`ROUTING_MODE=mock`): the in-memory `_MockAp`
        exposes a `discovered()` method seeded by `/aps/_test_seed`
        so dev + integration tests can drive the full state machine
        without a real OpenWrt box.
      - Real mode: the SDK's `ApApi.browse_discovered()` issues a
        `ubus call umdns browse` and parses `_droplet-ap._tcp` TXT
        records (mac/model/serial/version) into the orchestrator-
        friendly shape. The droplet-ai rpcd ACL already grants
        `umdns: ["browse", "update"]`
        (openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json), so the
        orchestrator's poller can drive this on a 10s cadence
        without extra privileges (ADR-005 §1).
    """
    try:
        r = get_router()
        ap = _get_ap_namespace(r)
        # Prefer the mock's seeded list when present — `_test_seed`
        # populates it deterministically and we don't want a real umdns
        # call leaking into mock-mode tests.
        if hasattr(ap, "discovered"):
            return {"discovered": ap.discovered()}
        if hasattr(ap, "browse_discovered"):
            return {"discovered": ap.browse_discovered()}
        return {"discovered": []}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.get("/aps/{mac}")
def aps_get(mac: str):
    """Return the current state of a discovered AP.

    States: `discovered` (mDNS seen, no approval), `online` (config
    pushed), `decommissioned` (config removed). Returns 404 when the
    MAC was never announced.
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)
        if not hasattr(ap, "get"):
            raise HTTPException(status_code=404, detail="AP not found")
        info = ap.get(canonical)
        if info is None:
            raise HTTPException(status_code=404, detail="AP not found")
        return info
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/aps/_test_seed")
def aps_test_seed(req: ApTestSeedRequest):
    """Inject a discovered AP into the mock router. Test-only.

    Production discovery is mDNS-driven from the orchestrator; this
    endpoint is the test seam that lets pytest + dev exercise the
    state machine without simulating multicast. Returns 404 when the
    router isn't a MockRouter — there's nothing to seed in real mode.
    """
    try:
        r = get_router()
        ap = _get_ap_namespace(r)
        if not hasattr(ap, "seed"):
            raise HTTPException(
                status_code=404,
                detail="_test_seed only available in ROUTING_MODE=mock",
            )
        ap.seed(
            req.mac,
            model=req.model,
            serial=req.serial,
            version=req.version,
            last_ip=req.last_ip,
            hostname=req.hostname,
        )
        return {"status": "ok", "mac": req.mac.upper()}
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)


@app.post("/aps/{mac}/approve")
def aps_approve(mac: str, req: ApApproveRequest, request: Request):
    """Approve a discovered AP and push wireless config.

    The push is wrapped in `safe_apply` so a misconfigured wireless
    change can't lock the orchestrator out of the main router — same
    discipline `/vpn/setup` and `/network/subnets/cameras/setup` use.
    The Operation-Id surfaces via the middleware-attached
    `X-Operation-Id` header AND in the response body so the
    dashboard's wizard can poll the operation tracker until the
    transition is terminal. The body-mirrored value matters when the
    dashboard reaches us through the orchestrator's HTTP proxy — some
    proxies strip non-standard response headers.
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        # Mock mode tracks discovered state; real mode trusts the
        # orchestrator to only call this with an MAC the orchestrator
        # itself surfaced as discovered.
        if hasattr(ap, "get"):
            existing = ap.get(canonical)
            if existing is None:
                raise HTTPException(status_code=404, detail="AP not found in discovery list")

        from droplet_openwrt_sdk import ApApi
        iface_section = ApApi.iface_section_for_mac(canonical)

        with r.safe_apply(timeout=60):
            # Mock router's `push_wireless_config` takes the MAC so it
            # can track per-AP state; the real SDK's signature doesn't
            # take MAC because the iface_section already encodes it.
            # Detect via the mock's `discovered` attribute.
            if hasattr(ap, "discovered"):
                ap.push_wireless_config(
                    mac=canonical,
                    iface_section=iface_section,
                    radio=req.radio,
                    ssid=req.ssid,
                    encryption=req.encryption,
                    key=req.encryption_key,
                    network=req.network,
                )
            else:
                ap.push_wireless_config(
                    iface_section=iface_section,
                    radio=req.radio,
                    ssid=req.ssid,
                    encryption=req.encryption,
                    key=req.encryption_key,
                    network=req.network,
                )

        return {
            "status": "ok",
            "mac": canonical,
            "iface_section": iface_section,
            "ssid": req.ssid,
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except ConnectionLost as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Connectivity lost during AP approval — rolling back",
                "detail": str(exc),
                "rollback_pending": True,
            },
        )
    except UbusError as exc:
        handle_router_error(exc)


@app.delete("/aps/{mac}")
def aps_decommission(mac: str, request: Request):
    """Remove the wireless config off the AP and transition state.

    Idempotent on previously-decommissioned MACs (re-DELETE is a
    success no-op). Returns 404 only when the MAC was never announced
    at all (matches discovery's contract — can't decommission what
    we've never seen).
    """
    canonical = _validate_mac(mac)
    try:
        r = get_router()
        ap = _get_ap_namespace(r)

        if hasattr(ap, "get"):
            existing = ap.get(canonical)
            if existing is None:
                raise HTTPException(status_code=404, detail="AP not found")

        from droplet_openwrt_sdk import ApApi
        iface_section = ApApi.iface_section_for_mac(canonical)

        with r.safe_apply(timeout=60):
            if hasattr(ap, "discovered"):
                ap.remove_wireless_config(canonical)
            else:
                ap.remove_wireless_config(iface_section=iface_section)

        return {
            "status": "ok",
            "mac": canonical,
            "operation_id": getattr(request.state, "operation_id", None),
        }
    except (ConnectionLost, UbusError) as exc:
        handle_router_error(exc)
