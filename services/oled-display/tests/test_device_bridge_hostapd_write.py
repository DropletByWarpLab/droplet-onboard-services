"""Unit tests for the device-bridge single-box hostapd-write boundary (WARP-808).

The bridge NEVER runs hostapd / writes /etc/hostapd.conf itself — the Wi-Fi
write shells the repo-tracked host script (scripts/host/droplet-set-hostapd.sh,
installed to /usr/local/sbin by setup.sh). The bridge's job is:
  (a) require auth on the POST (mirrors /pools/command + /drives/:uuid/eject),
  (b) refuse on a non-hostapd (uci / multi-box) deployment — the host write only
      makes sense on the single-box hostapd shape (AC2 + AC5 regression guard),
  (c) hand the validated op to the host script, whose hard validation
      (SSID 1-32 / PSK 8-63, reject-before-write) is the real gate, and
  (d) NEVER log the PSK (architecture-guard rule 19).

We monkeypatch at the `_run` boundary so no host script / systemctl ever runs.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    # Default to hostapd mode so the write path is exercised; individual tests
    # override DROPLET_AP_MODE to assert the uci-mode refusal.
    monkeypatch.setenv("DROPLET_AP_MODE", "hostapd")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_hostapd_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# run_set_hostapd() shells the HOST SCRIPT, never hostapd/systemctl directly
# ---------------------------------------------------------------------------

def test_set_hostapd_invokes_host_script_not_hostapd(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, '{"ok": true, "ssid": "HomeNet"}', ""

    monkeypatch.setattr(bridge, "_run", fake_run)

    ok, info = bridge.run_set_hostapd({"ssid": "HomeNet", "psk": "supersecret1"})
    assert ok is True
    cmd = captured["cmd"]
    # It shells the host script — NOT hostapd/systemctl from the bridge process.
    assert any("droplet-set-hostapd.sh" in str(part) for part in cmd)
    assert "hostapd" not in [str(p) for p in cmd if p != cmd[0]] or \
        all("droplet-set-hostapd.sh" in str(p) or p.startswith("{")
            for p in cmd[1:])
    assert "systemctl" not in cmd


def test_set_hostapd_passes_ssid_and_psk_as_json_payload(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, '{"ok": true, "ssid": "HomeNet"}', ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    bridge.run_set_hostapd({"ssid": "HomeNet", "psk": "supersecret1"})
    # The single JSON arg carries both fields through to the script.
    import json
    json_args = [p for p in captured["cmd"] if isinstance(p, str)
                 and p.strip().startswith("{")]
    assert json_args, "expected a JSON params argument"
    parsed = json.loads(json_args[0])
    assert parsed.get("ssid") == "HomeNet"
    assert parsed.get("psk") == "supersecret1"


def test_set_hostapd_surfaces_host_script_refusal(monkeypatch):
    """When the host-script validation refuses (non-zero exit), the bridge
    surfaces (False, ...) — it must NOT swallow it as success."""
    bridge = _load_bridge(monkeypatch)

    def fake_run(cmd, timeout=15):
        return 1, "", "droplet-set-hostapd: Wi-Fi password must be 8-63 characters (got 5)"

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, info = bridge.run_set_hostapd({"ssid": "HomeNet", "psk": "short"})
    assert ok is False
    assert "password" in str(info).lower()


def test_set_hostapd_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd, timeout=15):
        raise OSError("script not found")

    monkeypatch.setattr(bridge, "_run", explode)
    # Must degrade to (False, ...) rather than propagate — same contract as
    # eject_drive() / run_pool_command().
    ok, info = bridge.run_set_hostapd({"ssid": "HomeNet", "psk": "supersecret1"})
    assert ok is False


def test_set_hostapd_serializes_concurrent_writes(monkeypatch):
    """Two concurrent writes must NOT both reach the host script. The second to
    arrive (while the first holds _HOSTAPD_LOCK) is rejected with an
    'in progress' sentinel — mirrors rotate_wifi_key()'s non-blocking acquire.
    Without the lock, both would exec the script + double-restart the AP."""
    import threading

    bridge = _load_bridge(monkeypatch)

    in_script = threading.Event()      # signalled once thread-1 is inside _run
    release = threading.Event()        # held until the test lets thread-1 finish
    call_count = {"n": 0}

    def blocking_run(cmd, timeout=15):
        call_count["n"] += 1
        in_script.set()
        # Hold the lock open until the second attempt has had its chance.
        release.wait(timeout=5)
        return 0, '{"ok": true, "ssid": "HomeNet"}', ""

    monkeypatch.setattr(bridge, "_run", blocking_run)

    results = {}

    def first():
        results["first"] = bridge.run_set_hostapd({"ssid": "HomeNet", "psk": "supersecret1"})

    t1 = threading.Thread(target=first)
    t1.start()
    assert in_script.wait(timeout=5), "first write never entered the host script"

    # Second write while the first still holds the lock → rejected, host script
    # NOT invoked a second time.
    ok2, info2 = bridge.run_set_hostapd({"ssid": "Other", "psk": "anothersecret"})
    assert ok2 is False
    assert "in progress" in str(info2).lower()

    release.set()
    t1.join(timeout=5)
    assert results["first"][0] is True        # the first write succeeded
    assert call_count["n"] == 1               # host script ran exactly once


def test_concurrent_hostapd_write_maps_to_409(monkeypatch):
    """At the HTTP layer, the 'in progress' contention sentinel becomes 409
    Conflict (not 422) — distinct from a validation refusal."""
    import threading

    bridge = _load_bridge(monkeypatch)
    in_script = threading.Event()
    release = threading.Event()

    def blocking_run(cmd, timeout=15):
        in_script.set()
        release.wait(timeout=5)
        return 0, '{"ok": true, "ssid": "HomeNet"}', ""

    monkeypatch.setattr(bridge, "_run", blocking_run)

    def first():
        bridge.run_set_hostapd({"ssid": "HomeNet", "psk": "supersecret1"})

    t1 = threading.Thread(target=first)
    t1.start()
    assert in_script.wait(timeout=5)
    try:
        status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                            {"ssid": "Other", "psk": "anothersecret"})
        assert status == 409
        assert obj.get("ok") is False
        assert "in progress" in str(obj.get("error", "")).lower()
    finally:
        release.set()
        t1.join(timeout=5)


def test_set_hostapd_does_not_log_the_psk(monkeypatch, caplog):
    """The PSK is a per-device secret — it must never reach the bridge logs,
    even on the refusal path."""
    import logging
    bridge = _load_bridge(monkeypatch)
    secret = "correct-horse-battery"

    # Refusal path logs the host script's stderr; make sure we sanitize/omit the
    # value. (The host script itself already omits it; the bridge must not
    # re-introduce it by logging the params dict.)
    def fake_run(cmd, timeout=15):
        return 1, "", "droplet-set-hostapd: refused"

    monkeypatch.setattr(bridge, "_run", fake_run)
    with caplog.at_level(logging.DEBUG):
        bridge.run_set_hostapd({"ssid": "HomeNet", "psk": secret})
    assert secret not in caplog.text


# ---------------------------------------------------------------------------
# POST /openwrt/wifi/hostapd routing — auth + mode gating
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
        self.path = "/openwrt/wifi/hostapd"
        self.sent = []  # list of (status, obj)
        # Bind the real implementations to this fake instance.
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_POST = bridge.Handler.do_POST.__get__(self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _post(bridge, headers, params: dict):
    import json
    body = json.dumps({"ssid": params.get("ssid", ""),
                       "psk": params.get("psk", "")}).encode()
    headers = {**headers, "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, body)
    h.do_POST()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def test_hostapd_write_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    # No auth header -> 401, and the host script is never invoked.
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("host script invoked unauthenticated")))
    status, obj = _post(bridge, {}, {"ssid": "HomeNet", "psk": "supersecret1"})
    assert status == 401


def test_hostapd_write_succeeds_with_token_in_hostapd_mode(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (0, '{"ok": true, "ssid": "HomeNet"}', ""))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"ssid": "HomeNet", "psk": "supersecret1"})
    assert status == 200
    assert obj.get("ok") is True


def test_hostapd_write_refused_in_uci_mode(monkeypatch):
    # Multi-box / uci deployment: there is no host hostapd to write — the route
    # must refuse (409/410) and NEVER invoke the host script. This is the AC2 +
    # AC5 regression guard: a uci box's Wi-Fi path is unaffected.
    bridge = _load_bridge(monkeypatch, env={"DROPLET_AP_MODE": "uci"})
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("host script invoked on a uci box")))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"ssid": "HomeNet", "psk": "supersecret1"})
    assert status in (409, 410)
    assert obj.get("ok") is False


def test_hostapd_write_validation_refusal_is_422(monkeypatch):
    # The host script rejects a bad PSK (exit non-zero). The bridge maps that to
    # 422 (unprocessable) — same shape as /pools/command's host-script refusal.
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (1, "", "droplet-set-hostapd: Wi-Fi password must be 8-63 characters (got 5)"))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"ssid": "HomeNet", "psk": "short"})
    assert status == 422
    assert obj.get("ok") is False


def test_hostapd_write_rejects_bad_json(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("host script invoked on bad json")))
    body = b"{not valid json"
    headers = {"X-Droplet-Auth": "pytest-bridge-token",
               "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, body)
    h.do_POST()
    status, obj = h.sent[-1]
    assert status == 400
