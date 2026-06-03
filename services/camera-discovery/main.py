"""Camera auto-discovery service.

Polls DHCP leases from the routing service, probes new devices for
RTSP/ONVIF camera support, and auto-configures discovered cameras in Frigate.
Discovery events are published to MQTT for the orchestrator to relay to clients.
"""

from __future__ import annotations

import sys as _sys

# WARP-229: FIPS 140-3 boot self-test. Runs at module import, BEFORE
# any other heavy imports that could initialize OpenSSL on first use.
# Env-gated: enforces only when DROPLET_FIPS_REQUIRED=true. See
# services/_shared/fips_selftest.py for the contract.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("camera-discovery")
except ImportError:
    # Helper not present (running outside the production Docker layout).
    # The env-gated default skips when DROPLET_FIPS_REQUIRED is unset,
    # so this mirrors the no-op path.
    pass

import asyncio
import hmac
import ipaddress
import json
import logging
import os
import re
import time
from datetime import datetime
from urllib.parse import urlparse

import httpx
import paho.mqtt.client as mqtt
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from driver_checker import full_driver_report, auto_fix_drivers
from frigate_client import FrigateClient
from onvif_scanner import discover_cameras, probe_onvif_device
from rtsp_prober import probe_camera
from vendor_init import check_status as vendor_status_check
from vendor_init import initialize_camera as vendor_initialize

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# --- Configuration ---

ROUTING_SERVICE_URL = os.getenv("ROUTING_SERVICE_URL", "http://localhost:8080")
ROUTING_SERVICE_TOKEN = os.getenv("ROUTING_SERVICE_TOKEN", "").strip()
FRIGATE_URL = os.getenv("FRIGATE_URL", "http://localhost:5000")
MQTT_BROKER = os.getenv("MQTT_BROKER", "mqtt://localhost:1883")
DEVICE_SECRET = os.getenv("DEVICE_SECRET", "")  # Shared secret for auth

# Camera subnet: when set, only scan this subnet for cameras.
# Default 192.168.100.0/24 matches the OpenWrt VLAN 100 config.
# Set to empty string to scan all private subnets (no isolation).
CAMERA_SUBNET = os.getenv("CAMERA_SUBNET", "192.168.100.0/24")
_camera_network: ipaddress.IPv4Network | None = None
if CAMERA_SUBNET:
    try:
        _camera_network = ipaddress.ip_network(CAMERA_SUBNET, strict=False)
    except ValueError:
        logger.warning("Invalid CAMERA_SUBNET '%s', scanning all subnets", CAMERA_SUBNET)

try:
    SCAN_INTERVAL = max(int(os.getenv("SCAN_INTERVAL", "30")), 5)
except ValueError:
    SCAN_INTERVAL = 30

# Auto-initialization: when enabled, cameras in a pre-init state (e.g. Hanwha
# Wisenet with ``Initialized=False``) get provisioned with the operator-supplied
# admin credentials on first sighting. Off by default so that adopting
# someone else's camera by accident doesn't silently rotate its password.
AUTO_INITIALIZE = os.getenv("CAMERA_AUTO_INITIALIZE", "").strip().lower() in ("1", "true", "yes")
AUTO_INIT_USERNAME = os.getenv("CAMERA_DEFAULT_USERNAME", "admin").strip() or "admin"
AUTO_INIT_PASSWORD = os.getenv("CAMERA_DEFAULT_PASSWORD", "")

# Track IPs we've already successfully or unsuccessfully initialized so the
# scan loop doesn't re-hit the same camera every 30s.
_auto_init_attempted: set[str] = set()

# --- Security helpers ---

# Allowed private network ranges for camera probing (no loopback, no link-local, no cloud metadata)
_ALLOWED_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
]


def is_safe_ip(ip_str: str) -> bool:
    """Validate that an IP is a safe LAN address to probe (no loopback, link-local, or public)."""
    try:
        addr = ipaddress.ip_address(ip_str)
        if addr.is_loopback or addr.is_link_local or addr.is_multicast:
            return False
        return any(addr in net for net in _ALLOWED_NETWORKS)
    except ValueError:
        return False


def is_camera_subnet_ip(ip_str: str) -> bool:
    """Check if an IP is on the camera subnet (when isolation is active)."""
    if not _camera_network:
        return True  # No subnet filtering — scan all private IPs
    try:
        return ipaddress.ip_address(ip_str) in _camera_network
    except ValueError:
        return False


