"""RTSP port scanner and stream path prober.

Checks common RTSP ports on a given IP address and attempts to find
valid stream paths by issuing RTSP OPTIONS/DESCRIBE requests.
"""

from __future__ import annotations

import asyncio
import logging
import socket

logger = logging.getLogger(__name__)

# Common RTSP ports used by IP cameras
RTSP_PORTS = [554, 8554, 8080]

# Common RTSP stream paths by manufacturer/convention
STREAM_PATHS = [
    "/live",
    "/stream1",
    "/stream",
    "/cam/realmonitor?channel=1&subtype=0",
    "/h264Preview_01_main",
    "/Streaming/Channels/101",
    "/videoMain",
    "/video1",
    "/1",
    "/ch0_0.h264",
    "/live/ch00_1",
    "/onvif1",
    "/MediaInput/h264/stream_1",
]


async def scan_ports(ip: str, ports: list[int] | None = None, timeout: float = 2.0) -> list[int]:
    """Check which RTSP ports are open on the given IP."""
    ports = ports or RTSP_PORTS
    open_ports: list[int] = []

    async def _check(port: int) -> int | None:
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout
            )
            writer.close()
            await writer.wait_closed()
            return port
        except (asyncio.TimeoutError, OSError):
            return None

    results = await asyncio.gather(*[_check(p) for p in ports])
    open_ports = [p for p in results if p is not None]
    return open_ports


async def probe_rtsp_stream(ip: str, port: int = 554, timeout: float = 3.0) -> str | None:
    """Try common RTSP stream paths and return the first valid one.

    Sends an RTSP OPTIONS request to each path. A 200 OK response
    indicates a valid stream endpoint.
    """
    for path in STREAM_PATHS:
        url = f"rtsp://{ip}:{port}{path}"
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout
            )
            # Send RTSP OPTIONS request
            request = (
                f"OPTIONS {url} RTSP/1.0\r\n"
                f"CSeq: 1\r\n"
                f"User-Agent: Droplet-CameraDiscovery/1.0\r\n"
                f"\r\n"
            )
            writer.write(request.encode())
            await writer.drain()

            response = await asyncio.wait_for(reader.read(1024), timeout=timeout)
            response_str = response.decode("utf-8", errors="ignore")

            writer.close()
            await writer.wait_closed()

            if "RTSP/1.0 200" in response_str:
                logger.info("Found valid RTSP stream: %s", url)
                return url

        except (asyncio.TimeoutError, OSError, UnicodeDecodeError):
            continue

    return None


async def probe_camera(ip: str) -> dict | None:
    """Full probe of an IP address for RTSP camera streams.

    Returns camera info dict if a camera is found, None otherwise.
    """
    open_ports = await scan_ports(ip)
    if not open_ports:
        return None

    for port in open_ports:
        stream_url = await probe_rtsp_stream(ip, port)
        if stream_url:
            return {
                "ip": ip,
                "port": port,
                "rtsp_url": stream_url,
                "detection_method": "rtsp_probe",
            }

    # Ports are open but no valid stream found — still likely a camera
    return {
        "ip": ip,
        "port": open_ports[0],
        "rtsp_url": f"rtsp://{ip}:{open_ports[0]}/stream1",
        "detection_method": "rtsp_port_open",
    }
