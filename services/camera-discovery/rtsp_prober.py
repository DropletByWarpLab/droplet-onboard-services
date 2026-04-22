"""RTSP port scanner and stream path prober.

Checks common RTSP ports on a given IP address and attempts to find
valid stream paths by issuing RTSP OPTIONS/DESCRIBE requests. When an
unauthenticated DESCRIBE is refused (401), the prober iterates the
default-credential list in ``default_credentials.py`` and retries with
Basic / Digest auth before giving up.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import socket
from urllib.parse import quote

from default_credentials import DEFAULT_CAMERA_CREDENTIALS

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


def _parse_www_authenticate(header_value: str) -> dict:
    """Parse a WWW-Authenticate response header into a key/value dict.

    Handles both ``Basic realm="..."`` and ``Digest realm="..." nonce="..."
    qop="auth" ...``. The ``scheme`` key holds the lowercased auth scheme.
    """
    result = {"scheme": ""}
    if not header_value:
        return result
    scheme, _, rest = header_value.partition(" ")
    result["scheme"] = scheme.strip().lower()
    # Split on commas but tolerate commas inside quoted values. Cameras
    # almost never use nested quotes, so a simple split-then-strip is fine.
    for part in rest.split(","):
        if "=" in part:
            k, _, v = part.strip().partition("=")
            result[k.strip().lower()] = v.strip().strip('"')
    return result


def _digest_header(user: str, pw: str, method: str, uri: str,
                   auth_info: dict) -> str:
    """Build an RFC 2069 Digest Authorization header value.

    We implement the legacy (qop-less) form because every camera we test
    against accepts it; full RFC 2617 with cnonce+nc is unnecessary.
    """
    realm = auth_info.get("realm", "")
    nonce = auth_info.get("nonce", "")
    ha1 = hashlib.md5(f"{user}:{realm}:{pw}".encode()).hexdigest()
    ha2 = hashlib.md5(f"{method}:{uri}".encode()).hexdigest()
    response = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
    return (f'Digest username="{user}", realm="{realm}", nonce="{nonce}", '
            f'uri="{uri}", response="{response}"')


async def _rtsp_describe(reader, writer, url: str, cseq: int,
                         auth_header: str | None, timeout: float) -> str:
    """Send a single DESCRIBE on an open RTSP connection and return the
    raw response text. Used by the credential-probe loop so we can keep
    a single TCP connection open across the 401 -> retry handshake."""
    req = (
        f"DESCRIBE {url} RTSP/1.0\r\n"
        f"CSeq: {cseq}\r\n"
        f"User-Agent: Droplet-CameraDiscovery/1.0\r\n"
        f"Accept: application/sdp\r\n"
    )
    if auth_header:
        req += f"Authorization: {auth_header}\r\n"
    req += "\r\n"
    writer.write(req.encode())
    await writer.drain()
    raw = await asyncio.wait_for(reader.read(4096), timeout=timeout)
    return raw.decode("utf-8", errors="ignore")


async def _try_credentials_once(ip: str, port: int, path: str,
                                user: str, pw: str,
                                timeout: float = 3.0) -> bool:
    """Open one RTSP connection, send DESCRIBE, retry with auth on 401.

    Returns True iff the authenticated DESCRIBE returned 200 (i.e. the
    credentials are valid for this camera + path).
    """
    url = f"rtsp://{ip}:{port}{path}"
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=timeout
        )
        try:
            # Step 1: unauthenticated DESCRIBE — expect 401 to learn the
            # auth scheme, or 200 on a totally open camera.
            resp1 = await _rtsp_describe(reader, writer, url, 1, None, timeout)
            if "RTSP/1.0 200" in resp1:
                return True
            if "RTSP/1.0 401" not in resp1:
                return False  # 404 / 501 / etc — path doesn't exist here

            # Parse the challenge
            auth_line = ""
            for ln in resp1.split("\r\n"):
                if ln.lower().startswith("www-authenticate:"):
                    auth_line = ln.split(":", 1)[1].strip()
                    break
            auth_info = _parse_www_authenticate(auth_line)

            # Step 2: rebuild request with credentials
            if auth_info["scheme"] == "basic":
                token = base64.b64encode(f"{user}:{pw}".encode()).decode()
                auth_header = f"Basic {token}"
            elif auth_info["scheme"] == "digest":
                auth_header = _digest_header(user, pw, "DESCRIBE", url,
                                             auth_info)
            else:
                return False  # unknown scheme — skip

            resp2 = await _rtsp_describe(reader, writer, url, 2, auth_header,
                                         timeout)
            return "RTSP/1.0 200" in resp2
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
    except (asyncio.TimeoutError, OSError, UnicodeDecodeError, ValueError):
        return False


async def probe_rtsp_with_credentials(ip: str, port: int
                                      ) -> tuple[str, str, str] | None:
    """Find a (path, user, password) triple that authenticates on this
    camera. Iterates STREAM_PATHS × DEFAULT_CAMERA_CREDENTIALS in order;
    returns the first match or None.

    Early-exits: once a credential pair works on one path, we assume it
    works across paths for that camera and stop trying other pairs on the
    same host.
    """
    for user, pw in DEFAULT_CAMERA_CREDENTIALS:
        for path in STREAM_PATHS:
            if await _try_credentials_once(ip, port, path, user, pw):
                logger.info(
                    "Default credential '%s' authenticated at %s:%d%s",
                    user, ip, port, path,
                )
                return path, user, pw
    return None


async def probe_camera(ip: str) -> dict | None:
    """Full probe of an IP address for RTSP camera streams.

    Returns camera info dict if a camera is found, None otherwise.
    """
    open_ports = await scan_ports(ip)
    if not open_ports:
        return None

    for port in open_ports:
        # 1) Unauthenticated OPTIONS — handles open/debug cameras
        stream_url = await probe_rtsp_stream(ip, port)
        if stream_url:
            return {
                "ip": ip,
                "port": port,
                "rtsp_url": stream_url,
                "detection_method": "rtsp_probe",
            }

        # 2) Try well-known factory-default credentials. Hanwha, Amcrest,
        # Reolink, Axis, etc. reject unauth OPTIONS but accept DESCRIBE
        # with a valid default password on a fresh-from-box unit.
        creds = await probe_rtsp_with_credentials(ip, port)
        if creds:
            path, user, pw = creds
            url = (f"rtsp://{quote(user, safe='')}:{quote(pw, safe='')}"
                   f"@{ip}:{port}{path}")
            return {
                "ip": ip,
                "port": port,
                "rtsp_url": url,
                "username": user,
                "detection_method": "rtsp_default_credentials",
            }

    # Ports are open but no valid stream found — still likely a camera.
    # Return a placeholder so the UI can surface it as "needs credentials".
    return {
        "ip": ip,
        "port": open_ports[0],
        "rtsp_url": f"rtsp://{ip}:{open_ports[0]}/stream1",
        "detection_method": "rtsp_port_open",
    }