def is_safe_rtsp_url(url: str) -> bool:
    """Validate that an RTSP URL points to a safe LAN address."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("rtsp", "rtsps"):
            return False
        if not parsed.hostname:
            return False
        return is_safe_ip(parsed.hostname)
    except Exception:
        return False


def _require_auth(request: Request) -> None:
    """Verify request carries valid DEVICE_SECRET for privileged operations.

    Uses ``hmac.compare_digest`` so token comparison runs in constant
    time. An attacker on the LAN can't realistically exfiltrate a
    DEVICE_SECRET via HTTP timing, but the cost of doing the right
    thing here is a single-line import.
    """
    if not DEVICE_SECRET:
        return  # Auth disabled when no secret configured
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(token.encode("utf-8"), DEVICE_SECRET.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Unauthorized — invalid device secret")


MAX_REJECTED_MACS = 1000  # Cap rejected set to prevent unbounded growth

# --- State ---

# Known cameras: MAC address -> camera info
known_cameras: dict[str, dict] = {}
# Discovered but not yet added to Frigate
pending_cameras: dict[str, dict] = {}
# Rejected camera MACs (won't re-discover)
rejected_macs: set[str] = set()

# --- MQTT ---

mqtt_client: mqtt.Client | None = None


def _parse_mqtt_url(url: str) -> tuple[str, int, str | None, str | None]:
    """Parse mqtt://user:pass@host:port into components."""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 1883
    user = parsed.username
    password = parsed.password
    return host, port, user, password


def _connect_mqtt() -> mqtt.Client:
    host, port, user, password = _parse_mqtt_url(MQTT_BROKER)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="droplet-camera-discovery")
    if user:
        client.username_pw_set(user, password)
    client.connect(host, port, keepalive=60)
    client.loop_start()
    return client


def publish_discovery(camera_info: dict) -> None:
    """Publish camera discovery event to MQTT."""
    if mqtt_client:
        mqtt_client.publish(
            "droplet/cameras/discovered",
            json.dumps(camera_info),
            qos=1,
        )


# --- Frigate client ---

frigate = FrigateClient(FRIGATE_URL)

# --- HTTP client for routing service ---

_routing_headers = (
    {"Authorization": f"Bearer {ROUTING_SERVICE_TOKEN}"} if ROUTING_SERVICE_TOKEN else {}
)
routing_client = httpx.AsyncClient(
    base_url=ROUTING_SERVICE_URL,
    timeout=10.0,
    headers=_routing_headers,
)


async def fetch_dhcp_leases() -> list[dict]:
    """Fetch active DHCP leases from the routing service."""
    try:
        resp = await routing_client.get("/dhcp/leases")
        resp.raise_for_status()
        data = resp.json()
        return data.get("leases", data) if isinstance(data, dict) else data
    except Exception as e:
        logger.error("Failed to fetch DHCP leases: %s", e)
        return []


def _is_camera_hostname(hostname: str) -> bool:
    """Heuristic: check if hostname suggests an IP camera."""
    camera_keywords = [
        "cam", "camera", "ipc", "nvr", "dvr", "hikvision", "dahua",
        "reolink", "amcrest", "axis", "foscam", "wyze", "eufy",
        "unifi", "protect", "tapo", "ezviz", "annke",
    ]
    hostname_lower = hostname.lower()
    return any(kw in hostname_lower for kw in camera_keywords)


def _sanitize_camera_name(hostname: str, ip: str) -> str:
    """Generate a safe Frigate-compatible camera name."""
    if hostname and hostname != "*":
        name = re.sub(r"[^a-z0-9]", "_", hostname.lower()).strip("_")
        if name:
            return name
    return "camera_" + ip.replace(".", "_")


