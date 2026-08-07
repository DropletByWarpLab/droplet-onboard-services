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
import json
import urllib.error
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
# WARP-819 — empty-PSK boot race must NOT emit an unscannable (P:;;) QR.
# On first boot the SSID env is set (DROPLET_AP_SSID=Droplet) but the PSK is
# not yet known to the bridge — DROPLET_AP_PSK is absent and the persisted
# 0600 file hasn't been written by droplet-openwrt-attach yet (or is empty).
# Previously hostapd_wifi_credentials() returned {ssid, key:""} in that window,
# so the claim QR encoded `WIFI:T:WPA;S:Droplet;P:;;` — an unjoinable
# empty-passphrase network. The bridge must instead fall through to the live
# hostapd.conf (the value hostapd actually serves); and if THAT is also
# unavailable it must refuse to emit creds (better no QR than a broken one).
# ---------------------------------------------------------------------------

def test_hostapd_empty_env_and_file_psk_falls_through_to_conf(
        monkeypatch: pytest.MonkeyPatch, tmp_path):
    # SSID set, env PSK absent, persisted file empty -> the function must read
    # the live /etc/hostapd.conf rather than emit an empty-passphrase QR.
    psk_file = tmp_path / "ap-psk"
    psk_file.write_text("")  # exists but empty (mid-write / pre-attach race)
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        # No DROPLET_AP_PSK on purpose.
        "DROPLET_AP_PSK_FILE": str(psk_file),
    })

    def fake_run(cmd, timeout=15):
        return 0, _HOSTAPD_CONF, ""

    monkeypatch.setattr(bridge, "_run", fake_run)

    snap = bridge.qr_snapshot()
    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet"
    # The PSK came from hostapd.conf, NOT the empty env/file.
    assert snap["key"] == "Droplet123!"
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:Droplet123!;;"
    # Hard guarantee: never an empty-passphrase QR.
    assert ";P:;;" not in snap["payload"]


def test_hostapd_credentials_falls_through_when_key_empty(
        monkeypatch: pytest.MonkeyPatch, tmp_path):
    # Unit-level: hostapd_wifi_credentials() with SSID-but-no-key must defer to
    # _read_hostapd_conf_creds() rather than return {key: ""}.
    psk_file = tmp_path / "ap-psk"  # absent on disk
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        "DROPLET_AP_PSK_FILE": str(psk_file),
    })
    monkeypatch.setattr(
        bridge, "_read_hostapd_conf_creds",
        lambda: ({"ssid": "Droplet", "key": "fromconf123456",
                  "encryption": "psk2", "hidden": False,
                  "disabled": False}, None))
    creds, err = bridge.hostapd_wifi_credentials()
    assert err is None
    assert creds["key"] == "fromconf123456"


def test_hostapd_empty_psk_everywhere_refuses_qr_no_empty_passphrase(
        monkeypatch: pytest.MonkeyPatch, tmp_path):
    # Worst case during the boot race: SSID set, env+file PSK empty, AND the
    # hostapd.conf read also yields no key (container not up yet). The function
    # must NOT emit {key: ""} — better no QR (ok=false) than a P:;; QR a phone
    # silently joins as an open-but-named network and then can't reach the box.
    psk_file = tmp_path / "ap-psk"  # absent
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        "DROPLET_AP_PSK_FILE": str(psk_file),
    })
    # hostapd.conf parsed but carries an empty wpa_passphrase.
    monkeypatch.setattr(
        bridge, "_read_hostapd_conf_creds",
        lambda: ({"ssid": "Droplet", "key": "",
                  "encryption": "psk2", "hidden": False,
                  "disabled": False}, None))
    snap = bridge.qr_snapshot()
    assert snap["ok"] is False
    assert snap["matrix"] is None
    assert snap["error"]
    # Crucially: no empty-passphrase payload leaked out.
    assert snap["payload"] is None


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


