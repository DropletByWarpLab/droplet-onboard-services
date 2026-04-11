"""Camera auto-discovery service.

Polls DHCP leases from the routing service, probes new devices for
RTSP/ONVIF camera support, and auto-configures discovered cameras in Frigate.
Discovery events are published to MQTT for the orchestrator to relay to clients.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time

import httpx
import paho.mqtt.client as mqtt
from fastapi import FastAPI

from driver_checker import full_driver_report, auto_fix_drivers
from frigate_client import FrigateClient
from onvif_scanner import discover_cameras, probe_onvif_device
from rtsp_prober import probe_camera

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# --- Configuration ---

ROUTING_SERVICE_URL = os.getenv("ROUTING_SERVICE_URL", "http://localhost:8080")
FRIGATE_URL = os.getenv("FRIGATE_URL", "http://localhost:5000")
MQTT_BROKER = os.getenv("MQTT_BROKER", "mqtt://localhost:1883")
SCAN_INTERVAL = int(os.getenv("SCAN_INTERVAL", "30"))

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

routing_client = httpx.AsyncClient(base_url=ROUTING_SERVICE_URL, timeout=10.0)


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


async def scan_and_discover() -> None:
    """Main discovery loop iteration.

    1. Fetch DHCP leases
    2. Filter for potential cameras (by hostname heuristic or new unknown devices)
    3. Probe each candidate with RTSP and ONVIF
    4. Add confirmed cameras to Frigate
    5. Publish events to MQTT
    """
    leases = await fetch_dhcp_leases()

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
        if mac in known_cameras or mac in rejected_macs:
            continue

        candidates[mac] = {
            "ip": ip,
            "mac": mac,
            "hostname": hostname,
            "is_likely_camera": _is_camera_hostname(hostname),
        }

    # Add ONVIF-discovered devices
    for device in onvif_devices:
        ip = device.get("ip", "")
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

        # If we have an RTSP URL, auto-add to Frigate
        if camera_info.get("rtsp_url"):
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


# --- Background task ---

_discovery_task: asyncio.Task | None = None


async def discovery_loop() -> None:
    """Continuous discovery loop running in background."""
    logger.info("Camera discovery loop started (interval: %ds)", SCAN_INTERVAL)

    # Wait for Frigate to be ready
    for _ in range(30):
        if await frigate.health_check():
            break
        logger.info("Waiting for Frigate to be ready...")
        await asyncio.sleep(5)

    while True:
        try:
            await scan_and_discover()
        except Exception as e:
            logger.error("Discovery scan error: %s", e)
        await asyncio.sleep(SCAN_INTERVAL)


# --- FastAPI app ---

app = FastAPI(title="Droplet Camera Discovery", version="0.1.0")


@app.on_event("startup")
async def startup():
    global mqtt_client, _discovery_task
    try:
        mqtt_client = _connect_mqtt()
        logger.info("Connected to MQTT broker")
    except Exception as e:
        logger.warning("MQTT connection failed (will retry): %s", e)

    _discovery_task = asyncio.create_task(discovery_loop())


@app.on_event("shutdown")
async def shutdown():
    if _discovery_task:
        _discovery_task.cancel()
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
async def get_discovered():
    """Return pending (not yet added to Frigate) cameras."""
    return list(pending_cameras.values())


@app.get("/cameras/known")
async def get_known():
    """Return all known (active in Frigate) cameras."""
    return list(known_cameras.values())


@app.post("/cameras/discovered/{mac}/accept")
async def accept_camera(mac: str):
    """Accept a pending camera — add it to Frigate."""
    camera = pending_cameras.pop(mac, None)
    if not camera:
        return {"error": "Camera not found in pending list"}, 404

    rtsp_url = camera.get("rtsp_url")
    if not rtsp_url:
        return {"error": "No RTSP URL available for this camera"}, 400

    name = camera.get("name", _sanitize_camera_name(camera.get("hostname", ""), camera["ip"]))
    success = await frigate.add_camera(name, rtsp_url)
    if success:
        camera["status"] = "active"
        known_cameras[mac] = camera
        publish_discovery({"event": "camera_accepted", "camera": camera})
        return {"status": "accepted", "camera": camera}

    # Put back in pending
    pending_cameras[mac] = camera
    return {"error": "Failed to add camera to Frigate"}, 500


@app.post("/cameras/discovered/{mac}/reject")
async def reject_camera(mac: str):
    """Reject a discovered camera — won't be discovered again."""
    camera = pending_cameras.pop(mac, None)
    if camera:
        rejected_macs.add(mac)
        return {"status": "rejected", "mac": mac}
    return {"error": "Camera not found"}, 404


@app.post("/scan")
async def trigger_scan():
    """Manually trigger a discovery scan."""
    await scan_and_discover()
    return {
        "status": "scan_complete",
        "known": len(known_cameras),
        "pending": len(pending_cameras),
    }


# --- Driver management endpoints ---


@app.get("/drivers")
async def get_driver_status():
    """Get full camera driver status report."""
    return full_driver_report()


@app.post("/drivers/fix")
async def fix_drivers():
    """Attempt to auto-fix camera driver issues."""
    report = await auto_fix_drivers()
    # Re-check status after fix
    status = full_driver_report()
    return {"fix_report": report, "current_status": status}
