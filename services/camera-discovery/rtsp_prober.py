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
import secrets
import socket
from urllib.parse import quote, unquote, urlsplit

from default_credentials import get_credentials

logger = logging.getLogger(__name__)

# Common RTSP ports used by IP cameras
RTSP_PORTS = [554, 8554, 8080]

# Common RTSP stream paths by manufacturer/convention.
# Paths are ordered by observed hit rate; Hanwha Wisenet lives near the
# top because those rigs reject OPTIONS without auth, which makes the
# per-path cost for a wrong guess higher than a fast 404 on e.g. /live.
STREAM_PATHS = [
    "/profile2/media.smp",      # Hanwha Wisenet (X/P/Q/L series) substream
    "/profile1/media.smp",      # Hanwha Wisenet mainstream
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


async def is_rtsp_server(ip: str, port: int = 554, timeout: float = 3.0) -> bool:
    """Return True iff ``ip:port`` actually speaks RTSP at the protocol level.

    A port being open is NOT enough to call something a camera — plenty of
    non-camera devices listen on 554 (TP-Link APs/routers, DLNA/UPnP media
    boxes, debug services). They answer an RTSP ``OPTIONS`` with an HTTP
    response, a malformed ``RTSP/1.0 400 Bad Request`` (no method support, and
    typically ``CSeq: 0`` — our CSeq not echoed), or a connection reset.

    A genuine RTSP server — even one that's auth-gated or exposes no stream on
    the paths we guess — answers ``OPTIONS`` with a well-formed RTSP status:
    ``200 OK`` (usually with a ``Public:`` method list), or ``401/403`` when it
    demands credentials. We accept exactly those and reject everything else, so
    a port-open-only guess is never emitted for a device that isn't a camera.
    """
    try:
        reader, writer = await _open_rtsp(ip, port, timeout)
    except (asyncio.TimeoutError, OSError):
        return False
    try:
        request = (
            f"OPTIONS rtsp://{ip}:{port}/ RTSP/1.0\r\n"
            f"CSeq: 1\r\n"
            f"User-Agent: Droplet-CameraDiscovery/1.0\r\n"
            f"\r\n"
        )
        writer.write(request.encode())
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(1024), timeout=timeout)
    except (asyncio.TimeoutError, OSError, UnicodeDecodeError, ValueError):
        return False
    finally:
        _close_rtsp(writer)

    resp = raw.decode("utf-8", errors="ignore")
    status_line = resp.split("\r\n", 1)[0]
    # Must be an RTSP status line (reject HTTP responders on 554) with a code
    # that proves a working RTSP control channel. 400/5xx ⇒ not a camera.
    # 404 is accepted: some Hikvision/Dahua firmware returns 404 on a root
    # OPTIONS because they only process path-specific requests, but are real
    # RTSP servers — silently dropping them would hide valid cameras.
    if not status_line.startswith(("RTSP/1.0", "RTSP/2.0")):
        return False
    parts = status_line.split(" ", 2)
    if len(parts) < 2 or not parts[1].isdigit():
        return False
    return int(parts[1]) in (200, 401, 403, 404)


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
    """Build a Digest Authorization header value.

    WARP-1812: cameras that advertise ``qop`` (e.g. Hanwha Wisenet:
    ``Digest realm="iPOLiS", qop="auth"``) REJECT the legacy qop-less
    RFC 2069 form and require the full RFC 2617 computation with a client
    nonce (cnonce) and nonce-count (nc):
    ``response = MD5(HA1:nonce:nc:cnonce:qop:HA2)``. We emit that form when
    the challenge carries ``qop=auth`` and fall back to the RFC 2069 form
    (``response = MD5(HA1:nonce:HA2)``) when it does not, so the cameras
    that were already working keep working.
    """
    realm = auth_info.get("realm", "")
    nonce = auth_info.get("nonce", "")
    qop_values = [q.strip().lower() for q in auth_info.get("qop", "").split(",") if q.strip()]
    # RFC 2617 Digest auth mandates MD5 (legacy form). The MD5 call sites
    # below — HA1, HA2, response — are the protocol's required digest
    # nesting; every RTSP camera firmware we support accepts only the MD5
    # form on the RTSP control port. See docs/security/fips-exceptions.md →
    # rtsp-digest-rfc2617 for the full risk acceptance + annual-review owner.
    # fips:allowed: rtsp-digest-rfc2617
    ha1 = hashlib.md5(f"{user}:{realm}:{pw}".encode()).hexdigest()
    # fips:allowed: rtsp-digest-rfc2617
    ha2 = hashlib.md5(f"{method}:{uri}".encode()).hexdigest()

    if "auth" in qop_values:
        cnonce = secrets.token_hex(8)
        nc = "00000001"
        # fips:allowed: rtsp-digest-rfc2617
        response = hashlib.md5(
            f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}".encode()
        ).hexdigest()
        return (f'Digest username="{user}", realm="{realm}", nonce="{nonce}", '
                f'uri="{uri}", algorithm=MD5, qop=auth, nc={nc}, '
                f'cnonce="{cnonce}", response="{response}"')

    # RFC 2069 (qop-less) fallback.
    # fips:allowed: rtsp-digest-rfc2617
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


