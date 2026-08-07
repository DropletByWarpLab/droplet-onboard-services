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

# WARP-1061 — internal mTLS (hop 13): the routing client presents this
# service's client cert + dials https:// when DROPLET_INTERNAL_TLS=1
# (identity when off). MQTT stays scheme-gated via paho_configure below.
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

from driver_checker import full_driver_report, auto_fix_drivers
from frigate_client import FrigateClient
from onvif_scanner import discover_cameras, probe_onvif_device
from rtsp_prober import probe_camera, verify_stream
from vendor_init import check_status as vendor_status_check
from vendor_init import initialize_camera as vendor_initialize

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# --- Configuration ---

ROUTING_SERVICE_URL = _internal_base_url(
    os.getenv("ROUTING_SERVICE_URL", "http://localhost:8080")
)
ROUTING_SERVICE_TOKEN = os.getenv("ROUTING_SERVICE_TOKEN", "").strip()
FRIGATE_URL = os.getenv("FRIGATE_URL", "http://localhost:5000")
MQTT_BROKER = os.getenv("MQTT_BROKER", "mqtt://localhost:1883")
DEVICE_SECRET = os.getenv("DEVICE_SECRET", "")  # Shared secret for auth
# Fail CLOSED when DEVICE_SECRET is unset: every privileged route returns 403
# (auth required) rather than silently running unauthenticated, since a failed
# secret injection at deploy would otherwise expose camera accept/reject/scan/
# initialize to any LAN host. Opt back into open mode for local dev with
# CAMERA_ALLOW_NO_AUTH=1. Mirrors routing's ROUTING_ALLOW_NO_AUTH contract.
CAMERA_ALLOW_NO_AUTH = os.getenv("CAMERA_ALLOW_NO_AUTH", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
if not DEVICE_SECRET:
    if CAMERA_ALLOW_NO_AUTH:
        logger.warning(
            "DEVICE_SECRET is empty and CAMERA_ALLOW_NO_AUTH is set — auth "
            "disabled on privileged routes. Local dev only; NEVER set this "
            "in production."
        )
    else:
        logger.error(
            "DEVICE_SECRET is empty — failing closed (403) on privileged "
            "routes. Set the secret, or CAMERA_ALLOW_NO_AUTH=1 for local dev."
        )

# Camera subnet: when set, only scan this subnet for cameras.
# Default 192.168.100.0/24 matches the OpenWrt VLAN 100 config.
# Set to empty string to scan all private subnets (no isolation).
# Set to "auto" (the single-box provisioning default — WARP-1805) to resolve
# the camera network from the edge router at scan time via the routing
# service, so the filter and sweep follow the LAN that actually hands
# cameras their leases instead of a provision-time constant that goes stale
# every time the fabric moves (192.168.100.0/24 → 192.168.20.0/24 → the
# Pi edge router's LAN, each of which silently blinded discovery).
CAMERA_SUBNET = os.getenv("CAMERA_SUBNET", "192.168.100.0/24")
CAMERA_SUBNET_AUTO = CAMERA_SUBNET.strip().lower() == "auto"
_camera_network: ipaddress.IPv4Network | None = None
if CAMERA_SUBNET and not CAMERA_SUBNET_AUTO:
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

    Fails CLOSED when no secret is configured: an unset DEVICE_SECRET
    (e.g. a failed secret injection at deploy) yields 403 rather than
    silently running every privileged route unauthenticated. Opt into
    the old open behaviour for local dev with ``CAMERA_ALLOW_NO_AUTH=1``.
    """
    if not DEVICE_SECRET:
        if CAMERA_ALLOW_NO_AUTH:
            return  # Auth explicitly disabled for local dev
        raise HTTPException(
            status_code=403,
            detail=(
                "Camera-discovery auth is not configured (DEVICE_SECRET unset). "
                "Set the secret, or CAMERA_ALLOW_NO_AUTH=1 for local dev."
            ),
        )
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
# PYNET-017: MACs whose accept is mid-flight (claimed between the pending peek
# and the Frigate commit). accept_camera peeks rather than pops (PYNET-014), so
# the record stays in `pending_cameras` during the long verify_stream/add_camera
# await window; this set is the mutual-exclusion guard that stops a concurrent
# reject (or a second accept) from acting on a MAC that is being committed —
# preserving the invariant that a MAC is never both accepted AND rejected.
accepting_macs: set[str] = set()

# --- MQTT ---

mqtt_client: mqtt.Client | None = None


def _parse_mqtt_url(url: str) -> tuple[str, int, str | None, str | None, bool]:
    """Parse mqtt(s)://user:pass@host:port into components.

    WARP-235: a mqtts:// scheme means the broker's mTLS listener — the port
    default flips to 8883 and the caller presents this service's client cert
    (identity = cert CN) instead of a username/password.
    """
    from urllib.parse import urlparse
    parsed = urlparse(url)
    use_tls = parsed.scheme == "mqtts"
    host = parsed.hostname or "localhost"
    port = parsed.port or (8883 if use_tls else 1883)
    user = parsed.username
    password = parsed.password
    return host, port, user, password, use_tls


def _connect_mqtt() -> mqtt.Client:
    host, port, user, password, use_tls = _parse_mqtt_url(MQTT_BROKER)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="droplet-camera-discovery")
    if use_tls:
        # WARP-235: identity is the client cert CN; no username/password.
        from _shared.internal_tls import paho_configure

        paho_configure(client)
    elif user:
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
    **httpx_client_kwargs(),
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
    inference host (RLIMIT_NOFILE=1024 out of the box).
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


# WARP-1805: refresh cadence for CAMERA_SUBNET=auto. Between refreshes the
# last resolved network keeps filtering, so a routing-service blip can't
# blind the scan loop or flap the sweep target every 30 s.
AUTO_SUBNET_TTL_SECONDS = 300.0
_auto_subnet_resolved_at = 0.0


async def resolve_camera_network_auto() -> None:
    """Resolve the camera network from the edge router (CAMERA_SUBNET=auto).

    WARP-1805: a hardcoded CAMERA_SUBNET goes stale every time the fabric
    moves, and a stale value filters out every candidate — the whole
    ONVIF/RTSP pipeline runs healthy but blind. In auto mode the subnet
    filter and sweep follow whatever LAN the edge router actually serves,
    read from the routing service's ``/network/interfaces`` (the same
    router that hands cameras their DHCP leases, so the lease feed and the
    filter can never disagree about which network cameras live on).

    Failure contract: while unresolved, ``_camera_network`` stays ``None`` —
    the candidate filter falls back to all-private (RFC 1918) so lease and
    WS-Discovery candidates still surface, and the brute subnet sweep stays
    off (discovery degrades, never widens). After a first successful
    resolve, a refresh failure keeps the last known network.
    """
    global _camera_network, _auto_subnet_resolved_at
    if not CAMERA_SUBNET_AUTO:
        return
    now = time.time()
    if _camera_network is not None and (now - _auto_subnet_resolved_at) < AUTO_SUBNET_TTL_SECONDS:
        return
    try:
        resp = await routing_client.get("/network/interfaces")
        resp.raise_for_status()
        payload = resp.json()
        lan = (payload or {}).get("lan") or {}
        addrs = lan.get("ipv4-address") or []
        first = addrs[0] if addrs else {}
        address = first.get("address")
        mask = first.get("mask")
        if not address or mask is None:
            raise ValueError("no usable lan ipv4-address in response")
        network = ipaddress.ip_network(f"{address}/{mask}", strict=False)
        if not network.is_private:
            # A poisoned/misconfigured router answer must not widen probing
            # beyond RFC 1918 space: is_safe_ip() already rejects public
            # candidates one by one, refusing here keeps the sweep off too.
            raise ValueError(f"resolved network {network} is not private")
        if network != _camera_network:
            logger.info(
                "CAMERA_SUBNET=auto: camera network resolved from edge router: %s",
                network,
            )
        _camera_network = network
        _auto_subnet_resolved_at = now
    except Exception as exc:
        if _camera_network is None:
            logger.warning(
                "CAMERA_SUBNET=auto: camera network not resolved yet (%s) — "
                "subnet sweep disabled, candidates gated to private IPs only",
                exc,
            )
        else:
            logger.warning(
                "CAMERA_SUBNET=auto: refresh failed (%s) — keeping %s",
                exc,
                _camera_network,
            )


async def scan_and_discover() -> None:
    """Main discovery loop iteration.

    1. Resolve the camera network from the edge router (CAMERA_SUBNET=auto)
    2. Fetch DHCP leases from the routing service
    3. Sweep the camera subnet for RTSP hosts (catches static-IP cameras)
    4. Run any operator-approved first-run init on fresh cameras
    5. Probe each candidate with RTSP and ONVIF
    6. Add confirmed cameras to Frigate
    7. Publish events to MQTT
    """
    await resolve_camera_network_auto()
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
                    # Not a camera (e.g. a TP-Link AP that has 554 open but
                    # doesn't speak RTSP — probe_camera returns None for it).
                    # Drop any prior pending/known entry so a device that was
                    # mis-classified before this confirmation clears without a
                    # restart, instead of lingering in the discovered list.
                    pending_cameras.pop(mac, None)
                    known_cameras.pop(mac, None)
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

        # Only auto-add to Frigate a stream we have VERIFIED actually answers
        # — never a port-open guess. The prober emits an unverified
        # `rtsp://<ip>:554/stream1` placeholder for "ports open, no stream
        # confirmed" (detection_method == "rtsp_port_open"); the old code
        # pushed that straight into Frigate as `status: active` and cached it
        # in `known_cameras`. Two failures resulted: Frigate sat at 0 fps on a
        # dead URL, AND the camera was now "known" so the candidate loop
        # skipped it forever — it never re-probed, so a camera that came good
        # later (finished first-boot, operator set credentials) was never
        # picked up. STAGNANT.
        #
        # Now: verify the stream (real DESCRIBE → 200) before promoting. A
        # camera that doesn't verify stays in `pending_cameras` — surfaced to
        # the wizard as "needs setup", re-probed every scan, and auto-promoted
        # the instant a real stream appears. A genuinely working stream
        # (open, default-credential, or ONVIF-provided) verifies and is added
        # exactly as before.
        detection_method = camera_info.get("detection_method")
        verified = False
        if detection_method == "rtsp_default_credentials":
            # probe_rtsp_with_credentials already confirmed a live 200 DESCRIBE;
            # repeating verify_stream would open an identical TCP connection for
            # no new information. Mark verified directly.
            verified = bool(rtsp_url)
        elif rtsp_url and detection_method != "rtsp_port_open":
            try:
                verified = await verify_stream(rtsp_url)
            except Exception as exc:  # transient network error — retry next scan
                logger.debug("Stream verify raised for %s: %s", ip, exc)
                verified = False

        # Guard the Frigate call: a 5xx / connection-refused / timeout from
        # frigate.add_camera must NOT escape and abort the candidate loop —
        # that would silently skip every remaining candidate this sweep. A
        # failed add is logged and treated like an unverified stream: the
        # camera stays pending + re-probeable and is NEVER cached in
        # known_cameras (so it can't go stagnant on a stream Frigate refused).
        added = False
        if verified:
            try:
                added = await frigate.add_camera(camera_name, rtsp_url)
            except Exception as exc:
                logger.warning(
                    "Frigate add_camera failed for %s at %s: %s — keeping "
                    "pending, will retry next scan",
                    camera_name,
                    ip,
                    exc,
                )
                added = False

        if added:
            camera_info["status"] = "active"
            known_cameras[mac] = camera_info
            pending_cameras.pop(mac, None)
            logger.info(
                "Auto-added camera: %s (%s) at %s",
                camera_name,
                camera_info.get("manufacturer", "unknown"),
                ip,
            )
        else:
            # Unverified / dead-guess / Frigate-add-failed → keep it pending and
            # re-probeable. NEVER cache it in known_cameras, or the candidate
            # loop would skip it and it would go stagnant on a stream that does
            # not work.
            camera_info["status"] = (
                "needs_setup" if rtsp_url else "pending"
            )
            pending_cameras[mac] = camera_info
            known_cameras.pop(mac, None)

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
    # PYNET-014: peek, don't pop — the record stays in pending until the add
    # actually succeeds, so a transient exception from verify_stream/add_camera
    # can't silently drop the camera from the list until the next scan.
    camera = pending_cameras.get(mac)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found in pending list")

    # PYNET-017: claim the MAC *synchronously* (no await between this check and
    # the .add) before entering the long verify_stream/add_camera await window.
    # The peek above leaves the record in `pending_cameras` for the whole window,
    # so without this guard a concurrent reject_camera could pop it and mark it
    # rejected while this coroutine still commits it to Frigate — a "rejected"
    # camera ending up live. reject_camera (and a second accept) check this set
    # and 409 while the accept is in flight. The finally releases the claim on
    # every exit path (success, HTTP error, or unexpected exception).
    if mac in accepting_macs:
        raise HTTPException(status_code=409, detail="Camera accept already in progress")
    accepting_macs.add(mac)
    try:
        rtsp_url = camera.get("rtsp_url")
        if not rtsp_url:
            raise HTTPException(status_code=400, detail="No RTSP URL available for this camera")

        # Verify the stream actually answers before committing it to Frigate, so a
        # manual accept of a port-open guess can't install a permanently-0-fps
        # camera. A camera that doesn't verify needs credentials / a corrected URL
        # first — stays pending so the operator can supply them, rather than
        # silently landing a dead feed.
        if not await verify_stream(rtsp_url):
            raise HTTPException(
                status_code=422,
                detail=(
                    "Camera stream did not verify — the RTSP path or credentials "
                    "are likely wrong. Many cameras (e.g. Hikvision/Dahua) gate "
                    "their real stream behind a vendor-specific path that the "
                    "discovery placeholder can't guess, so a corrected RTSP "
                    "URL/path (or credentials) is needed before it can be added."
                ),
            )

        name = camera.get("name", _sanitize_camera_name(camera.get("hostname", ""), camera["ip"]))
        success = await frigate.add_camera(name, rtsp_url)
        if success:
            pending_cameras.pop(mac, None)  # committed — remove from pending now
            camera["status"] = "active"
            known_cameras[mac] = camera
            publish_discovery({"event": "camera_accepted", "camera": camera})
            return {"status": "accepted", "camera": camera}

        # Still in pending (peeked, not popped) — just surface the failure.
        raise HTTPException(status_code=500, detail="Failed to add camera to Frigate")
    finally:
        accepting_macs.discard(mac)


@app.post("/cameras/discovered/{mac}/reject")
async def reject_camera(mac: str, request: Request):
    """Reject a discovered camera — won't be discovered again.

    Gated by DEVICE_SECRET (NET-05): mutates the rejected-MAC set, a
    privileged write.
    """
    _require_auth(request)
    # PYNET-017: refuse to reject a MAC whose accept is mid-flight. Otherwise the
    # in-flight accept could still commit it to Frigate *after* we mark it
    # rejected, leaving a "rejected" camera live. reject_camera has no awaits, so
    # this check + the pop below run atomically relative to any accept's await
    # points — a MAC can never be both accepted and rejected.
    if mac in accepting_macs:
        raise HTTPException(
            status_code=409,
            detail="Camera accept in progress; cannot reject until it completes.",
        )
    camera = pending_cameras.pop(mac, None)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    if mac not in rejected_macs and len(rejected_macs) >= MAX_REJECTED_MACS:
        # PYNET-015: the cap is full — be honest that the rejection won't
        # persist (the camera would silently reappear next scan) rather than
        # returning "rejected". Keep it in pending so the operator can retry.
        pending_cameras[mac] = camera
        raise HTTPException(
            status_code=507,
            detail="Rejected-camera list is full; cannot persist this rejection. Clear rejected cameras first.",
        )
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
    if CAMERA_SUBNET_AUTO:
        mode = "auto"
    elif _camera_network is not None:
        mode = "static"
    else:
        mode = "all_private"
    return {
        "camera_subnet": CAMERA_SUBNET or "all_private",
        # WARP-1805: "auto" resolves the network from the edge router at scan
        # time; "network" below is the currently-resolved value (null until
        # the first successful resolve).
        "mode": mode,
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
    # PYNET-016: full_driver_report is fully synchronous (subprocess.run with
    # 5s timeouts per module) — run it off the event loop so it can't stall
    # /health and the scan scheduler.
    return await asyncio.to_thread(full_driver_report)


@app.post("/drivers/fix")
async def fix_drivers(request: Request):
    """Attempt to auto-fix camera driver issues. Requires DEVICE_SECRET auth."""
    _require_auth(request)
    report = await auto_fix_drivers()
    status = await asyncio.to_thread(full_driver_report)
    return {"fix_report": report, "current_status": status}