def test_use_hostapd_mode_caches_the_uci_probe(monkeypatch: pytest.MonkeyPatch):
    """WARP-834 findings 2 + 3: in `auto` mode the deployment-shape decision needs
    a UCI SSH probe (an up-to-12s round trip). It must be cached, not reissued on
    every GET /openwrt/qr or Wi-Fi write — otherwise concurrent
    ThreadingHTTPServer callers each block on a fresh probe and open parallel SSH
    sessions. Across repeated calls the probe runs exactly once (within the TTL)."""
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "auto"})
    calls = {"n": 0}

    def counting_creds():
        calls["n"] += 1
        # Router answers → not None → UCI (multi-box) shape.
        return ({"ssid": "Droplet-AI", "key": "k", "encryption": "psk2",
                 "hidden": False, "disabled": False}, None)

    monkeypatch.setattr(bridge, "openwrt_wifi_credentials", counting_creds)
    results = [bridge._use_hostapd_mode() for _ in range(5)]
    assert results == [False] * 5
    assert calls["n"] == 1, f"UCI probe should be cached; ran {calls['n']}x"


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
    # WARP-1800: a local failure now also asks the orchestrator, so stub the
    # socket. Without this the test makes a REAL connection attempt — which is
    # how this surfaced: it started reaching for 127.0.0.1:3000 from a unit
    # test. Any test that drives the failure path has to pin this.
    monkeypatch.setattr(bridge, "_orchestrator_household_wifi",
                        lambda *a, **k: (None, "orchestrator unreachable"))
    snap = bridge.qr_snapshot()
    assert snap["ok"] is False
    assert snap["matrix"] is None
    # Both reasons, local first — the local one is the real fault on a
    # multi-box, and the orchestrator's is the red herring. WARP-1800 widened
    # this string; it used to be the local reason alone.
    assert snap["error"] == "ssh failed / orchestrator unreachable"


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


# ---------------------------------------------------------------------------
# QR error-correction level — the symbol must survive the firmware's mark pad
# ---------------------------------------------------------------------------
# The PyPortal's QR card (_v3_qr_card in pyportal/code.py) paints a 32x32px
# white droplet-mark pad dead-centre over the symbol. At ERROR_CORRECT_L the
# pad corrupts more codewords than Reed-Solomon can recover and the rendered
# card fails to decode for every typical Wi-Fi payload (verified empirically;
# same finding as the scan-to-claim QR in the PR #550 review). _qr_encode
# therefore pins ERROR_CORRECT_Q, degrading to L only when a pathological
# payload would blow the firmware's 64-row tolerance (wifi_qr_matrix
# max_length=64 in main.py).

def test_qr_encode_uses_ecc_q_for_the_mark_pad_overlay(
        monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch)
    # Pin the level via the deterministic version bump: the typical hostapd
    # payload fits v3 (29 modules) at L but needs v4 (33 modules) at Q.
    payload = bridge._hostapd_wifi_payload("Droplet", "abcdefghjkmnpqrs")
    matrix, version = bridge._qr_encode(payload)
    assert version == 4
    assert len(matrix) == 33


def test_qr_encode_typical_payloads_fit_firmware_row_cap(
        monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch)
    typical = (
        # Single-box hostapd shape: fixed WPA, 16-char rotated key.
        bridge._hostapd_wifi_payload("Droplet", "abcdefghjkmnpqrs"),
        # Multi-box UCI shape.
        bridge._wifi_payload("Droplet-AI", "droplethome2026", "psk2"),
        # Worst realistic creds: max-length SSID (32) + WPA2 PSK (63).
        bridge._hostapd_wifi_payload("S" * 32, "p" * 63),
    )
    for payload in typical:
        matrix, _ = bridge._qr_encode(payload)
        assert len(matrix) <= bridge._QR_MAX_ROWS, payload


def test_qr_encode_oversized_payload_degrades_to_l_within_row_cap(
        monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch)
    # A fully-escaped metachar SSID+PSK (~208 chars) needs v13 (69 rows) at
    # Q — over the firmware tolerance. The encoder must fall back to L
    # (v9, 53 rows) rather than ship a panel heap bomb or return nothing.
    payload = bridge._hostapd_wifi_payload(";" * 32, ":" * 63)
    matrix, version = bridge._qr_encode(payload)
    assert len(matrix) <= bridge._QR_MAX_ROWS
    assert version == 9


