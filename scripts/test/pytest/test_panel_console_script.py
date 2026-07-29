"""Hermetic tests for the rack-panel console-ownership scripts (WARP-1639).

scripts/host/droplet-panel-console.sh is the only place framebuffer ownership
moves between fbcon (a login prompt) and the display service (the status
screen). scripts/host/droplet-panel-deadman.sh is the safety net that hands the
console back on its own when the display service stops answering.

These matter more than most shell scripts here: claiming the panel takes the
operator's physical console away, so a bug in the release path is a bug that
strands someone at a rack with no way in.

Driven via subprocess against a fake /sys/class/vtconsole tree and a throwaway
http.server, so nothing here needs root, a framebuffer, or systemd. Skipped
automatically if a POSIX `sh` isn't on PATH.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

HOST_DIR = Path(__file__).resolve().parents[2] / "host"
CONSOLE_SH = HOST_DIR / "droplet-panel-console.sh"
DEADMAN_SH = HOST_DIR / "droplet-panel-deadman.sh"
SH = shutil.which("sh")

pytestmark = pytest.mark.skipif(SH is None, reason="POSIX sh not available")


# --- fixtures ---------------------------------------------------------------

def _make_vtcon(tmp_path: Path, bind: str = "1") -> Path:
    """A fake /sys/class/vtconsole. vtcon0 is the dummy device and vtcon1 the
    framebuffer one — matching the real box, where the script must select on
    NAME, never on index."""
    root = tmp_path / "vtconsole"
    (root / "vtcon0").mkdir(parents=True)
    (root / "vtcon0" / "name").write_text("(S) dummy device\n")
    (root / "vtcon0" / "bind").write_text("0\n")
    (root / "vtcon1").mkdir(parents=True)
    (root / "vtcon1" / "name").write_text("(M) frame buffer device\n")
    (root / "vtcon1" / "bind").write_text(bind + "\n")
    return root


def _env(tmp_path: Path, vtcon: Path, **extra) -> dict:
    run_dir = tmp_path / "run"
    run_dir.mkdir(exist_ok=True)
    chvt = tmp_path / "chvt-stub"
    if not chvt.exists():
        chvt.write_text("#!/bin/sh\necho \"$@\" >> \"$CHVT_LOG\"\nexit 0\n")
        chvt.chmod(0o755)
    env = {
        # Inherit the ambient PATH rather than pinning /usr/bin:/bin — the
        # script shells date/sed/curl, and pinning breaks any host whose
        # coreutils live elsewhere (Git Bash, nix, busybox images).
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "DROPLET_VTCONSOLE_DIR": str(vtcon),
        "DROPLET_PANEL_RUN_DIR": str(run_dir),
        "DROPLET_CHVT": str(chvt),
        "CHVT_LOG": str(tmp_path / "chvt.log"),
    }
    env.update({k: str(v) for k, v in extra.items()})
    return env


def _run(script: Path, args, env: dict, timeout: int = 20):
    return subprocess.run([SH, str(script), *args], env=env,
                          capture_output=True, text=True, timeout=timeout)


def _bind(vtcon: Path) -> str:
    return (vtcon / "vtcon1" / "bind").read_text().strip()


# --- claim / release --------------------------------------------------------

def test_claim_unbinds_the_framebuffer_console(tmp_path: Path):
    vt = _make_vtcon(tmp_path, bind="1")
    r = _run(CONSOLE_SH, ["claim"], _env(tmp_path, vt))
    assert r.returncode == 0, r.stderr
    assert _bind(vt) == "0"


def test_claim_selects_by_name_not_index(tmp_path: Path):
    """vtcon0 is the dummy device and must be left alone — the framebuffer
    console is not guaranteed to be vtcon1 on every box."""
    vt = _make_vtcon(tmp_path, bind="1")
    _run(CONSOLE_SH, ["claim"], _env(tmp_path, vt))
    assert (vt / "vtcon0" / "bind").read_text().strip() == "0"
    assert _bind(vt) == "0"


def test_release_rebinds_and_switches_vt(tmp_path: Path):
    vt = _make_vtcon(tmp_path, bind="0")
    env = _env(tmp_path, vt, DROPLET_PANEL_CONSOLE_VT=2)
    r = _run(CONSOLE_SH, ["release"], env)
    assert r.returncode == 0, r.stderr
    assert _bind(vt) == "1"
    assert (tmp_path / "chvt.log").read_text().strip() == "2"


def test_release_is_idempotent(tmp_path: Path):
    vt = _make_vtcon(tmp_path, bind="1")
    r = _run(CONSOLE_SH, ["release"], _env(tmp_path, vt))
    assert r.returncode == 0
    assert _bind(vt) == "1"


def test_missing_framebuffer_console_is_not_a_crash(tmp_path: Path):
    """A headless box has no framebuffer console. Claim must no-op cleanly so
    the boot-time unit doesn't sit failed forever."""
    empty = tmp_path / "empty"
    empty.mkdir()
    r = _run(CONSOLE_SH, ["claim"], _env(tmp_path, empty))
    assert r.returncode == 0, r.stderr


