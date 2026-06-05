"""Unit tests for device-bridge.py's Wi-Fi QR paths (WARP-654).

`device-bridge.py` runs on the host and reads its config from the
environment *at import time* (OPENWRT_HOST, DROPLET_AP_MODE, ROTATION_*,
etc.). The filename has a hyphen, so it can't be imported with a plain
`import device-bridge`; we load it from its path via importlib.

To exercise the different deployment shapes (single-box hostapd vs.
multi-box UCI/SSH) we load a *fresh* module instance per test with the
env pre-seeded — that runs the real env-reading code rather than poking
module globals after the fact, which is what we actually want to verify.

The QR matrix is rendered by the real `qrcode` lib (already a runtime
dep of the bridge — see requirements.txt). No SSH, no docker, no router
is ever touched: the multi-box path is monkeypatched at the SSH boundary
and the hostapd `/etc/hostapd.conf` fallback is monkeypatched at the
`docker exec` boundary.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "device-bridge.py"


def _load_bridge(monkeypatch: pytest.MonkeyPatch, env: dict | None = None):
    """Import device-bridge.py fresh with `env` applied.

    A bridge auth token is always seeded so module import (which only
    *reads* env into globals) is representative of a real install; the
    QR paths under test don't depend on it.
    """
    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "pytest-bridge-token")
    # Clear the AP-mode knobs so a leaked value from the process env can't
    # change a test's deployment shape; each test sets exactly what it needs.
    for key in ("DROPLET_AP_MODE", "DROPLET_AP_SSID", "DROPLET_AP_PSK",
                "DROPLET_AP_PSK_FILE", "WIFI_KEY_ROTATION_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)

    spec = importlib.util.spec_from_file_location("device_bridge_under_test",
                                                  _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# hostapd mode — creds from host env (DROPLET_AP_SSID / DROPLET_AP_PSK)
# ---------------------------------------------------------------------------

def test_hostapd_mode_env_creds_yield_real_matrix_and_payload(
        monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        "DROPLET_AP_PSK": "Droplet123!",
    })
    # The hostapd path must never reach SSH/UCI — fail loudly if it does.
    monkeypatch.setattr(bridge, "openwrt_wifi_credentials",
                        lambda: (_ for _ in ()).throw(
                            AssertionError("UCI path used in hostapd mode")))

    snap = bridge.qr_snapshot()

    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet"
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:Droplet123!;;"
    # A real, non-empty square QR matrix of 0/1 cells.
    matrix = snap["matrix"]
    assert isinstance(matrix, list) and len(matrix) > 0
    assert all(len(row) == len(matrix) for row in matrix)
    assert {cell for row in matrix for cell in row} <= {0, 1}
    assert any(cell == 1 for row in matrix for cell in row)
    assert isinstance(snap["version"], int) and snap["version"] >= 1
    assert snap["key"] == "Droplet123!"
    assert snap["security"] == "WPA"


def test_hostapd_mode_dict_shape_matches_multibox(
        monkeypatch: pytest.MonkeyPatch):
    # The PyPortal client reads the same fields regardless of deployment
    # shape, so the hostapd path must return the same key set as the
    # multi-box success path (matrix, ssid, security, payload, version,
    # ok, key, ttl_seconds, rotation_enabled, ...).
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        "DROPLET_AP_PSK": "Droplet123!",
    })
    snap = bridge.qr_snapshot()
    for field in ("ok", "ssid", "security", "hidden", "disabled",
                  "payload", "matrix", "version", "key",
                  "ttl_seconds", "rotation_enabled"):
        assert field in snap, f"missing field: {field}"


def test_hostapd_mode_rotation_disabled(monkeypatch: pytest.MonkeyPatch):
    # Rotation is meaningless in hostapd mode (no UCI to push a new PSK to)
    # and the PyPortal gates the Rotate pill on this flag — it MUST be false
    # even if an operator left WIFI_KEY_ROTATION_ENABLED=true in the env.
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        "DROPLET_AP_PSK": "Droplet123!",
        "WIFI_KEY_ROTATION_ENABLED": "true",
    })
    snap = bridge.qr_snapshot()
    assert snap["rotation_enabled"] is False
    # And no live countdown should be advertised in hostapd mode.
    assert snap["ttl_seconds"] == 0


def test_hostapd_mode_missing_creds_returns_error_not_crash(
        monkeypatch: pytest.MonkeyPatch):
    # hostapd mode with no env SSID and an unreadable hostapd.conf must
    # degrade to ok=false + an error string, never raise (the PyPortal
    # shows the "waiting" placeholder, same contract as the multi-box path).
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "hostapd"})
    monkeypatch.setattr(bridge, "_read_hostapd_conf_creds", lambda: (None, "boom"))
    snap = bridge.qr_snapshot()
    assert snap["ok"] is False
    assert snap["matrix"] is None
    assert snap["error"]


# ---------------------------------------------------------------------------
# hostapd mode — /etc/hostapd.conf fallback (docker exec) when env unset
# ---------------------------------------------------------------------------

_HOSTAPD_CONF = """\
interface=wlan0
driver=nl80211
ssid=Droplet
hw_mode=g
channel=6
wpa=2
wpa_passphrase=Droplet123!
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
"""


def test_hostapd_conf_fallback_parses_ssid_and_psk(
        monkeypatch: pytest.MonkeyPatch):
    # No DROPLET_AP_SSID/PSK in env -> bridge must shell out to
    # `docker exec droplet-openwrt cat /etc/hostapd.conf` and parse it.
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "hostapd"})

    calls = {}

    def fake_run(cmd, timeout=15):
        calls["cmd"] = cmd
        return 0, _HOSTAPD_CONF, ""

    monkeypatch.setattr(bridge, "_run", fake_run)

    snap = bridge.qr_snapshot()
    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet"
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:Droplet123!;;"
    # It really did go through the docker-exec hostapd.conf reader.
    assert "docker" in calls["cmd"]
    assert "/etc/hostapd.conf" in calls["cmd"]
    assert "droplet-openwrt" in calls["cmd"]


def test_hostapd_conf_parser_handles_quotes_and_spacing(
        monkeypatch: pytest.MonkeyPatch):
    # hostapd.conf is `key=value`; values may carry trailing whitespace and
    # the SSID may be quoted. The parser must strip both. PSK values keep
    # their inner characters (e.g. trailing '!').
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "hostapd"})
    conf = 'ssid="My Net"  \nwpa_passphrase= p@ss w0rd! \n'
    creds, err = bridge._parse_hostapd_conf(conf)
    assert err is None
    assert creds["ssid"] == "My Net"
    assert creds["key"] == "p@ss w0rd!"


def test_hostapd_conf_parser_no_ssid_is_error(monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "hostapd"})
    creds, err = bridge._parse_hostapd_conf("driver=nl80211\nchannel=6\n")
    assert creds is None
    assert err


def test_hostapd_env_creds_take_priority_over_conf(
        monkeypatch: pytest.MonkeyPatch):
    # When both env and hostapd.conf are available, env wins (cleanest source)
    # and we never shell out to docker.
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "EnvNet",
        "DROPLET_AP_PSK": "envpass",
    })

    def boom(cmd, timeout=15):
        raise AssertionError("docker exec used despite env creds")

    monkeypatch.setattr(bridge, "_run", boom)
    snap = bridge.qr_snapshot()
    assert snap["ssid"] == "EnvNet"
    assert snap["payload"] == "WIFI:T:WPA;S:EnvNet;P:envpass;;"


# ---------------------------------------------------------------------------
# WARP-819 — persisted per-box PSK file is a coherent creds source
# ---------------------------------------------------------------------------
# droplet-openwrt-attach generates a per-box PSK and persists it to a 0600 file
# (/etc/droplet/ap-psk) which it ALSO mirrors into the bridge env. To guarantee
# the pairing QR/text ALWAYS equals the PSK hostapd serves even if the bridge
# process started before its env was refreshed, the bridge reads that same
# persisted file when DROPLET_AP_PSK isn't in its env. The file path is
# overridable (DROPLET_AP_PSK_FILE) so this is testable without touching /etc.

def test_hostapd_reads_psk_from_persisted_file_when_env_psk_absent(
        monkeypatch: pytest.MonkeyPatch, tmp_path):
    psk_file = tmp_path / "ap-psk"
    psk_file.write_text("480M4GnTS7wPfF36\n")  # trailing newline must be stripped
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        # No DROPLET_AP_PSK in env on purpose — the file is the source.
        "DROPLET_AP_PSK_FILE": str(psk_file),
    })
    # Must not shell out to the container when the persisted file answers.
    monkeypatch.setattr(bridge, "_run", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("docker exec used despite persisted PSK file")))

    snap = bridge.qr_snapshot()
    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet"
    assert snap["key"] == "480M4GnTS7wPfF36"
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:480M4GnTS7wPfF36;;"


def test_hostapd_env_psk_takes_priority_over_persisted_file(
        monkeypatch: pytest.MonkeyPatch, tmp_path):
    # An explicit env PSK is the cleanest source and must win over the file.
    psk_file = tmp_path / "ap-psk"
    psk_file.write_text("file-psk-value99\n")
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        "DROPLET_AP_PSK": "envwins123456",
        "DROPLET_AP_PSK_FILE": str(psk_file),
    })
    snap = bridge.qr_snapshot()
    assert snap["key"] == "envwins123456"


# ---------------------------------------------------------------------------
# auto mode
# ---------------------------------------------------------------------------

def test_auto_mode_picks_hostapd_when_env_ssid_present(
        monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "auto",
        "DROPLET_AP_SSID": "Droplet",
        "DROPLET_AP_PSK": "Droplet123!",
    })
    monkeypatch.setattr(bridge, "openwrt_wifi_credentials",
                        lambda: (_ for _ in ()).throw(
                            AssertionError("UCI path used in auto/hostapd")))
    snap = bridge.qr_snapshot()
    assert snap["ok"] is True
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:Droplet123!;;"


def test_auto_mode_falls_back_to_uci_when_no_hostapd_signal(
        monkeypatch: pytest.MonkeyPatch):
    # auto with no DROPLET_AP_SSID and a router that DOES answer UCI -> the
    # multi-box path is used unchanged.
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "auto"})
    monkeypatch.setattr(bridge, "openwrt_wifi_credentials",
                        lambda: ({"ssid": "Droplet-AI", "key": "droplethome2026",
                                  "encryption": "psk2", "hidden": False,
                                  "disabled": False}, None))
    snap = bridge.qr_snapshot()
    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet-AI"
    # Multi-box payload uses the existing S-before-T builder.
    assert snap["payload"] == "WIFI:S:Droplet-AI;T:WPA;P:droplethome2026;;"


# ---------------------------------------------------------------------------
# multi-box (UCI/SSH) path stays intact — default mode is unchanged
# ---------------------------------------------------------------------------

def test_default_mode_is_uci_multibox(monkeypatch: pytest.MonkeyPatch):
    # No DROPLET_AP_MODE -> back-compat default is the UCI/SSH path.
    bridge = _load_bridge(monkeypatch, {})
    assert bridge.AP_MODE == "uci"
    called = {"uci": False}

    def fake_creds():
        called["uci"] = True
        return ({"ssid": "Droplet-AI", "key": "droplethome2026",
                 "encryption": "psk2", "hidden": False, "disabled": False}, None)

    monkeypatch.setattr(bridge, "openwrt_wifi_credentials", fake_creds)
    snap = bridge.qr_snapshot()
    assert called["uci"] is True
    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet-AI"


def test_multibox_error_path_unchanged(monkeypatch: pytest.MonkeyPatch):
    # Router unreachable on the multi-box path -> ok=false + error, matrix None.
    bridge = _load_bridge(monkeypatch, {})
    monkeypatch.setattr(bridge, "openwrt_wifi_credentials",
                        lambda: (None, "ssh failed"))
    snap = bridge.qr_snapshot()
    assert snap["ok"] is False
    assert snap["matrix"] is None
    assert snap["error"] == "ssh failed"


# ---------------------------------------------------------------------------
# WARP-659 — credential-bearing GET reads (/openwrt/qr, /drives) require the
# bridge shared secret now that BRIDGE_BIND=0.0.0.0 makes them LAN-reachable.
# /wifi /health stay open (no credential material).
# ---------------------------------------------------------------------------

_AUTH = {"X-Droplet-Auth": "pytest-bridge-token"}


def _do_get(bridge, monkeypatch, path, headers):
    """Drive Handler.do_GET for `path`+`headers`, returning (status, body).

    Builds the handler without its socket __init__, stubs the snapshot
    producers (no SSH / no /proc), and captures the single _send call.
    """
    monkeypatch.setattr(bridge, "qr_snapshot",
                        lambda: {"ok": True, "payload": "WIFI:S:Droplet;;",
                                 "ssid": "Droplet"})
    monkeypatch.setattr(bridge, "drives_snapshot",
                        lambda invalidate=False: {"drives": [], "count": 0})
    monkeypatch.setattr(bridge, "wifi_snapshot", lambda: {"networks": []})
    h = bridge.Handler.__new__(bridge.Handler)
    h.headers = headers
    h.path = path
    captured = {}
    h._send = lambda status, obj: captured.update(status=status, body=obj)
    h.do_GET()
    return captured["status"], captured.get("body")


def test_openwrt_qr_requires_token(monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch)
    # No token → 401: a wired/mgmt LAN client can no longer lift the Wi-Fi PSK.
    assert _do_get(bridge, monkeypatch, "/openwrt/qr", {})[0] == 401
    # Correct token → 200 with the QR payload.
    status, body = _do_get(bridge, monkeypatch, "/openwrt/qr", dict(_AUTH))
    assert status == 200
    assert body["ssid"] == "Droplet"


def test_openwrt_qr_rejects_wrong_token(monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch)
    assert _do_get(bridge, monkeypatch, "/openwrt/qr",
                   {"X-Droplet-Auth": "wrong"})[0] == 401


def test_drives_requires_token(monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch)
    assert _do_get(bridge, monkeypatch, "/drives", {})[0] == 401
    assert _do_get(bridge, monkeypatch, "/drives", dict(_AUTH))[0] == 200


def test_open_reads_stay_unauthenticated(monkeypatch: pytest.MonkeyPatch):
    # Non-credential reads must remain reachable without a token: /wifi (a scan
    # of nearby networks) and /health (docker healthcheck).
    bridge = _load_bridge(monkeypatch)
    assert _do_get(bridge, monkeypatch, "/wifi", {})[0] == 200
    assert _do_get(bridge, monkeypatch, "/health", {})[0] == 200


def test_qr_accepts_bearer_token(monkeypatch: pytest.MonkeyPatch):
    # _authed also honors the orchestrator's Authorization: Bearer style.
    bridge = _load_bridge(monkeypatch)
    assert _do_get(bridge, monkeypatch, "/openwrt/qr",
                   {"Authorization": "Bearer pytest-bridge-token"})[0] == 200