async def _subnet_sweep(network: ipaddress.IPv4Network) -> list[str]:
    """Async TCP-port sweep of a subnet for hosts with port 554 (RTSP) open.

    Runs alongside the DHCP feed so adoption still works for static-IP
    cameras, non-Droplet DHCP servers, and the window before a fresh
    lease shows up. Capped to /22 (~1k hosts) and throttled to 64
    in-flight connections — without the semaphore a /24 bursts 250+
    sockets at once and we trip the default ``ulimit -n`` on the
    Jetson (RLIMIT_NOFILE=1024 out of the box).
    """
    if network.num_addresses > 1024:
        logger.warning(
            "Subnet %s too large for sweep (%d hosts); skipping",
            network, network.num_addresses,
        )
        return []

    sem = asyncio.Semaphore(64)

    async def _check(ip: str) -> str | None:
        async with sem:
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection(ip, 554), timeout=1.2,
                )
            except (asyncio.TimeoutError, OSError):
                return None
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return ip

    hosts = [str(h) for h in network.hosts()]
    results = await asyncio.gather(*[_check(h) for h in hosts])
    return [ip for ip in results if ip]


def _reconcile_synthetic_macs(leases: list[dict]) -> None:
    """Migrate ``ip:X.X.X.X`` placeholder records to real DHCP MACs.

    When a camera is adopted during a subnet sweep (static IP, or DHCP
    hadn't resolved yet) we key it by a synthetic ``ip:<addr>`` token.
    If a later scan finds a real DHCP lease for that same IP, move the
    record to the real MAC so:
      * re-scans don't re-adopt it as a "new" camera,
      * manual ``DELETE /cameras/{mac}`` works with the real MAC,
      * the record carries a stable hostname once DHCP knows it.
    """
    if not leases:
        return
    ip_to_mac = {
        (lease.get("ipaddr") or ""): (lease.get("macaddr") or "").lower()
        for lease in leases
        if lease.get("ipaddr") and (lease.get("macaddr") or "").lower()
    }
    for bucket in (known_cameras, pending_cameras):
        for stale_key in [k for k in bucket if k.startswith("ip:")]:
            record = bucket[stale_key]
            real_mac = ip_to_mac.get(record.get("ip"))
            if not real_mac or real_mac.startswith("ip:"):
                continue
            if real_mac in bucket or real_mac in rejected_macs:
                bucket.pop(stale_key, None)
                continue
            record["mac"] = real_mac
            bucket[real_mac] = record
            bucket.pop(stale_key, None)
            logger.info(
                "Reconciled synthetic key %s -> real MAC %s for %s",
                stale_key, real_mac, record.get("ip"),
            )


async def _maybe_auto_initialize(ip: str) -> bool:
    """Run vendor first-run flow for one camera when AUTO_INITIALIZE is on.

    Opt-in — off by default so we don't silently rotate an admin
    password on a camera the operator didn't intend to adopt. Defence
    in depth: re-check the subnet gate even though the scan loop
    already filtered by it (this function also runs from manual entry
    points and rotates credentials — worth a second check).
    """
    if not AUTO_INITIALIZE:
        return False
    if not AUTO_INIT_PASSWORD:
        return False
    if not is_safe_ip(ip) or not is_camera_subnet_ip(ip):
        return False
    if ip in _auto_init_attempted:
        return False

    status = await vendor_status_check(ip)
    if status is None:
        # Transient / unknown-vendor. Don't mark as attempted — the
        # next scan should retry once the camera is reachable or its
        # vendor is recognized.
        return False
    if not status.needs_initialization:
        # Already initialized. Record the attempt so we stop probing.
        _auto_init_attempted.add(ip)
        return False

    _auto_init_attempted.add(ip)
    logger.info(
        "Auto-initializing %s (vendor=%s) with operator-supplied credentials",
        ip, status.vendor,
    )
    result = await vendor_initialize(ip, AUTO_INIT_USERNAME, AUTO_INIT_PASSWORD)
    if result.success:
        logger.info("Auto-init succeeded on %s (vendor=%s)", ip, result.vendor)
        publish_discovery({
            "event": "camera_initialized",
            "ip": ip,
            "vendor": result.vendor,
        })
        return True
    logger.warning(
        "Auto-init failed on %s (vendor=%s): %s",
        ip, result.vendor, result.message,
    )
    return False


