"""Real TCP peers pin absolute HTTP deadlines and streaming resource cleanup."""
from __future__ import annotations

import asyncio
import http.client
import io
import socketserver
import threading
import time

import pytest

import hosted_http
from gitstore import StoreError


@pytest.fixture()
def peer():
    servers = []

    def start(respond):
        stopped = threading.Event()

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(2)
                try:
                    respond(self.request, stopped)
                except (ConnectionError, OSError):
                    pass  # The relay intentionally closes an unfinished response.

        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        server.block_on_close = False
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        servers.append((server, thread, stopped))
        return server.server_address[1]

    yield start
    for server, thread, stopped in servers:
        stopped.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)
        assert not thread.is_alive()


def read_request(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("request closed before headers")
        data += chunk
    raw, body = data.split(b"\r\n\r\n", 1)
    lines = raw.decode("iso-8859-1").split("\r\n")
    headers = dict(line.lower().split(": ", 1) for line in lines[1:])
    length = int(headers.get("content-length", "0"))
    while len(body) < length:
        body += sock.recv(length - len(body))
    return lines[0], headers, body


def request(port, *, timeout=0.25, path="/", query="", headers=None, body=b""):
    return hosted_http.proxy_response(port, "POST" if body else "GET", path, query,
                                      headers or {}, io.BytesIO(body), len(body), timeout)


def assert_closed(response, original_body, original_connection, timer):
    assert response.body is None
    assert original_body.closed
    assert response.connection is None
    assert original_connection.sock is None
    assert response.timer is None
    assert timer.finished.wait(1)


def test_drip_fed_headers_cannot_extend_absolute_request_deadline(peer):
    def respond(sock, stopped):
        read_request(sock)
        sock.sendall(b"HTTP/1.1 200 OK\r\nX-Slow: ")
        while not stopped.wait(0.025):
            sock.sendall(b"a")

    started = time.monotonic()
    with pytest.raises(StoreError, match="timed out") as error:
        request(peer(respond))
    assert error.value.status == 504
    assert 0.15 <= time.monotonic() - started < 1.5


def test_drip_fed_chunk_framing_cannot_extend_response_deadline(peer):
    def respond(sock, stopped):
        read_request(sock)
        sock.sendall(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
        # No CRLF: HTTPResponse waits for the chunk-size line while bytes arrive.
        while not stopped.wait(0.025):
            sock.sendall(b"1")

    started = time.monotonic()
    response = request(peer(respond))
    body, connection, timer = response.body, response.connection, response.timer
    with pytest.raises(TimeoutError, match="deadline"):
        list(response.chunks())
    assert time.monotonic() - started < 1.5
    assert_closed(response, body, connection, timer)


@pytest.mark.parametrize("version", ["HTTP/1.0", "HTTP/1.1"])
def test_sse_flushes_immediately_and_closes_at_absolute_deadline(peer, version):
    def respond(sock, stopped):
        read_request(sock)
        framing = b"Transfer-Encoding: chunked\r\n" if version == "HTTP/1.1" else b""
        sock.sendall(version.encode() + b" 200 OK\r\nContent-Type: text/event-stream\r\n" + framing + b"\r\n")
        for number in range(100):
            data = f"data: {number}\n\n".encode()
            wire = f"{len(data):x}\r\n".encode() + data + b"\r\n" if framing else data
            sock.sendall(wire)
            if stopped.wait(0.025):
                return

    response = request(peer(respond))
    body, connection, timer = response.body, response.connection, response.timer
    if version == "HTTP/1.0":
        assert connection.sock is None  # The HTTPResponse now owns the socket.
    chunks = response.chunks()
    started = time.monotonic()
    assert next(chunks) == b"data: 0\n\n"
    assert time.monotonic() - started < 0.15
    with pytest.raises(TimeoutError, match="deadline"):
        list(chunks)
    assert time.monotonic() - started < 1.5
    assert_closed(response, body, connection, timer)


def test_cancelling_stream_closes_socket_and_deadline_timer(peer):
    def respond(sock, stopped):
        read_request(sock)
        sock.sendall(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
        stopped.wait(1)

    response = request(peer(respond), timeout=2)
    body, connection, timer = response.body, response.connection, response.timer
    chunks = response.chunks()
    assert next(chunks) == b"hello"
    chunks.close()
    assert_closed(response, body, connection, timer)
    assert not response.expired.is_set()


@pytest.mark.parametrize("connection_close", [False, True])
def test_concurrent_close_interrupts_reader_in_drip_fed_chunk_framing(peer, connection_close):
    reading = threading.Event()
    fed = threading.Event()

    def respond(sock, stopped):
        read_request(sock)
        connection = b"Connection: close\r\n" if connection_close else b""
        sock.sendall(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n" + connection + b"\r\n")
        count = 0
        while not stopped.wait(0.025):
            sock.sendall(b"1")  # Keep readline busy without completing a chunk-size line.
            count += 1
            if count == 3:
                fed.set()

    response = request(peer(respond), timeout=5)
    body, connection, timer = response.body, response.connection, response.timer
    if connection_close:
        assert connection.sock is None  # Exercise the HTTPResponse-owned socket.
    original_read = body.fp.readline

    def read(*args):
        reading.set()
        return original_read(*args)

    # Synchronize on the blocked chunk-framing read itself, rather than
    # merely on entry into read1 before HTTPResponse has touched its fp.
    body.fp.readline = read
    errors = []
    closed = threading.Event()

    def consume():
        try:
            list(response.chunks())
        except Exception as exc:  # noqa: BLE001 — assert worker failures on the test thread.
            errors.append(exc)

    def close():
        try:
            response.close()
        except Exception as exc:  # noqa: BLE001 — assert worker failures on the test thread.
            errors.append(exc)
        finally:
            closed.set()

    reader = threading.Thread(target=consume, daemon=True)
    reader.start()
    assert reading.wait(1) and fed.wait(1)
    started = time.monotonic()
    closer = threading.Thread(target=close, daemon=True)
    closer.start()
    assert closed.wait(1), "close blocked behind the active buffered-reader lock"
    reader.join(timeout=0.4)
    closer.join(timeout=0.1)
    assert not reader.is_alive() and not closer.is_alive()
    assert time.monotonic() - started < 1.5
    assert_closed(response, body, connection, timer)
    assert not response.expired.is_set()
    # Closing a read in progress can terminate it with a socket/HTTP error;
    # a double-close AttributeError or other internal exception is a defect.
    assert all(isinstance(exc, (OSError, http.client.HTTPException)) for exc in errors), repr(errors)


def test_close_interrupts_socket_then_waits_for_response_read_to_finish():
    reading, shutdown, interrupted = threading.Event(), threading.Event(), threading.Event()
    release, body_closed = threading.Event(), threading.Event()
    errors = []

    class Socket:
        def shutdown(self, how):
            shutdown.set()

    class Connection:
        sock = Socket()

        def close(self):
            self.sock = None

    class Body:
        def read1(self, size):
            reading.set()
            assert shutdown.wait(1), "close did not interrupt the socket"
            interrupted.set()
            assert release.wait(1), "test did not release the interrupted read"
            raise OSError("socket shut down")

        read = read1

        def close(self):
            assert release.is_set(), "response closed while read still owns fp"
            body_closed.set()

    response = hosted_http.RelayResponse(200, {}, Body(), connection=Connection())

    def consume():
        try:
            list(response.chunks())
        except Exception as exc:  # noqa: BLE001 — assert worker failures below.
            errors.append(exc)

    def close():
        try:
            response.close()
        except Exception as exc:  # noqa: BLE001 — assert worker failures below.
            errors.append(exc)

    reader = threading.Thread(target=consume, daemon=True)
    closer = threading.Thread(target=close, daemon=True)
    reader.start()
    try:
        assert reading.wait(1)
        closer.start()
        assert interrupted.wait(1)
        assert not body_closed.is_set()
    finally:
        release.set()
        reader.join(timeout=1)
        if closer.ident is not None:
            closer.join(timeout=1)
    assert not reader.is_alive() and not closer.is_alive()
    assert body_closed.is_set()
    assert len(errors) == 1 and isinstance(errors[0], OSError), repr(errors)
    response.close()  # Idempotent after the reader and closer both cleaned up.


def test_asgi_send_failure_before_iteration_closes_upstream(peer):
    import main

    def respond(sock, stopped):
        read_request(sock)
        sock.sendall(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
        stopped.wait(1)

    response = request(peer(respond), timeout=2)
    body, connection, timer = response.body, response.connection, response.timer
    app_response = main._AppResponse(response)
    sent = []

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message["type"])
        raise RuntimeError("client disconnected before body iteration")

    with pytest.raises(RuntimeError, match="before body iteration"):
        asyncio.run(app_response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send))
    assert sent == ["http.response.start"]
    assert_closed(response, body, connection, timer)
    assert not response.expired.is_set()


def test_unicode_paths_queries_and_existing_escapes_reach_loopback_peer(peer):
    observed = []

    def respond(sock, stopped):
        observed.append(read_request(sock)[0])
        sock.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")

    response = request(peer(respond), path="/caf\u00e9/%2F", query="currency=\u20ac&preserved=%2B")
    assert list(response.chunks()) == []
    assert observed == ["GET /caf%C3%A9/%2F?currency=%E2%82%AC&preserved=%2B HTTP/1.1"]


def test_transport_filters_credentials_hop_headers_and_redirects_without_following(peer):
    observed = []

    def respond(sock, stopped):
        observed.append(read_request(sock))
        sock.sendall(b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\n"
                     b"Location: https://external.invalid/\r\nSet-Cookie: droplet_session=forged\r\n"
                     b"WWW-Authenticate: Bearer\r\nAccess-Control-Allow-Origin: *\r\n"
                     b"Upgrade: websocket\r\nX-Droplet-Relay: forged\r\n\r\n")

    response = request(peer(respond), headers={
        "Cookie": "droplet_session=secret", "Authorization": "Bearer secret",
        "Host": "external.invalid", "Connection": "upgrade", "Upgrade": "websocket",
        "X-Droplet-Relay-Key": "internal-key", "X-Droplet-User-Id": "alice",
        "Last-Event-Id": "42", "Content-Length": "9999",
    }, body=b"input")
    assert response.status == 302
    assert response.headers["location"] == "https://external.invalid/"
    assert response.headers["x-droplet-relay"] == "app"
    assert set(response.headers) == {"content-length", "location", "x-droplet-relay", "x-content-type-options"}
    assert list(response.chunks()) == []
    assert len(observed) == 1
    _, headers, body = observed[0]
    assert body == b"input" and headers["content-length"] == "5"
    assert headers["host"].startswith("127.0.0.1:")
    assert headers["x-droplet-user-id"] == "alice" and headers["last-event-id"] == "42"
    assert not set(headers) & {"cookie", "authorization", "connection", "upgrade", "x-droplet-relay-key"}