# --- the release hold -------------------------------------------------------

def test_release_blocks_a_subsequent_claim(tmp_path: Path):
    """The whole point of the hold: a healthy display service must not be able
    to yank the panel back while someone is mid-debug at the rack."""
    vt = _make_vtcon(tmp_path, bind="0")
    env = _env(tmp_path, vt)
    _run(CONSOLE_SH, ["release", "600"], env)
    r = _run(CONSOLE_SH, ["claim"], env)
    assert r.returncode == 3
    assert _bind(vt) == "1", "claim must not have taken the console back"


def test_force_overrides_the_hold(tmp_path: Path):
    vt = _make_vtcon(tmp_path, bind="0")
    env = _env(tmp_path, vt)
    _run(CONSOLE_SH, ["release", "600"], env)
    r = _run(CONSOLE_SH, ["claim", "--force"], env)
    assert r.returncode == 0, r.stderr
    assert _bind(vt) == "0"


def test_expired_hold_allows_a_claim(tmp_path: Path):
    """A forgotten debug session must not leave the rack showing a login
    prompt forever — once the hold lapses the panel can be reclaimed."""
    vt = _make_vtcon(tmp_path, bind="0")
    env = _env(tmp_path, vt)
    _run(CONSOLE_SH, ["release", "1"], env)
    time.sleep(2)
    r = _run(CONSOLE_SH, ["claim"], env)
    assert r.returncode == 0, r.stderr
    assert _bind(vt) == "0"


def test_zero_ttl_holds_indefinitely(tmp_path: Path):
    vt = _make_vtcon(tmp_path, bind="0")
    env = _env(tmp_path, vt)
    _run(CONSOLE_SH, ["release", "0"], env)
    time.sleep(2)
    assert _run(CONSOLE_SH, ["claim"], env).returncode == 3


def test_status_reports_owner_and_hold(tmp_path: Path):
    vt = _make_vtcon(tmp_path, bind="0")
    env = _env(tmp_path, vt)
    assert "owner=display" in _run(CONSOLE_SH, ["status"], env).stdout
    assert "held=no" in _run(CONSOLE_SH, ["status"], env).stdout
    _run(CONSOLE_SH, ["release", "600"], env)
    out = _run(CONSOLE_SH, ["status"], env).stdout
    assert "owner=console" in out and "held=" in out and "held=no" not in out


def test_bad_verb_is_a_usage_error(tmp_path: Path):
    vt = _make_vtcon(tmp_path)
    assert _run(CONSOLE_SH, ["wat"], _env(tmp_path, vt)).returncode == 2


# --- deadman ----------------------------------------------------------------

def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Health(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *a):
        pass


@pytest.fixture
def healthy_url():
    port = _free_port()
    srv = HTTPServer(("127.0.0.1", port), _Health)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}/health"
    finally:
        srv.shutdown()
        srv.server_close()