def _render_panel_qr_card(matrix):
    """Render `matrix` exactly as the firmware's _v3_qr_card does.

    Mirrors pyportal/code.py: a 132x132 white card (System screen card_w),
    inset 9 -> module_px = (132-18)//n, symbol centred, then the 26px
    droplet mark on a +3px white pad (32x32) dead-centre OVER the modules.
    Returns a PIL image upscaled 4x nearest-neighbour (what a phone camera
    resolves; keeps the decoder working on crisp module edges).
    """
    from PIL import Image

    size, inset, mark = 132, 9, 26
    img = Image.new("L", (size, size), 255)
    px = img.load()
    n = len(matrix)
    module_px = max(1, (size - inset * 2) // n)
    origin = (size - module_px * n) // 2
    for i, row in enumerate(matrix):
        for j, bit in enumerate(row):
            if bit:
                for dy in range(module_px):
                    for dx in range(module_px):
                        px[origin + j * module_px + dx,
                           origin + i * module_px + dy] = 0
    pad0 = size // 2 - mark // 2 - 3
    for y in range(pad0, pad0 + mark + 6):
        for x in range(pad0, pad0 + mark + 6):
            px[x, y] = 255
    return img.resize((size * 4, size * 4), Image.NEAREST)


def test_qr_card_with_mark_pad_decodes(monkeypatch: pytest.MonkeyPatch):
    # End-to-end scannability: whatever level _qr_encode picks, the matrix it
    # ships must still decode under the firmware's mark-pad overlay. This is
    # the regression the L-encoded Wi-Fi QR shipped: layout fine, undecodable
    # symbol. zxing-cpp is a dev-only decoder dep; skip where absent.
    zxingcpp = pytest.importorskip("zxingcpp")
    bridge = _load_bridge(monkeypatch)
    payloads = (
        bridge._hostapd_wifi_payload("Droplet", "abcdefghjkmnpqrs"),
        bridge._wifi_payload("Droplet-AI", "droplethome2026", "psk2"),
        bridge._hostapd_wifi_payload("S" * 32, "p" * 63),
    )
    for payload in payloads:
        matrix, _ = bridge._qr_encode(payload)
        result = zxingcpp.read_barcode(_render_panel_qr_card(matrix))
        assert result and result.valid and result.text == payload, payload


# ---------------------------------------------------------------------------
# OpenWrt SSH host-key verification (pr-reviewer finding — multi-box uci path)
# ---------------------------------------------------------------------------
def test_ssh_openwrt_pins_host_key_and_drops_insecure_flags(
    monkeypatch: pytest.MonkeyPatch, tmp_path
):
    """Regression: _ssh_openwrt must VERIFY the router host key.

    The old call passed `StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
    so a LAN MITM on the 192.168.50.x segment could silently capture OPENWRT_PASS
    and inject UCI. It must now pin the key with `accept-new` + a persistent
    known_hosts (OPENWRT_KNOWN_HOSTS), and the insecure flags must be gone.
    """
    known = tmp_path / "openwrt_known_hosts"
    bridge = _load_bridge(
        monkeypatch,
        {
            "OPENWRT_KNOWN_HOSTS": str(known),
            # Empty so the ssh argv isn't wrapped by sshpass — keeps the assert
            # on argv[0] simple.
            "OPENWRT_PASS": "",
        },
    )

    captured: dict = {}

    def fake_run(cmd, timeout=15):
        captured["cmd"] = cmd
        return 0, "ok", ""

    monkeypatch.setattr(bridge, "_run", fake_run)

    rc, _out, _err = bridge._ssh_openwrt("uci show wireless")
    assert rc == 0

    cmd = captured["cmd"]
    joined = " ".join(cmd)
    assert cmd[0] == "ssh"
    assert "StrictHostKeyChecking=accept-new" in cmd
    assert f"UserKnownHostsFile={known}" in cmd
    # The insecure flags must NOT survive anywhere in the argv.
    assert "StrictHostKeyChecking=no" not in joined
    assert "/dev/null" not in joined
    # The known_hosts directory is ensured so accept-new can pin on first use.
    assert known.parent.exists()


# ---------------------------------------------------------------------------
# WARP-1800 — the edge-router shape: neither local source hosts the household
# SSID, so the join code comes from the orchestrator's canonical resolver.
# ---------------------------------------------------------------------------

def _edge_router_bridge(monkeypatch: pytest.MonkeyPatch):
    """A box whose own radio hosts nothing — the real 192.168.9.250 shape.

    Both local sources fail the way they actually fail there: hostapd.conf
    does not exist, and the Pi's UCI holds only a disabled placeholder.
    """
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "uci"})
    monkeypatch.setattr(
        bridge, "openwrt_wifi_credentials",
        lambda: (None, "cat: can't open '/etc/hostapd.conf': No such file"))
    return bridge


