"""Hermetic test for the systemd ExecStop shutdown-screen shell script.

The script (services/oled-display/droplet-shutdown-screen.sh) is the testable
unit of the shutdown path: it reads the bearer token from the device-bridge
env file and POSTs the shutdown screen to the oled-display service, then
sleeps briefly so the serial frame lands before teardown. It must NEVER block
shutdown — bounded curl, errors swallowed, exit 0 even when the endpoint is
down.

We drive it via subprocess against a throwaway http.server stub so the test is
self-contained (no real service, no real systemd). Skipped automatically if a
POSIX `sh` isn't on PATH (e.g. a bare Windows shell without Git Bash).
"""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "droplet-shutdown-screen.sh"
SH = shutil.which("sh")

pytestmark = pytest.mark.skipif(SH is None, reason="POSIX sh not available")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Capture:
    method = None
    path = None
    auth = None
    body = None
    content_type = None


def _make_server(port: int, capture: _Capture) -> HTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            capture.method = "POST"
            capture.path = self.path
            capture.auth = self.headers.get("Authorization")
            capture.content_type = self.headers.get("Content-Type")
            capture.body = self.rfile.read(length).decode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true, "mode": "shutdown"}')

        def log_message(self, *args):  # silence the stub server
            pass

    return HTTPServer(("127.0.0.1", port), Handler)


def _write_env(tmp_path: Path, token: str = "shutdown-test-token") -> Path:
    env_file = tmp_path / "device-bridge.env"
    env_file.write_text(
        "# test env\nBRIDGE_AUTH_TOKEN={}\nOPENWRT_PASS=irrelevant\n".format(token),
        encoding="utf-8",
    )
    return env_file


def _run_script(env_file: Path, url: str, extra_env=None):
    import os

    env = dict(os.environ)
    env.update({
        "DEVICE_BRIDGE_ENV": str(env_file),
        "SHUTDOWN_SCREEN_URL": url,
        "SHUTDOWN_SCREEN_SLEEP": "0",  # don't actually pause the test
    })
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [SH, str(SCRIPT)],
        env=env, capture_output=True, text=True, timeout=20,
    )


def test_script_exists_and_is_sh():
    assert SCRIPT.exists(), f"missing {SCRIPT}"
    first = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("#!") and "sh" in first


def test_posts_expected_json_and_bearer(tmp_path):
    capture = _Capture()
    port = _free_port()
    server = _make_server(port, capture)
    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start()
    try:
        env_file = _write_env(tmp_path, token="abc123")
        url = f"http://127.0.0.1:{port}/display/shutdown"
        proc = _run_script(env_file, url)
        t.join(timeout=10)
    finally:
        server.server_close()

    assert proc.returncode == 0, proc.stderr
    assert capture.method == "POST"
    assert capture.path == "/display/shutdown"
    assert capture.auth == "Bearer abc123"
    assert capture.content_type == "application/json"
    payload = json.loads(capture.body)
    assert payload.get("phase") == "stopping"
    assert "reason" in payload


def test_exits_zero_when_endpoint_unreachable(tmp_path):
    # Point at a closed port. The script must bound the curl and exit 0 fast
    # so it can never wedge systemd shutdown.
    env_file = _write_env(tmp_path)
    dead_url = f"http://127.0.0.1:{_free_port()}/display/shutdown"
    start = time.time()
    proc = _run_script(env_file, dead_url)
    elapsed = time.time() - start
    assert proc.returncode == 0, proc.stderr
    assert elapsed < 15, f"script took too long ({elapsed:.1f}s) — would block shutdown"


def test_exits_zero_when_env_file_missing(tmp_path):
    # No token available at all — still must not error out.
    missing = tmp_path / "does-not-exist.env"
    dead_url = f"http://127.0.0.1:{_free_port()}/display/shutdown"
    proc = _run_script(missing, dead_url)
    assert proc.returncode == 0, proc.stderr
