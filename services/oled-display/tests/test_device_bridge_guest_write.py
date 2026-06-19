"""Unit tests for the device-bridge guest Wi-Fi boundary.

The bridge NEVER runs hostapd / writes /etc/hostapd.conf itself — the guest
write shells the repo-tracked host script (scripts/host/droplet-set-guest-wifi.sh,
installed to /usr/local/sbin by setup.sh). The bridge's job is:
  (a) require auth on POST/DELETE /openwrt/wifi/guest,
  (b) refuse on a non-hostapd (uci / multi-box) deployment — the host write only
      applies on the single-box hostapd shape (regression guard),
  (c) hand the validated op to the host script (whose hard validation is the
      real gate), and
  (d) NEVER log the guest PSK (architecture-guard rule 19).

We monkeypatch at the `_run` boundary so no host script / systemctl ever runs.
Mirrors test_device_bridge_hostapd_write.py.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    monkeypatch.setenv("DROPLET_AP_MODE", "hostapd")
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    spec = importlib.util.spec_from_file_location(
        "device_bridge_guest_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# run_set_guest_wifi() / run_remove_guest_wifi() shell the HOST SCRIPT
# ---------------------------------------------------------------------------

def test_set_guest_invokes_host_script_not_hostapd(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, '{"ok": true, "enabled": true, "ssid": "Guests"}', ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, code, info = bridge.run_set_guest_wifi({"ssid": "Guests", "psk": "welcome123"})
    assert ok is True
    assert code == "ok"
    cmd = captured["cmd"]
    assert any("droplet-set-guest-wifi.sh" in str(part) for part in cmd)
    assert "systemctl" not in cmd
    assert "hostapd" not in [str(p) for p in cmd]


def test_set_guest_passes_ssid_and_psk_as_json_payload(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, '{"ok": true}', ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    bridge.run_set_guest_wifi({"ssid": "Guests", "psk": "welcome123"})
    json_args = [p for p in captured["cmd"] if isinstance(p, str) and p.strip().startswith("{")]
    assert json_args, "expected a JSON params argument"
    parsed = json.loads(json_args[0])
    assert parsed.get("ssid") == "Guests"
    assert parsed.get("psk") == "welcome123"


def test_remove_guest_sends_remove_action(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    captured = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, '{"ok": true, "enabled": false, "removed": true}', ""

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, code, info = bridge.run_remove_guest_wifi()
    assert ok is True and code == "ok"
    json_args = [p for p in captured["cmd"] if isinstance(p, str) and p.strip().startswith("{")]
    parsed = json.loads(json_args[0])
    assert parsed.get("action") == "remove"


def test_set_guest_surfaces_host_script_refusal(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def fake_run(cmd, timeout=15):
        return 1, "", "droplet-set-guest-wifi: guest Wi-Fi password must be 8-63 characters (got 5)"

    monkeypatch.setattr(bridge, "_run", fake_run)
    ok, code, info = bridge.run_set_guest_wifi({"ssid": "Guests", "psk": "short"})
    assert ok is False
    assert code == "script_error"
    assert "password" in str(info).lower()


def test_set_guest_never_raises(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    def explode(cmd, timeout=15):
        raise OSError("script not found")

    monkeypatch.setattr(bridge, "_run", explode)
    ok, code, info = bridge.run_set_guest_wifi({"ssid": "Guests", "psk": "welcome123"})
    assert ok is False
    assert code == "exec_error"


def test_set_guest_does_not_log_the_psk(monkeypatch, caplog):
    import logging
    bridge = _load_bridge(monkeypatch)
    secret = "guest-correct-horse"

    def fake_run(cmd, timeout=15):
        return 1, "", "droplet-set-guest-wifi: refused"

    monkeypatch.setattr(bridge, "_run", fake_run)
    with caplog.at_level(logging.DEBUG):
        bridge.run_set_guest_wifi({"ssid": "Guests", "psk": secret})
    assert secret not in caplog.text


def test_set_guest_serializes_concurrent_writes(monkeypatch):
    """Two concurrent guest writes must not both reach the host script."""
    import threading
    bridge = _load_bridge(monkeypatch)

    in_script = threading.Event()
    release = threading.Event()
    call_count = {"n": 0}

    def blocking_run(cmd, timeout=15):
        call_count["n"] += 1
        in_script.set()
        release.wait(timeout=5)
        return 0, '{"ok": true}', ""

    monkeypatch.setattr(bridge, "_run", blocking_run)
    results = {}

    def first():
        results["first"] = bridge.run_set_guest_wifi({"ssid": "Guests", "psk": "welcome123"})

    t1 = threading.Thread(target=first)
    t1.start()
    assert in_script.wait(timeout=5)
    ok2, code2, info2 = bridge.run_set_guest_wifi({"ssid": "Other", "psk": "anothersecret"})
    assert ok2 is False
    assert code2 == "busy"
    release.set()
    t1.join(timeout=5)
    assert results["first"][0] is True
    assert call_count["n"] == 1


# ---------------------------------------------------------------------------
# _read_guest_env() — status from the persisted attach env file
# ---------------------------------------------------------------------------

def test_read_guest_env_unconfigured(monkeypatch, tmp_path):
    env_file = tmp_path / "openwrt-attach.env"
    env_file.write_text("DROPLET_AP_SSID=HomeNet\nDROPLET_AP_PSK=homesecret1\n", encoding="utf-8")
    bridge = _load_bridge(monkeypatch, env={"DROPLET_GUEST_ENV_FILE": str(env_file)})
    status = bridge._read_guest_env()
    assert status == {"configured": False, "enabled": False, "ssid": None, "password": None}


def test_read_guest_env_configured_and_enabled(monkeypatch, tmp_path):
    env_file = tmp_path / "openwrt-attach.env"
    env_file.write_text(
        "DROPLET_AP_SSID=HomeNet\n"
        "DROPLET_GUEST_ENABLED=1\n"
        "DROPLET_GUEST_SSID=Guests\n"
        "DROPLET_GUEST_PSK=welcome123\n",
        encoding="utf-8",
    )
    bridge = _load_bridge(monkeypatch, env={"DROPLET_GUEST_ENV_FILE": str(env_file)})
    status = bridge._read_guest_env()
    assert status["configured"] is True
    assert status["enabled"] is True
    assert status["ssid"] == "Guests"
    assert status["password"] == "welcome123"


def test_read_guest_env_disabled_after_remove(monkeypatch, tmp_path):
    # After a remove the script writes ENABLED=0 and clears SSID/PSK.
    env_file = tmp_path / "openwrt-attach.env"
    env_file.write_text(
        "DROPLET_GUEST_ENABLED=0\nDROPLET_GUEST_SSID=\nDROPLET_GUEST_PSK=\n",
        encoding="utf-8",
    )
    bridge = _load_bridge(monkeypatch, env={"DROPLET_GUEST_ENV_FILE": str(env_file)})
    status = bridge._read_guest_env()
    assert status["configured"] is False
    assert status["enabled"] is False


# ---------------------------------------------------------------------------
# HTTP routing — auth + mode gating (POST / GET / DELETE)
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
    """Minimal stand-in exercising do_POST / do_GET / do_DELETE without a socket."""

    def __init__(self, bridge, headers, path, body: bytes = b""):
        self.bridge = bridge
        self.headers = _FakeHeaders(headers)
        self.rfile = _FakeRfile(body)
        self.path = path
        self.sent = []
        self._authed = bridge.Handler._authed.__get__(self, bridge.Handler)
        self.do_POST = bridge.Handler.do_POST.__get__(self, bridge.Handler)
        self.do_GET = bridge.Handler.do_GET.__get__(self, bridge.Handler)
        self.do_DELETE = bridge.Handler.do_DELETE.__get__(self, bridge.Handler)
        self._dispatch_post = bridge.Handler._dispatch_post.__get__(self, bridge.Handler)

    def _send(self, status, obj):
        self.sent.append((status, obj))


def _post(bridge, headers, params: dict):
    body = json.dumps({"ssid": params.get("ssid", ""), "psk": params.get("psk", "")}).encode()
    headers = {**headers, "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, "/openwrt/wifi/guest", body)
    h.do_POST()
    assert h.sent, "handler did not send a response"
    return h.sent[-1]


def _delete(bridge, headers):
    h = _FakeHandler(bridge, headers, "/openwrt/wifi/guest")
    h.do_DELETE()
    assert h.sent
    return h.sent[-1]


def _get(bridge, headers):
    h = _FakeHandler(bridge, headers, "/openwrt/wifi/guest")
    h.do_GET()
    assert h.sent
    return h.sent[-1]


def test_guest_post_requires_auth_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("host script invoked unauthenticated")))
    status, obj = _post(bridge, {}, {"ssid": "Guests", "psk": "welcome123"})
    assert status == 401


def test_guest_post_succeeds_with_token_in_hostapd_mode(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (0, '{"ok": true, "enabled": true, "ssid": "Guests"}', ""))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"ssid": "Guests", "psk": "welcome123"})
    assert status == 200
    assert obj.get("ok") is True


def test_guest_post_refused_in_uci_mode(monkeypatch):
    bridge = _load_bridge(monkeypatch, env={"DROPLET_AP_MODE": "uci"})
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("host script invoked on a uci box")))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"ssid": "Guests", "psk": "welcome123"})
    assert status in (409, 410)
    assert obj.get("ok") is False


def test_guest_post_validation_refusal_is_422(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(
        bridge, "_run",
        lambda *a, **k: (1, "", "droplet-set-guest-wifi: guest Wi-Fi password must be 8-63 characters (got 5)"))
    status, obj = _post(bridge, {"X-Droplet-Auth": "pytest-bridge-token"},
                        {"ssid": "Guests", "psk": "short"})
    assert status == 422
    assert obj.get("ok") is False


def test_guest_post_rejects_bad_json(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("host script invoked on bad json")))
    body = b"{not valid json"
    headers = {"X-Droplet-Auth": "pytest-bridge-token", "Content-Length": str(len(body))}
    h = _FakeHandler(bridge, headers, "/openwrt/wifi/guest", body)
    h.do_POST()
    status, obj = h.sent[-1]
    assert status == 400


def test_guest_delete_requires_auth(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("host script invoked unauthenticated")))
    status, obj = _delete(bridge, {})
    assert status == 401


def test_guest_delete_succeeds_with_token(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (0, '{"ok": true, "enabled": false, "removed": true}', ""))
    status, obj = _delete(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 200
    assert obj.get("ok") is True


def test_guest_delete_refused_in_uci_mode(monkeypatch):
    bridge = _load_bridge(monkeypatch, env={"DROPLET_AP_MODE": "uci"})
    monkeypatch.setattr(bridge, "_run",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("host script invoked on a uci box")))
    status, obj = _delete(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status in (409, 410)


def test_guest_get_requires_auth(monkeypatch):
    bridge = _load_bridge(monkeypatch)
    status, obj = _get(bridge, {})
    assert status == 401


def test_guest_get_returns_status_in_hostapd_mode(monkeypatch, tmp_path):
    env_file = tmp_path / "openwrt-attach.env"
    env_file.write_text(
        "DROPLET_GUEST_ENABLED=1\nDROPLET_GUEST_SSID=Guests\nDROPLET_GUEST_PSK=welcome123\n",
        encoding="utf-8",
    )
    bridge = _load_bridge(monkeypatch, env={"DROPLET_GUEST_ENV_FILE": str(env_file)})
    status, obj = _get(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 200
    assert obj["configured"] is True
    assert obj["ssid"] == "Guests"


def test_guest_get_refused_in_uci_mode(monkeypatch):
    bridge = _load_bridge(monkeypatch, env={"DROPLET_AP_MODE": "uci"})
    status, obj = _get(bridge, {"X-Droplet-Auth": "pytest-bridge-token"})
    assert status == 409
