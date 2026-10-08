"""WARP-3906 — static trees and bounded, loopback-only app HTTP transport.

Identity, grants and app sessions belong to the orchestrator (HA-3). This
module receives only its allowlisted headers, never a browser credential.
It does not follow redirects or choose a destination from user input.
"""
from __future__ import annotations

import hashlib
import http.client
import mimetypes
import re
import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote, unquote, urlsplit

from gitstore import StoreError

MAX_REQUEST_BYTES = 32 * 1024 * 1024
MAX_TIMEOUT_S = 60.0
HEALTH_PATH = re.compile(r"^(?!.*\.\.)/[A-Za-z0-9._~/-]*$")
DIR_PATH = re.compile(r"^(?!.*\.\.)(\.|[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*)$")
HASHED_ASSET = re.compile(r"(?:^|[.-])[a-fA-F0-9]{8,}(?=[.-])")
REQUEST_HEADERS = frozenset({
    "accept", "accept-language", "content-type", "if-none-match",
    "last-event-id", "x-droplet-user-id", "x-droplet-user-name",
    "x-droplet-role", "x-droplet-app",
})
RESPONSE_HEADERS = frozenset({
    "content-type", "content-length", "content-encoding", "cache-control",
    "etag", "last-modified", "location", "retry-after", "vary",
    "content-disposition",
})
METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})


def validate_http(value: Any, runtime: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {"health", "dir", "spa"}:
        raise StoreError(400, "app http must contain health, and optional static dir/spa only")
    health = value.get("health")
    if not isinstance(health, str) or len(health) > 256 or not HEALTH_PATH.fullmatch(health):
        raise StoreError(400, "http.health must be a confined absolute URL path")
    if runtime == "static":
        directory = value.get("dir")
        if not isinstance(directory, str) or len(directory) > 256 or not DIR_PATH.fullmatch(directory):
            raise StoreError(400, "a static app requires a confined http.dir")
        if "spa" in value and not isinstance(value["spa"], bool):
            raise StoreError(400, "http.spa must be boolean")
    elif "dir" in value or "spa" in value:
        raise StoreError(400, "http.dir and http.spa are static-only")
    return dict(value)


def request_target(path: str, query: str = "") -> str:
    if len(path) > 8192 or len(query) > 8192:
        raise StoreError(414, "app request target is too long")
    if any(ord(c) < 32 or ord(c) == 127 for c in path + query):
        raise StoreError(400, "app request target contains a control character")
    target = "/" + path.lstrip("/")
    if "?" in target or "#" in target or "\\" in target:
        raise StoreError(400, "app path must be a URL path")
    # FastAPI's path is already URL-decoded; HTTPConnection needs ASCII.
    # Keep valid escapes intact, and preserve the separately supplied query.
    return quote(target, safe="/%:@!$&'()*+,;=-._~") + ("?" + quote(query, safe="%:@!$&'()*+,;=/?-._~") if query else "")


class RelayResponse:
    """Owns a streaming body until the ASGI response finishes or disconnects."""
    def __init__(self, status: int, headers: dict[str, str], body: BinaryIO | None = None,
                 *, connection: http.client.HTTPConnection | None = None, deadline: float | None = None,
                 timer: threading.Timer | None = None, expired: threading.Event | None = None):
        self.status = status
        self.headers = {**headers, "x-droplet-relay": "app", "x-content-type-options": "nosniff"}
        self.body = body
        self.connection = connection
        self.deadline = deadline
        self.timer = timer
        self.expired = expired

    def chunks(self) -> Iterator[bytes]:
        if self.body is None:
            return
        try:
            while True:
                if self.deadline is not None:
                    remaining = self.deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("app HTTP response deadline exceeded")
                    if self.connection and self.connection.sock:
                        self.connection.sock.settimeout(remaining)
                    elif isinstance(self.body, http.client.HTTPResponse):
                        # HTTP/1.0 closes the connection object while its
                        # response still owns the socket.
                        raw = getattr(getattr(self.body, "fp", None), "raw", None)
                        sock = getattr(raw, "_sock", None)
                        if sock is not None:
                            sock.settimeout(remaining)
                # read1 returns available SSE bytes rather than waiting for 64KiB.
                reader = getattr(self.body, "read1", self.body.read)
                try:
                    data = reader(65_536)
                except (OSError, http.client.HTTPException) as exc:
                    if ((self.expired is not None and self.expired.is_set())
                            or (self.deadline is not None and time.monotonic() >= self.deadline)):
                        raise TimeoutError("app HTTP response deadline exceeded") from exc
                    raise
                if self.expired is not None and self.expired.is_set():
                    raise TimeoutError("app HTTP response deadline exceeded")
                if not data:
                    break
                yield data
        finally:
            self.close()

    def close(self) -> None:
        body, connection, timer = self.body, self.connection, self.timer
        self.body = self.connection = self.timer = None
        sock = connection.sock if connection is not None else None
        if sock is None and isinstance(body, http.client.HTTPResponse):
            raw = getattr(getattr(body, "fp", None), "raw", None)
            sock = getattr(raw, "_sock", None)
        # A disconnected ASGI client may close while another thread is
        # blocked in HTTPResponse.read1. Interrupt that read before taking
        # its buffered-reader lock or cancelling the absolute deadline.
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if timer is not None:
            timer.cancel()
        try:
            if body is not None:
                body.close()
        finally:
            if connection is not None:
                connection.close()


def static_root(directory: Path, http: dict[str, Any]) -> Path:
    root = directory.resolve()
    target = (root / http["dir"]).resolve()
    if not target.is_relative_to(root) or not target.is_dir():
        raise StoreError(422, "http.dir must be a directory inside the installed app")
    return target


def static_response(directory: Path, http: dict[str, Any], path: str,
                    method: str = "GET", headers: dict[str, str] | None = None) -> RelayResponse:
    if method not in {"GET", "HEAD"}:
        return RelayResponse(405, {"allow": "GET, HEAD"})
    root = static_root(directory, http)
    decoded = unquote(urlsplit(request_target(path)).path)
    parts = decoded.lstrip("/").split("/")
    if "\\" in decoded or "\x00" in decoded or any(p in {".", ".."} or p.startswith(".") for p in parts):
        raise StoreError(400, "static path must stay inside the public tree")
    target = root.joinpath(*parts).resolve()
    if not target.is_relative_to(root):
        raise StoreError(400, "static path must stay inside the public tree")
    if target.is_dir():
        target = (target / "index.html").resolve()
    if not target.is_file() and http.get("spa", False) and not Path(decoded).suffix:
        target = (root / "index.html").resolve()
    if not target.is_relative_to(root):
        raise StoreError(400, "static path must stay inside the public tree")
    # A public root of '.' may include project inputs, never serve them.
    if target.name in {"extension-manifest.json", "package.json", "package-lock.json", "pyproject.toml"}:
        return RelayResponse(404, {})
    if not target.is_file():
        return RelayResponse(404, {})
    stat = target.stat()
    etag = '"' + hashlib.sha256(f"{stat.st_mtime_ns}:{stat.st_size}".encode()).hexdigest() + '"'
    cache = "no-store" if target.suffix.lower() == ".html" else (
        "public, max-age=31536000, immutable" if HASHED_ASSET.search(target.name) else "public, max-age=3600")
    out = {"content-type": mimetypes.guess_type(str(target))[0] or "application/octet-stream",
           "content-length": str(stat.st_size), "etag": etag,
           "cache-control": cache}
    if (headers or {}).get("if-none-match") == etag:
        out.pop("content-length")
        return RelayResponse(304, out)
    return RelayResponse(200, out, None if method == "HEAD" else target.open("rb"))


def proxy_response(port: int, method: str, path: str, query: str, headers: dict[str, str],
                   body: BinaryIO, body_bytes: int, timeout_s: float = MAX_TIMEOUT_S) -> RelayResponse:
    if method not in METHODS:
        raise StoreError(405, "app HTTP method is not supported")
    if body_bytes > MAX_REQUEST_BYTES:
        raise StoreError(413, "app request body exceeds 32 MiB")
    target = request_target(path, query)
    timeout_s = max(0.01, min(timeout_s, MAX_TIMEOUT_S))
    deadline = time.monotonic() + timeout_s
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout_s)
    allowed = {k.lower(): v for k, v in headers.items() if k.lower() in REQUEST_HEADERS}
    allowed["content-length"] = str(body_bytes)
    expired = threading.Event()
    timer = None
    try:
        conn.connect()
        sock = conn.sock

        def abort_request():
            expired.set()
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        # A socket inactivity timeout alone permits drip-fed headers/chunks
        # to hold this thread forever. Shutdown interrupts an in-flight read
        # even when HTTPResponse has taken the socket from the connection.
        timer = threading.Timer(max(0.001, deadline - time.monotonic()), abort_request)
        timer.daemon = True
        timer.start()
        conn.request(method, target, body=body, headers=allowed)
        if conn.sock:
            conn.sock.settimeout(max(0.01, deadline - time.monotonic()))
        response = conn.getresponse()
        if expired.is_set():
            response.close()
            raise TimeoutError("app HTTP request deadline exceeded")
        out = {k.lower(): v for k, v in response.getheaders() if k.lower() in RESPONSE_HEADERS}
        # Cookies, auth challenges, upgrade and CORS headers never cross this boundary.
        return RelayResponse(response.status, out, response, connection=conn, deadline=deadline,
                             timer=timer, expired=expired)
    except TimeoutError as exc:
        if timer:
            timer.cancel()
        conn.close()
        raise StoreError(504, "app HTTP request timed out") from exc
    except (OSError, http.client.HTTPException) as exc:
        if timer:
            timer.cancel()
        conn.close()
        if expired.is_set():
            raise StoreError(504, "app HTTP request timed out") from exc
        raise StoreError(502, "app HTTP server is not answering") from exc


