"""ONVIF camera discovery and device probing.

Uses WS-Discovery multicast to find ONVIF-compatible cameras on the LAN,
then queries device information and stream URIs via ONVIF SOAP calls.

WS-Discovery is OPTIONAL. The ``python-ws-discovery`` package we depend on
has long-running issues on Python 3.12+ (netifaces interface-name
ValueError, ``str.getNamespace`` attribute error inside its thread pool)
that leak file descriptors every time the scan runs — after ~1k tries the
process hits ``EMFILE`` and any HTTP endpoint on the service starts
returning "Connection reset by peer". To avoid poisoning the whole
service, WS-Discovery runs behind a disable flag and with strict per-call
resource limits; cameras that aren't found this way still get picked up
by the RTSP subnet sweep in :mod:`rtsp_prober`.
"""

from __future__ import annotations

import asyncio
import logging
import os
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Opt-in flag. Default off on Linux/arm64 deployments where the netifaces
# ValueError reproduces deterministically; set to 1 to re-enable after
# pinning a patched wsdiscovery release.
_WS_DISCOVERY_ENABLED = os.getenv("ONVIF_WS_DISCOVERY_ENABLED", "0").strip() not in (
    "",
    "0",
    "false",
    "no",
)


async def ws_discovery_scan(timeout: float = 5.0) -> list[dict]:
    """Run WS-Discovery multicast scan for ONVIF devices.

    Returns a list of discovered device dicts with xaddrs (service URLs).
    Returns an empty list (without raising) when the feature is disabled
    or the underlying library throws — the RTSP subnet sweep is the
    authoritative discovery path, and a broken multicast scan shouldn't
    take the /scan endpoint down with it.
    """
    if not _WS_DISCOVERY_ENABLED:
        return []

    devices: list[dict] = []

    try:
        from wsdiscovery import WSDiscovery

        wsd = WSDiscovery()
        wsd.start()
        try:
            # Search for ONVIF network video transmitter devices
            services = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: wsd.searchServices(
                    timeout=int(timeout),
                    scopes=[],
                    types=[
                        "dn:NetworkVideoTransmitter",
                        "tds:Device",
                    ],
                ),
            )

            for service in services:
                xaddrs = service.getXAddrs()
                scopes = [str(s) for s in service.getScopes()]

                # Extract IP from xaddr
                for xaddr in xaddrs:
                    parsed = urlparse(xaddr)
                    ip = parsed.hostname
                    if ip:
                        devices.append({
                            "ip": ip,
                            "xaddr": xaddr,
                            "scopes": scopes,
                            "detection_method": "ws_discovery",
                        })
        finally:
            try:
                wsd.stop()
            except Exception as stop_exc:
                logger.warning("wsdiscovery stop() raised: %s", stop_exc)
    except ImportError:
        logger.warning("wsdiscovery not available — skipping WS-Discovery scan")
    except Exception as e:
        # BaseException-subclass-except on purpose: the wsdiscovery thread
        # model throws AttributeError from worker threads and ValueError
        # from netifaces. Neither should blow up the HTTP handler.
        logger.error("WS-Discovery scan failed: %s", e)

    return devices


async def probe_onvif_device(ip: str, port: int = 80) -> dict | None:
    """Probe an IP for ONVIF device information.

    Attempts to connect to the ONVIF device service and retrieve
    device info and media stream URIs.
    """
    try:
        from onvif import ONVIFCamera

        cam = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: ONVIFCamera(ip, port, "admin", ""),
        )

        # Get device information
        device_info = await asyncio.get_event_loop().run_in_executor(
            None, cam.devicemgmt.GetDeviceInformation
        )

        info = {
            "ip": ip,
            "port": port,
            "manufacturer": getattr(device_info, "Manufacturer", "Unknown"),
            "model": getattr(device_info, "Model", "Unknown"),
            "firmware": getattr(device_info, "FirmwareVersion", ""),
            "serial": getattr(device_info, "SerialNumber", ""),
            "detection_method": "onvif",
        }

        # Try to get media stream URI
        try:
            media_service = await asyncio.get_event_loop().run_in_executor(
                None, cam.create_media_service
            )
            profiles = await asyncio.get_event_loop().run_in_executor(
                None, media_service.GetProfiles
            )

            if profiles:
                stream_setup = {
                    "Stream": "RTP-Unicast",
                    "Transport": {"Protocol": "RTSP"},
                }
                uri_response = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: media_service.GetStreamUri(
                        {"StreamSetup": stream_setup, "ProfileToken": profiles[0].token}
                    ),
                )
                info["rtsp_url"] = uri_response.Uri
                info["profile_token"] = profiles[0].token
        except Exception as e:
            logger.debug("Could not get stream URI from %s: %s", ip, e)

        return info

    except ImportError:
        logger.warning("onvif-zeep not available — skipping ONVIF probe for %s", ip)
        return None
    except Exception as e:
        logger.debug("ONVIF probe failed for %s:%d — %s", ip, port, e)
        return None


async def discover_cameras() -> list[dict]:
    """Run full ONVIF discovery: WS-Discovery + probe each found device.

    Returns enriched device info dicts for all discovered cameras.
    """
    discovered = await ws_discovery_scan()
    cameras: list[dict] = []

    for device in discovered:
        ip = device["ip"]
        # Try ONVIF probe to get device details
        info = await probe_onvif_device(ip)
        if info:
            # Merge WS-Discovery info with ONVIF probe results
            info["scopes"] = device.get("scopes", [])
            cameras.append(info)
        else:
            # Keep basic WS-Discovery info
            cameras.append(device)

    return cameras