async def scan_and_discover() -> None:
    """Main discovery loop iteration.

    1. Fetch DHCP leases from the routing service
    2. Sweep the camera subnet for RTSP hosts (catches static-IP cameras)
    3. Run any operator-approved first-run init on fresh cameras
    4. Probe each candidate with RTSP and ONVIF
    5. Add confirmed cameras to Frigate
    6. Publish events to MQTT
    """
    leases = await fetch_dhcp_leases()

    # Always run a port-554 sweep of the camera subnet in parallel with the
    # DHCP query so adoption works on static IPs, non-Droplet DHCP
    # servers, and the brief window before a fresh lease shows up.
    # Synthetic records are keyed by ``ip:<addr>`` so a later DHCP scan
    # can reconcile them back to the real MAC via _reconcile_synthetic_macs.
    if _camera_network is not None:
        try:
            swept = await _subnet_sweep(_camera_network)
        except Exception as exc:
            logger.warning("Subnet sweep raised: %s", exc)
            swept = []
        known_lease_ips = {l.get("ipaddr") for l in leases}
        synthetic = [
            {
                "ipaddr": ip,
                "macaddr": f"ip:{ip}",
                "hostname": "",
                "source": "sweep",
            }
            for ip in swept
            if ip not in known_lease_ips
        ]
        if synthetic:
            logger.info(
                "Subnet sweep found %d static-IP host(s) not in DHCP leases",
                len(synthetic),
            )
        leases = list(leases) + synthetic

    _reconcile_synthetic_macs(leases)

    # Also run ONVIF WS-Discovery for cameras that might not have DHCP hostnames
    onvif_devices = []
    try:
        onvif_devices = await discover_cameras()
    except Exception as e:
        logger.debug("ONVIF discovery failed: %s", e)

    # Build candidate set: DHCP devices + ONVIF discoveries
    candidates: dict[str, dict] = {}

    for lease in leases:
        mac = lease.get("macaddr", "").lower()
        ip = lease.get("ipaddr", "")
        hostname = lease.get("hostname", "")

        if not mac or not ip:
            continue
        if not is_safe_ip(ip):
            continue  # Skip non-LAN IPs (loopback, link-local, public)
        if not is_camera_subnet_ip(ip):
            continue  # Skip IPs outside camera subnet when isolation is active
        if mac in known_cameras or mac in rejected_macs:
            continue

        candidates[mac] = {
            "ip": ip,
            "mac": mac,
            "hostname": hostname,
            "is_likely_camera": _is_camera_hostname(hostname),
            "source": lease.get("source", "dhcp"),
        }

    # Add ONVIF-discovered devices
    for device in onvif_devices:
        ip = device.get("ip", "")
        if not is_safe_ip(ip):
            continue  # Skip non-LAN IPs
        # Find matching DHCP lease for MAC
        mac = next(
            (c["mac"] for c in candidates.values() if c["ip"] == ip),
            None,
        )
        if not mac:
            # No DHCP match — use IP as key
            mac = f"onvif_{ip.replace('.', '_')}"

        if mac in known_cameras or mac in rejected_macs:
            continue

        candidates[mac] = {
            **candidates.get(mac, {}),
            "ip": ip,
            "mac": mac,
            "manufacturer": device.get("manufacturer"),
            "model": device.get("model"),
            "rtsp_url": device.get("rtsp_url"),
            "detection_method": device.get("detection_method", "onvif"),
            "is_likely_camera": True,
        }

    if not candidates:
        return

    logger.info("Scanning %d candidate device(s) for cameras", len(candidates))

    for mac, candidate in candidates.items():
        ip = candidate["ip"]

        # First-run provisioning: Hanwha/Wisenet etc. reject every API
        # call (403 on SUNAPI, 401 on RTSP) until the operator sets the
        # initial admin password. When auto-init is on AND we have a
        # site-wide password configured, drive the vendor's first-run
        # flow so the RTSP probe below has a chance of authenticating.
        await _maybe_auto_initialize(ip)

        # Skip if already has full info from ONVIF discovery
        if candidate.get("rtsp_url"):
            camera_info = candidate
        else:
            # Try ONVIF probe first
            onvif_info = await probe_onvif_device(ip)
            if onvif_info:
                camera_info = {**candidate, **onvif_info}
            else:
                # Fall back to RTSP probing
                rtsp_info = await probe_camera(ip)
                if rtsp_info:
                    camera_info = {**candidate, **rtsp_info}
                elif candidate.get("is_likely_camera"):
                    # Hostname suggests camera but no streams found — add as pending
                    camera_info = candidate
                else:
                    # Not a camera
                    continue

        camera_name = _sanitize_camera_name(
            camera_info.get("hostname", ""), ip
        )
        camera_info["name"] = camera_name
        camera_info["discovered_at"] = time.time()

        # Validate RTSP URL before sending to Frigate
        rtsp_url = camera_info.get("rtsp_url")
        if rtsp_url and not is_safe_rtsp_url(rtsp_url):
            logger.warning("Rejecting unsafe RTSP URL from %s: %s", ip, rtsp_url)
            rtsp_url = None
            camera_info["rtsp_url"] = None

        # If we have a valid RTSP URL, auto-add to Frigate
        if rtsp_url:
            success = await frigate.add_camera(camera_name, camera_info["rtsp_url"])
            if success:
                camera_info["status"] = "active"
                known_cameras[mac] = camera_info
                logger.info(
                    "Auto-added camera: %s (%s) at %s",
                    camera_name,
                    camera_info.get("manufacturer", "unknown"),
                    ip,
                )
            else:
                camera_info["status"] = "pending"
                pending_cameras[mac] = camera_info
        else:
            camera_info["status"] = "pending"
            pending_cameras[mac] = camera_info

        # Publish discovery event
        publish_discovery({
            "event": "camera_discovered",
            "camera": {
                "name": camera_name,
                "ip": ip,
                "mac": mac,
                "manufacturer": camera_info.get("manufacturer"),
                "model": camera_info.get("model"),
                "rtsp_url": camera_info.get("rtsp_url"),
                "status": camera_info.get("status"),
                "detection_method": camera_info.get("detection_method"),
            },
        })