async def _open_rtsp(ip: str, port: int, timeout: float):
    return await asyncio.wait_for(
        asyncio.open_connection(ip, port), timeout=timeout,
    )


def _close_rtsp(writer) -> None:
    try:
        writer.close()
    except Exception:
        return
    # wait_closed is awaitable; callers that already hold the connection
    # handle it themselves. This helper is only used from sync-teardown
    # paths where swallowing is fine.


def _is_rtsp_200(resp: str) -> bool:
    return "RTSP/1.0 200" in resp or "RTSP/2.0 200" in resp


async def _try_credentials_once(ip: str, port: int, path: str,
                                user: str, pw: str,
                                timeout: float = 3.0) -> bool:
    """Open RTSP, send DESCRIBE, retry with auth on 401.

    WARP-1812: the authenticated retry runs on the SAME connection as the
    challenge. This Hanwha Wisenet firmware binds the digest nonce to the
    TCP connection — a fresh-socket retry (with a new *or* the old nonce)
    401s, while reusing the challenge socket lands 200 (proven live on
    XNV-C8083R). If the socket dies between the 401 and the retry (older
    Wisenet firmwares that hard-close after a 401), we fall back to a fresh
    connection reusing the same challenge, which is what the previous
    always-new-connection code was compensating for.
    """
    url = f"rtsp://{ip}:{port}{path}"
    try:
        reader, writer = await _open_rtsp(ip, port, timeout)
    except (asyncio.TimeoutError, OSError):
        return False

    try:
        resp1 = await _rtsp_describe(reader, writer, url, 1, None, timeout)
    except (asyncio.TimeoutError, OSError, UnicodeDecodeError, ValueError):
        _close_rtsp(writer)
        return False

    if _is_rtsp_200(resp1):
        _close_rtsp(writer)
        return True
    if "RTSP/1.0 401" not in resp1 and "RTSP/2.0 401" not in resp1:
        _close_rtsp(writer)
        return False  # 404 / 501 / etc — path doesn't exist here

    auth_line = ""
    for ln in resp1.split("\r\n"):
        if ln.lower().startswith("www-authenticate:"):
            auth_line = ln.split(":", 1)[1].strip()
            break
    auth_info = _parse_www_authenticate(auth_line)

    if auth_info["scheme"] == "basic":
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        auth_header = f"Basic {token}"
    elif auth_info["scheme"] == "digest":
        auth_header = _digest_header(user, pw, "DESCRIBE", url, auth_info)
    else:
        _close_rtsp(writer)
        return False

    # Retry on the SAME connection (CSeq 2) — connection-bound-nonce firmwares
    # require it. A well-formed RTSP reply here is authoritative: 200 →
    # success, 401 → wrong credentials, stop either way. An empty read or a
    # raise means the socket died between the 401 and the retry (hard-close-
    # after-401 firmwares) → fall back to a fresh connection reusing the same
    # challenge/header (a hard-closed socket EOFs rather than raising, so we
    # must check for that explicitly, not just catch exceptions).
    try:
        resp2 = await _rtsp_describe(reader, writer, url, 2, auth_header, timeout)
    except (asyncio.TimeoutError, OSError, UnicodeDecodeError, ValueError):
        resp2 = ""
    _close_rtsp(writer)
    if resp2.startswith(("RTSP/1.0", "RTSP/2.0")):
        return _is_rtsp_200(resp2)

    try:
        reader2, writer2 = await _open_rtsp(ip, port, timeout)
    except (asyncio.TimeoutError, OSError):
        return False
    try:
        resp2 = await _rtsp_describe(reader2, writer2, url, 1, auth_header, timeout)
    except (asyncio.TimeoutError, OSError, UnicodeDecodeError, ValueError):
        return False
    finally:
        _close_rtsp(writer2)

    return _is_rtsp_200(resp2)