def _console_shim(tmp_path: Path) -> Path:
    shim = tmp_path / "console-shim"
    if not shim.exists():
        shim.write_text(f'#!/bin/sh\nexec "{SH}" "{CONSOLE_SH}" "$@"\n')
        shim.chmod(0o755)
    return shim


def _deadman_env(tmp_path: Path, vt: Path, url: str, **extra) -> dict:
    env = _env(tmp_path, vt, **extra)
    env.update({
        "DROPLET_PANEL_HEALTH_URL": url,
        # The deadman execs the console script by absolute path (production:
        # /usr/local/sbin, installed 0755). Point it at a shim so the test does
        # not depend on the checkout preserving the exec bit.
        "DROPLET_PANEL_CONSOLE_SH": str(_console_shim(tmp_path)),
        "DEVICE_BRIDGE_ENV": str(tmp_path / "nonexistent.env"),
    })
    return env


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl not available")
def test_deadman_releases_console_after_threshold(tmp_path: Path):
    """THE safety net. Display service unreachable while it owns the panel =>
    the operator gets a console back without touching anything."""
    vt = _make_vtcon(tmp_path, bind="0")
    dead = f"http://127.0.0.1:{_free_port()}/health"   # nothing listening
    env = _deadman_env(tmp_path, vt, dead, DROPLET_PANEL_FAIL_THRESHOLD=2)

    r = _run(DEADMAN_SH, [], env)
    assert r.returncode == 0
    assert _bind(vt) == "0", "must not release on the first failure"

    r = _run(DEADMAN_SH, [], env)
    assert r.returncode == 0
    assert _bind(vt) == "1", "second consecutive failure must release"


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl not available")
def test_deadman_leaves_a_healthy_panel_alone(tmp_path: Path, healthy_url):
    vt = _make_vtcon(tmp_path, bind="0")
    env = _deadman_env(tmp_path, vt, healthy_url, DROPLET_PANEL_FAIL_THRESHOLD=1)
    for _ in range(3):
        assert _run(DEADMAN_SH, [], env).returncode == 0
    assert _bind(vt) == "0"


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl not available")
def test_deadman_failure_streak_resets_on_recovery(tmp_path: Path, healthy_url):
    """Only CONSECUTIVE failures count — a single blip during a container
    restart must not drop the status screen to a login prompt."""
    vt = _make_vtcon(tmp_path, bind="0")
    dead = f"http://127.0.0.1:{_free_port()}/health"
    env = _deadman_env(tmp_path, vt, dead, DROPLET_PANEL_FAIL_THRESHOLD=2)

    _run(DEADMAN_SH, [], env)                       # fail 1
    env["DROPLET_PANEL_HEALTH_URL"] = healthy_url
    _run(DEADMAN_SH, [], env)                       # recovered -> streak reset
    env["DROPLET_PANEL_HEALTH_URL"] = dead
    _run(DEADMAN_SH, [], env)                       # fail 1 again, not 2
    assert _bind(vt) == "0"


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl not available")
def test_deadman_reclaims_once_the_hold_expires(tmp_path: Path, healthy_url):
    """A debug session that is walked away from must not leave the rack on a
    login prompt indefinitely."""
    vt = _make_vtcon(tmp_path, bind="0")
    env = _deadman_env(tmp_path, vt, healthy_url)
    _run(CONSOLE_SH, ["release", "1"], env)
    assert _bind(vt) == "1"
    time.sleep(2)
    assert _run(DEADMAN_SH, [], env).returncode == 0
    assert _bind(vt) == "0", "healthy service + expired hold should reclaim"


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl not available")
def test_deadman_respects_a_live_hold(tmp_path: Path, healthy_url):
    vt = _make_vtcon(tmp_path, bind="0")
    env = _deadman_env(tmp_path, vt, healthy_url)
    _run(CONSOLE_SH, ["release", "600"], env)
    assert _run(DEADMAN_SH, [], env).returncode == 0
    assert _bind(vt) == "1", "must not reclaim while someone is mid-debug"