# --- Scan scheduler (WARP-221) ---
#
# The periodic discovery sweep runs on an apscheduler AsyncIOScheduler
# interval job rather than a hand-rolled `while True: ... asyncio.sleep`
# loop. This is the canonical pattern (CLAUDE.md "No `while True` loops
# for scheduling"; mirrors services/routing/scheduler.py). apscheduler
# gives us coalesce + max_instances overlap protection and graceful
# shutdown the bare loop lacked.

_scan_scheduler: AsyncIOScheduler | None = None


async def run_scan() -> None:
    """One discovery sweep, with the try/except the old loop body had.

    A failing scan is logged and swallowed so a transient sweep error
    never tears down the schedule — the next interval tick retries.
    """
    try:
        await scan_and_discover()
    except Exception as e:
        logger.error("Discovery scan error: %s", e)


def build_scan_scheduler() -> AsyncIOScheduler:
    """Build (but do not start) the AsyncIOScheduler that drives the
    periodic discovery sweep.

    ``next_run_time=datetime.now()`` fires the first scan immediately,
    preserving the old loop's "scan, then sleep" cadence.
    ``coalesce=True`` + ``max_instances=1`` mean a scan that overruns
    SCAN_INTERVAL never overlaps itself, and the backed-up ticks that
    piled up while it ran collapse into a single catch-up run instead of
    a burst — a guarantee the bare while-True loop didn't make. We set
    ``misfire_grace_time`` generously (one full SCAN_INTERVAL) so those
    missed ticks are actually treated as misfires eligible for coalescing
    rather than silently dropped by the default 1 s grace window; the net
    effect for idempotent discovery is a delayed catch-up scan, never a
    lost one.
    """
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        run_scan,
        "interval",
        seconds=SCAN_INTERVAL,
        id="camera-discovery-scan",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=SCAN_INTERVAL,
        next_run_time=datetime.now(),
    )
    return scheduler


# --- FastAPI app ---

app = FastAPI(title="Droplet Camera Discovery", version="0.1.0")


async def _reconcile_with_frigate() -> None:
    """Drop ``known_cameras`` entries that Frigate no longer has.

    ``known_cameras`` is our in-memory cache of what we told Frigate
    about. If someone wipes the Frigate config.yml, recreates the
    container, or manually removes a camera, our cache goes stale and
    the scan loop skips re-adding because the MAC looks "already
    known". Reconcile on startup (and after explicit /scan calls) by
    asking Frigate for its active camera list and dropping any of our
    records whose Frigate name no longer exists.
    """
    try:
        frigate_cams = await frigate.get_cameras()
    except Exception as exc:
        logger.debug("Frigate reconcile skipped (stats fetch failed): %s", exc)
        return
    live_names = set(frigate_cams.keys())
    stale = [
        mac for mac, rec in known_cameras.items()
        if rec.get("name") and rec["name"] not in live_names
    ]
    for mac in stale:
        logger.info(
            "Dropping stale known-camera %s (%s) — not present in Frigate",
            mac, known_cameras[mac].get("name"),
        )
        known_cameras.pop(mac, None)