async def probe_rtsp_with_credentials(ip: str, port: int
                                      ) -> tuple[str, str, str] | None:
    """Find a (path, user, password) triple that authenticates on this
    camera. Returns the first match or None.

    Loop order is paths OUTER, credentials INNER so a path the camera
    doesn't expose short-circuits the whole credential list for that
    path via _try_credentials_once() returning False on a non-401
    non-200 status (typically 404). For a camera that accepts the third
    credential on path /live that's ~13 DESCRIBEs instead of ~195.
    """
    credentials = get_credentials()
    for path in STREAM_PATHS:
        for user, pw in credentials:
            if await _try_credentials_once(ip, port, path, user, pw):
                logger.info(
                    "Credential '%s' authenticated at %s:%d%s",
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

    # Ports are open but no stream cracked. Before surfacing this as a camera,
    # confirm at least one open port actually speaks RTSP — a bare open 554 is
    # also how TP-Link APs/routers, DLNA boxes and other non-cameras look. A
    # device that doesn't answer a clean RTSP OPTIONS (e.g. the TP-Link AP that
    # returns `RTSP/1.0 400 Bad Request`) is NOT a camera and must never enter
    # the discovered list.
    rtsp_port = None
    for port in open_ports:
        if await is_rtsp_server(ip, port):
            rtsp_port = port
            break
    if rtsp_port is None:
        return None

    # Confirmed RTSP server, but no path/credential matched — surface it as a
    # "needs credentials" placeholder. detection_method == "rtsp_port_open"
    # marks this URL as a GUESS, never a verified stream: callers must NOT
    # auto-add it to Frigate (see verify_stream + the scan loop's
    # stream-verified gate in main.py).
    return {
        "ip": ip,
        "port": rtsp_port,
        "rtsp_url": f"rtsp://{ip}:{rtsp_port}/stream1",
        "detection_method": "rtsp_port_open",
    }


async def verify_stream(rtsp_url: str, timeout: float = 4.0) -> bool:
    """Return True iff ``rtsp_url`` actually answers a DESCRIBE with 200.

    The discovery probe can emit a placeholder URL (port-open-only guess) that
    no camera will ever serve — adding it to Frigate yields a permanently
    0-fps "camera". This is the gate that stops that: a real RTSP DESCRIBE
    (using any ``user:pass@`` embedded in the URL, with the same 401→auth
    retry the credential prober uses) must return 200 before a camera is
    promoted to active. A 400/401/404/timeout → False, so the camera stays
    pending and the next scan re-probes it — it never goes stagnant on a dead
    guess, and auto-promotes the moment a real stream becomes reachable
    (camera finished its first-boot, operator set its credentials, etc.).
    """
    parts = urlsplit(rtsp_url)
    # Accept both plaintext RTSP and TLS RTSP (rtsps://) schemes — is_safe_rtsp_url
    # in main.py admits both, so an ONVIF camera that advertises an rtsps:// URL
    # must not be hard-rejected here. Doing so leaves it stuck in needs_setup
    # forever and makes accept_camera 422 every time. NOTE: the prober itself
    # only speaks plaintext RTSP (_open_rtsp uses a bare asyncio.open_connection
    # with no TLS context); a TLS-only camera's DESCRIBE will simply not verify
    # and the camera stays pending + re-probeable rather than being rejected
    # outright. Native rtsps:// TLS handshaking is deferred to its own ticket.
    if parts.scheme not in ("rtsp", "rtsps") or not parts.hostname:
        return False
    host = parts.hostname
    # rtsps:// defaults to 322 (secure RTSP), plaintext rtsp:// to 554.
    default_port = 322 if parts.scheme == "rtsps" else 554
    port = parts.port or default_port
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    user = unquote(parts.username) if parts.username else ""
    pw = unquote(parts.password) if parts.password else ""
    # _try_credentials_once handles the no-auth (200 on first DESCRIBE) AND the
    # 401→Basic/Digest retry paths, returning True only on a 200. Reused so the
    # verify path and the credential-probe path can never diverge.
    return await _try_credentials_once(host, port, path, user, pw, timeout)