def _fake_join_response(monkeypatch, bridge, body: dict, seen: dict):
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps(body).encode()

    def fake_urlopen(req, timeout=None, context=None):
        seen["url"] = req.full_url
        seen["auth"] = req.get_header("Authorization")
        return _Resp()

    monkeypatch.setattr(bridge.urlrequest, "urlopen", fake_urlopen)


def test_edge_router_falls_back_to_the_orchestrator(
        monkeypatch: pytest.MonkeyPatch):
    bridge = _edge_router_bridge(monkeypatch)
    seen: dict = {}
    _fake_join_response(monkeypatch, bridge, {
        "ssid": "Droplet-AI", "key": "7fmqx3rp2kdz9nva",
        "source": "ap", "detail": "Broadcast by the access point.",
    }, seen)

    snap = bridge.qr_snapshot()

    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet-AI"
    assert snap["payload"] == "WIFI:S:Droplet-AI;T:WPA;P:7fmqx3rp2kdz9nva;;"
    assert snap["source"] == "orchestrator"
    assert snap["matrix"], "a scannable matrix, not just a payload string"
    # It must present the service bearer — the route is not public.
    assert seen["auth"] == "Bearer pytest-bridge-token"
    assert seen["url"].endswith("/api/network/wifi/join-code")


def test_the_local_path_never_calls_the_orchestrator(
        monkeypatch: pytest.MonkeyPatch):
    """A box whose own radio IS the household AP must not gain a dependency on
    the orchestrator for a read that already worked."""
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "Droplet",
        "DROPLET_AP_PSK": "Droplet123!",
    })
    monkeypatch.setattr(bridge, "_orchestrator_household_wifi",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("orchestrator used on happy path")))

    snap = bridge.qr_snapshot()
    assert snap["ok"] is True and snap["source"] == "hostapd"
    # The single-box payload order is load-bearing for the pairing flow.
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:Droplet123!;;"


def test_both_reasons_survive_when_neither_source_answers(
        monkeypatch: pytest.MonkeyPatch):
    """On the edge-router shape the LOCAL error is the red herring; on a
    single-box the orchestrator one is. Carry both rather than guessing."""
    bridge = _edge_router_bridge(monkeypatch)

    def boom(req, timeout=None, context=None):
        raise OSError("connection refused")

    monkeypatch.setattr(bridge.urlrequest, "urlopen", boom)

    snap = bridge.qr_snapshot()
    assert snap["ok"] is False
    assert "hostapd.conf" in snap["error"]
    assert "orchestrator unreachable" in snap["error"]
    assert snap["payload"] is None, "never a half-formed answer"


def test_a_rejected_service_token_says_what_to_run(
        monkeypatch: pytest.MonkeyPatch):
    """401 here is a secrets-sync problem, and the person reading it is at a
    rack. "unreachable" would send them debugging the network instead."""
    bridge = _edge_router_bridge(monkeypatch)

    def unauthorized(req, timeout=None, context=None):
        raise urllib.error.HTTPError(
            req.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(bridge.urlrequest, "urlopen", unauthorized)

    creds, err = bridge._orchestrator_household_wifi()
    assert creds is None
    assert "--sync-secrets" in err


def test_a_resolver_with_no_wifi_passes_its_own_reason_through(
        monkeypatch: pytest.MonkeyPatch):
    """The resolver's `detail` is the one field that tells someone at the rack
    what is wrong ("no access point has been approved"). Don't flatten it."""
    bridge = _edge_router_bridge(monkeypatch)
    _fake_join_response(monkeypatch, bridge, {
        "ssid": None, "key": None, "source": None,
        "detail": "no access point has been approved.",
    }, {})

    creds, err = bridge._orchestrator_household_wifi()
    assert creds is None
    assert "no access point has been approved." in err


def test_no_token_means_no_call(monkeypatch: pytest.MonkeyPatch):
    bridge = _edge_router_bridge(monkeypatch)
    monkeypatch.setattr(bridge, "BRIDGE_AUTH_TOKEN", "")
    monkeypatch.setattr(bridge.urlrequest, "urlopen",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("called with no token")))
    creds, err = bridge._orchestrator_household_wifi()
    assert creds is None and "no service token" in err