@app.on_event("startup")
async def startup():
    global mqtt_client, _scan_scheduler
    try:
        mqtt_client = _connect_mqtt()
        logger.info("Connected to MQTT broker")
    except Exception as e:
        logger.warning("MQTT connection failed (will retry): %s", e)

    # Wait briefly for Frigate to be ready, then reconcile our cache with
    # its view of the world so a prior-run known_cameras doesn't block
    # re-adoption of a camera that Frigate forgot. This Frigate-readiness
    # wait is a one-time startup step — the scan scheduler below doesn't
    # repeat it per tick.
    for _ in range(12):
        if await frigate.health_check():
            await _reconcile_with_frigate()
            break
        logger.info("Waiting for Frigate to be ready...")
        await asyncio.sleep(5)

    # WARP-221: drive the periodic sweep with apscheduler instead of a
    # hand-rolled while-True loop. next_run_time fires the first scan now.
    _scan_scheduler = build_scan_scheduler()
    _scan_scheduler.start()
    logger.info(
        "Camera discovery scan scheduler started (interval: %ds)", SCAN_INTERVAL
    )


@app.on_event("shutdown")
async def shutdown():
    if _scan_scheduler is not None:
        try:
            _scan_scheduler.shutdown(wait=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("scan scheduler shutdown failed: %s", exc)
    if mqtt_client:
        mqtt_client.loop_stop()
        mqtt_client.disconnect()
    await frigate.close()
    await routing_client.aclose()


@app.get("/health")
async def health():
    frigate_ok = await frigate.health_check()
    return {
        "status": "ok" if frigate_ok else "degraded",
        "frigate": frigate_ok,
        "known_cameras": len(known_cameras),
        "pending_cameras": len(pending_cameras),
    }


@app.get("/cameras/discovered")
async def get_discovered(request: Request):
    """Return pending (not yet added to Frigate) cameras.

    Gated by DEVICE_SECRET (NET-05): pending records carry the discovered
    RTSP URL, which for default-credential cameras embeds ``user:pass@`` —
    reconnaissance-grade data that must not be readable by any LAN peer.
    """
    _require_auth(request)
    return list(pending_cameras.values())


@app.get("/cameras/known")
async def get_known(request: Request):
    """Return all known (active in Frigate) cameras.

    Gated by DEVICE_SECRET (NET-05): leaks camera inventory, RTSP URLs
    (may embed ``user:pass@``), MACs and models otherwise.
    """
    _require_auth(request)
    return list(known_cameras.values())


@app.post("/cameras/discovered/{mac}/accept")
async def accept_camera(mac: str, request: Request):
    """Accept a pending camera — add it to Frigate.

    Gated by DEVICE_SECRET (NET-05): pushing an arbitrary pending camera
    into Frigate is a privileged write, not a public action.
    """
    _require_auth(request)
    camera = pending_cameras.pop(mac, None)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found in pending list")

    rtsp_url = camera.get("rtsp_url")
    if not rtsp_url:
        pending_cameras[mac] = camera  # Put back
        raise HTTPException(status_code=400, detail="No RTSP URL available for this camera")

    name = camera.get("name", _sanitize_camera_name(camera.get("hostname", ""), camera["ip"]))
    success = await frigate.add_camera(name, rtsp_url)
    if success:
        camera["status"] = "active"
        known_cameras[mac] = camera
        publish_discovery({"event": "camera_accepted", "camera": camera})
        return {"status": "accepted", "camera": camera}

    # Put back in pending
    pending_cameras[mac] = camera
    raise HTTPException(status_code=500, detail="Failed to add camera to Frigate")


@app.post("/cameras/discovered/{mac}/reject")
async def reject_camera(mac: str, request: Request):
    """Reject a discovered camera — won't be discovered again.

    Gated by DEVICE_SECRET (NET-05): mutates the rejected-MAC set, a
    privileged write.
    """
    _require_auth(request)
    camera = pending_cameras.pop(mac, None)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    if len(rejected_macs) < MAX_REJECTED_MACS:
        rejected_macs.add(mac)
    return {"status": "rejected", "mac": mac}


@app.post("/scan")
async def trigger_scan(request: Request):
    """Manually trigger a discovery scan.

    Gated by DEVICE_SECRET (NET-05): an on-demand subnet sweep +
    RTSP/ONVIF/default-credential probe is a privileged, resource-intensive
    action — an unauthenticated LAN peer must not be able to launch it.
    """
    _require_auth(request)
    await scan_and_discover()
    return {
        "status": "scan_complete",
        "known": len(known_cameras),
        "pending": len(pending_cameras),
    }


# --- First-run initialization (vendor-specific setup flow) ---


@app.get("/cameras/{ip}/init-status")
async def camera_init_status(ip: str, request: Request):
    """Check whether a camera needs its first-run admin password set.

    Gated by DEVICE_SECRET — the response reveals the camera's vendor
    identity and whether an attacker-facing init endpoint is accepting
    unauthenticated writes, both of which are reconnaissance-grade info
    that doesn't need to be exposed to random LAN peers.
    """
    _require_auth(request)
    if not is_safe_ip(ip) or not is_camera_subnet_ip(ip):
        raise HTTPException(status_code=400, detail="IP is not inside the camera subnet")
    status = await vendor_status_check(ip)
    if status is None:
        raise HTTPException(status_code=404, detail="No recognized init vendor for this IP")
    return {
        "ip": ip,
        "vendor": status.vendor,
        "initialized": status.initialized,
        "needs_initialization": status.needs_initialization,
        "details": status.details,
    }


@app.post("/cameras/{ip}/initialize")
async def camera_initialize(ip: str, request: Request):
    """Run the vendor-specific first-run admin-password flow.

    Request body (all optional): ``{"username": "admin", "password": "site-pw"}``.
    Falls back to ``CAMERA_DEFAULT_USERNAME`` / ``CAMERA_DEFAULT_PASSWORD``
    from the environment when the body omits them. Privileged call —
    requires ``DEVICE_SECRET`` when auth is enabled.
    """
    _require_auth(request)
    if not is_safe_ip(ip) or not is_camera_subnet_ip(ip):
        raise HTTPException(status_code=400, detail="IP is not inside the camera subnet")

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    username = (body.get("username") or AUTO_INIT_USERNAME).strip() or "admin"
    password = body.get("password") or AUTO_INIT_PASSWORD
    if not password:
        raise HTTPException(
            status_code=400,
            detail=(
                "no password supplied — send {\"password\": ...} in the body or set "
                "CAMERA_DEFAULT_PASSWORD in the service environment"
            ),
        )

    result = await vendor_initialize(ip, username, password)
    _auto_init_attempted.add(ip)
    payload = {
        "ip": ip,
        "vendor": result.vendor,
        "success": result.success,
        "message": result.message,
        "http_status": result.http_status,
    }
    if not result.success:
        return JSONResponse(
            status_code=409 if result.http_status == 490 else 502,
            content=payload,
        )
    return payload


# --- Subnet status ---


@app.get("/subnet/status")
async def subnet_status(request: Request):
    """Report which subnet is being scanned for cameras.

    Gated by DEVICE_SECRET (NET-05): exposes the camera subnet/CIDR and
    isolation state — network-topology reconnaissance.
    """
    _require_auth(request)
    return {
        "camera_subnet": CAMERA_SUBNET or "all_private",
        "isolation_active": _camera_network is not None,
        "network": str(_camera_network) if _camera_network else None,
    }


# --- Driver management endpoints ---


@app.get("/drivers")
async def get_driver_status(request: Request):
    """Get full camera driver status report.

    Gated by DEVICE_SECRET (NET-05): matches the existing ``/drivers/fix``
    gate — the read leaks host kernel-module / driver state.
    """
    _require_auth(request)
    return full_driver_report()


@app.post("/drivers/fix")
async def fix_drivers(request: Request):
    """Attempt to auto-fix camera driver issues. Requires DEVICE_SECRET auth."""
    _require_auth(request)
    report = await auto_fix_drivers()
    status = full_driver_report()
    return {"fix_report": report, "current_status": status}