PROC_TCP_TABLES = (("/proc/net/tcp", "0100007F"),
                   ("/proc/net/tcp6", "00000000000000000000000001000000"))


def assert_loopback_listener(port: int) -> bool:
    """Verify the actual Linux listener; a loopback GET also reaches 0.0.0.0.

    Windows development checks return False because this production check
    requires Linux procfs. Production fails closed when inspection is absent.
    """
    import sys

    if not sys.platform.startswith("linux"):
        return False
    found = False
    inspected = False
    for filename, loopback in PROC_TCP_TABLES:
        try:
            lines = Path(filename).read_text(encoding="ascii").splitlines()[1:]
            inspected = True
        except FileNotFoundError:
            continue  # IPv6 may be disabled in the container
        except OSError as exc:
            raise StoreError(503, "the app's listening address could not be inspected") from exc
        for line in lines:
            fields = line.split()
            try:
                address, port_hex = fields[1].split(":")
                if fields[3] != "0A" or int(port_hex, 16) != port:
                    continue
            except (IndexError, ValueError) as exc:
                raise StoreError(503, "the kernel's listening socket table is unreadable") from exc
            found = True
            if address != loopback:
                raise StoreError(400, "app must listen on 127.0.0.1:$PORT, not a wildcard or LAN address")
    if not inspected:
        raise StoreError(503, "the app's listening address could not be inspected")
    if not found:
        raise StoreError(400, "app has no listener on its assigned loopback port")
    return True
