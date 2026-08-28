"""Unit tests for the device-bridge factory-reset boundary (WARP-825).

A factory reset wipes every data volume + secrets and bounces the whole stack —
`scripts/factory-reset.sh` runs `docker compose down -v`, which kills the
orchestrator AND (eventually) the device-bridge itself. So unlike the hostapd
write (a blocking `_run`), the reset MUST be spawned DETACHED: the bridge hands
the wipe off to the repo-tracked host script via a non-blocking
`subprocess.Popen` and returns ~immediately, so the wipe survives the bridge's
own teardown.

The bridge NEVER runs `docker compose down -v` itself — it shells the
repo-tracked host script (scripts/host/droplet-factory-reset.sh, installed to
/usr/local/sbin by setup.sh). Its job is:
  (a) require auth on the POST (mirrors /pools/command + /openwrt/wifi/hostapd),
  (b) spawn the host script DETACHED (never block on the multi-minute wipe),
  (c) never raise.

SAFETY: every test monkeypatches the spawn boundary, so the real
factory-reset.sh / docker / `down -v` is NEVER executed. Nothing is wiped.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_reset_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeProc:
    """Stand-in for the detached `subprocess.Popen` of a wipe — only the
    liveness surface the bridge uses (poll() / returncode). `alive=True`
    models a wipe still running (poll() -> None); flipping `alive` to False
    models a wipe that exited (poll() -> returncode), i.e. one that failed
    mid-run without ever tearing the bridge down."""

    def __init__(self, alive: bool = True, returncode: int = 0):
        self._alive = alive
        self.returncode = returncode

    def poll(self):
        return None if self._alive else self.returncode


# ---------------------------------------------------------------------------
# run_factory_reset() spawns the HOST SCRIPT detached, never docker directly
# ---------------------------------------------------------------------------

def test_factory_reset_spawns_host_script_detached(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_spawn(cmd):
        captured["cmd"] = cmd
        return _FakeProc(), None  # (proc, error)

    monkeypatch.setattr(bridge, "_spawn_detached", fake_spawn)

    ok, info = bridge.run_factory_reset({"jobId": "job-1", "targetName": "droplet-home"})
    assert ok is True
    cmd = captured["cmd"]
    # It shells the repo-tracked host script — NOT `docker` / `compose down -v`
    # from the bridge process.
    assert any("droplet-factory-reset.sh" in str(part) for part in cmd)
    assert "docker" not in [str(p) for p in cmd]


def test_factory_reset_uses_popen_not_blocking_run(monkeypatch):
    """The reset must NOT go through the blocking `_run` helper — that would
    wait for the multi-minute wipe to finish, but the wipe tears down the bridge
    mid-flight. It must use the detached spawn path."""
    bridge = _load_bridge(monkeypatch)

    def boom_run(*a, **k):
        raise AssertionError("factory reset must not block on _run")

    monkeypatch.setattr(bridge, "_run", boom_run)
    monkeypatch.setattr(bridge, "_spawn_detached", lambda cmd: (_FakeProc(), None))

    ok, info = bridge.run_factory_reset({"jobId": "job-1", "targetName": "droplet-home"})
    assert ok is True


def test_factory_reset_surfaces_spawn_failure(monkeypatch):
    """If the host script can't even be spawned (missing / not executable), the
    bridge surfaces (False, ...) — it must NOT report success."""
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_spawn_detached",
        lambda cmd: (None, "host script not found"))

    ok, info = bridge.run_factory_reset({"jobId": "job-1", "targetName": "droplet-home"})
    assert ok is False
    assert "not found" in str(info).lower()


def test_factory_reset_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd):
        raise OSError("spawn blew up")

    monkeypatch.setattr(bridge, "_spawn_detached", explode)
    # Degrades to (False, ...) rather than propagating — same contract as
    # run_pool_command() / run_set_hostapd().
    ok, info = bridge.run_factory_reset({"jobId": "job-1", "targetName": "droplet-home"})
    assert ok is False


# ---------------------------------------------------------------------------
# Lock liveness (WARP-825 hardening): a wipe that FAILS mid-run must not wedge
# every future reset at 409. A live wipe still must.
# ---------------------------------------------------------------------------

def test_second_reset_while_wipe_in_flight_is_rejected(monkeypatch):
    """While the first wipe is genuinely running (poll() -> None), a second
    reset is rejected as busy — the lock still serializes concurrent wipes."""
    bridge = _load_bridge(monkeypatch)
    live = _FakeProc(alive=True)
    monkeypatch.setattr(bridge, "_spawn_detached", lambda cmd: (live, None))

    ok1, _ = bridge.run_factory_reset({"jobId": "a", "targetName": "droplet-home"})
    assert ok1 is True
    ok2, info2 = bridge.run_factory_reset({"jobId": "b", "targetName": "droplet-home"})
    assert ok2 is False
    assert info2 == "busy"


def test_stale_lock_reclaimed_after_a_failed_wipe(monkeypatch):
    """If the prior wipe exited WITHOUT tearing the bridge down (it failed),
    the next reset reclaims the stale lock and dispatches a fresh wipe instead
    of returning 409 forever."""
    bridge = _load_bridge(monkeypatch)
    procs = []

    def fake_spawn(cmd):
        p = _FakeProc(alive=True)
        procs.append(p)
        return p, None

    monkeypatch.setattr(bridge, "_spawn_detached", fake_spawn)

    ok1, _ = bridge.run_factory_reset({"jobId": "a", "targetName": "droplet-home"})
    assert ok1 is True

    # The wipe exits without completing the teardown → it failed mid-run.
    procs[0]._alive = False
    procs[0].returncode = 1

    ok2, info2 = bridge.run_factory_reset({"jobId": "b", "targetName": "droplet-home"})
    assert ok2 is True              # lock reclaimed, retry dispatched
    assert info2.get("dispatched") is True
    assert len(procs) == 2          # a second wipe was actually spawned


# ---------------------------------------------------------------------------
# POST /system/factory-reset routing — auth + status
# ---------------------------------------------------------------------------

class _FakeHeaders(dict):
    def get(self, k, default=None):
        for key, val in self.items():
            if key.lower() == k.lower():
                return val
        return default


class _FakeRfile:
    def __init__(self, body: bytes):
        self._body = body

    def read(self, n):
        return self._body[:n]


class _FakeHandler:
    """Minimal stand-in exercising Handler.do_POST without a live socket."""

    def __init__(self, bridge, headers, body: bytes = b""):
        self.bridge = bridge
        self.headers = _FakeHeaders(headers)
        self.rfile = _FakeRfile(body)
        self.path = "/system/factory-reset"
        self.sent = []  # list of (status, obj)
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_POST = bridge.Handler.do_POST.__get__(self, bridge.Handler)
        # do_POST now delegates routing to _dispatch_post inside an outer
        # try/except — bind it too so the fake handler dispatches.
        self._dispatch_post = bridge.Handler._dispatch_post.__get__(
            self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _post(bridge, headers, params: dict):
    import json
    body = json.dumps(params).encode()
    headers = {**headers, "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, body)
    h.do_POST()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def test_reset_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # No auth header -> 401, and the host script is never spawned.
    monkeypatch.setattr(
        bridge, "_spawn_detached",
        lambda cmd: (_ for _ in ()).throw(
            AssertionError("host script spawned unauthenticated")))
    status, obj = _post(bridge, {}, {"jobId": "j", "targetName": "droplet-home"})
    assert status == 401


def test_reset_accepted_with_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    spawned = {"n": 0}

    def fake_spawn(cmd):
        spawned["n"] += 1
        return _FakeProc(), None

    monkeypatch.setattr(bridge, "_spawn_detached", fake_spawn)
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"jobId": "j", "targetName": "droplet-home"})
    # 202 Accepted — the wipe has been dispatched detached.
    assert status == 202
    assert obj.get("ok") is True
    assert spawned["n"] == 1


def test_reset_spawn_failure_maps_to_502(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_spawn_detached",
        lambda cmd: (None, "host script not found"))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"jobId": "j", "targetName": "droplet-home"})
    assert status == 502
    assert obj.get("ok") is False


# ---------------------------------------------------------------------------
# CodeQL py/command-line-injection (#66): the job context comes off the request
# body and is handed to the host script as argv. It is allow-listed first.
# ---------------------------------------------------------------------------

def test_factory_reset_forwards_a_well_formed_job_context(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_spawn(cmd):
        captured["cmd"] = cmd
        return _FakeProc(), None

    monkeypatch.setattr(bridge, "_spawn_detached", fake_spawn)
    ok, info = bridge.run_factory_reset(
        {"jobId": "cm0z9x1y20000abcd1234efgh", "targetName": "d-0123456789abcdef.devices.warp-lab.ai"})
    assert ok is True
    assert json.loads(captured["cmd"][1]) == {
        "jobId": "cm0z9x1y20000abcd1234efgh",
        "targetName": "d-0123456789abcdef.devices.warp-lab.ai",
    }
    assert info["jobId"] == "cm0z9x1y20000abcd1234efgh"


@pytest.mark.parametrize("bad", [
    "job-1; rm -rf /", "$(reboot)", "`id`", "a\nb", "ünïcode", "-flag",
    " leading-space", "two words", "x" * 129, 42, None, ["list"],
])
def test_factory_reset_drops_an_out_of_shape_job_context_but_still_wipes(monkeypatch, bad):
    """The context is informational (the host script only logs jobId), so junk
    is dropped to "" rather than refusing the owner-confirmed wipe — but junk
    never reaches the host script's argv."""
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_spawn(cmd):
        captured["cmd"] = cmd
        return _FakeProc(), None

    monkeypatch.setattr(bridge, "_spawn_detached", fake_spawn)
    ok, info = bridge.run_factory_reset({"jobId": bad, "targetName": bad})
    assert ok is True
    assert json.loads(captured["cmd"][1]) == {"jobId": "", "targetName": ""}
    assert info["jobId"] == ""
