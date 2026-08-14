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
    _stub_run(monkeypatch, bridge)

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
    _stub_run(monkeypatch, bridge)
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
    _stub_run(monkeypatch, bridge)
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

# `iw dev` output for a box whose own radio IS hosting `ssid=Droplet` — the
# state every hostapd-mode test below implicitly assumes. WARP-2047 made that
# assumption explicit: the bridge now corroborates locally-read creds against
# the radio before publishing them, so a hostapd test that stubs only the
# hostapd.conf read is describing a box with a config file and no Wi-Fi.
_IW_DEV_DROPLET_AP = """phy#0
\tInterface wlan0
\t\tifindex 4
\t\tssid Droplet
\t\ttype AP
\t\tchannel 6 (2437 MHz), width: 20 MHz
"""


def _stub_run(monkeypatch, bridge, *, conf=None, iw=None, iw_rc=0):
    """Command-aware `_run` stub for the two `docker exec` boundaries.

    `iw dev` and `cat /etc/hostapd.conf` are different questions and tests need
    to answer them independently — a stub that returns one blob for any argv
    lets a hostapd.conf fixture masquerade as radio state. Anything not
    explicitly stubbed raises, so a new shell-out can't slip in unnoticed.

    Returns the recorded argv list.
    """
    calls: list[list[str]] = []

    def fake_run(cmd, timeout=15):
        calls.append(list(cmd))
        if "iw" in cmd:
            if iw_rc != 0:
                return iw_rc, "", "iw: not found"
            return 0, (iw if iw is not None else _IW_DEV_DROPLET_AP), ""
        if conf is not None and any(str(a).endswith("hostapd.conf") for a in cmd):
            return 0, conf, ""
        raise AssertionError("unexpected _run: {}".format(cmd))

    monkeypatch.setattr(bridge, "_run", fake_run)
    return calls


def _conf_was_read(calls) -> bool:
    return any(
        any(str(a).endswith("hostapd.conf") for a in cmd) for cmd in calls)


def test_hostapd_conf_fallback_parses_ssid_and_psk(
        monkeypatch: pytest.MonkeyPatch):
    # No DROPLET_AP_SSID/PSK in env -> bridge must shell out to
    # `docker exec droplet-openwrt cat /etc/hostapd.conf` and parse it.
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "hostapd"})

    calls = _stub_run(monkeypatch, bridge, conf=_HOSTAPD_CONF)

    snap = bridge.qr_snapshot()
    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet"
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:Droplet123!;;"
    # It really did go through the docker-exec hostapd.conf reader.
    conf_cmd = next(
        cmd for cmd in calls
        if any(str(a).endswith("hostapd.conf") for a in cmd))
    assert "docker" in conf_cmd
    assert "/etc/hostapd.conf" in conf_cmd
    assert "droplet-openwrt" in conf_cmd


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
    # and the hostapd.conf reader is never invoked. (Since WARP-2047 the radio
    # IS asked — that is the corroboration step, not a creds source — so the
    # assertion is scoped to the conf read rather than to `docker` generally.)
    bridge = _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": "EnvNet",
        "DROPLET_AP_PSK": "envpass",
    })
    calls = _stub_run(
        monkeypatch, bridge,
        iw="\tInterface wlan0\n\t\tssid EnvNet\n\t\ttype AP\n")

    snap = bridge.qr_snapshot()
    assert snap["ssid"] == "EnvNet"
    assert snap["payload"] == "WIFI:T:WPA;S:EnvNet;P:envpass;;"
    assert not _conf_was_read(calls), "hostapd.conf read despite env creds"


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
    # Must not read hostapd.conf when the persisted file answers.
    calls = _stub_run(monkeypatch, bridge)

    snap = bridge.qr_snapshot()
    assert snap["ok"] is True
    assert snap["ssid"] == "Droplet"
    assert snap["key"] == "480M4GnTS7wPfF36"
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:480M4GnTS7wPfF36;;"
    assert not _conf_was_read(calls), \
        "hostapd.conf read despite persisted PSK file"


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
    _stub_run(monkeypatch, bridge)
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

    _stub_run(monkeypatch, bridge, conf=_HOSTAPD_CONF)

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


# ---------------------------------------------------------------------------
# GET /wifi — the SCAN path is shape-aware too (WARP-1830)
# ---------------------------------------------------------------------------
# WARP-654/834 taught the *credential* path which shape the box is. The *scan*
# path never learned: `wifi_snapshot()` called `scan_via_openwrt()` on every
# shape, so a box with no OpenWrt/UCI router still opened an SSH session to
# OPENWRT_HOST. On the lab box that surfaced as
# `[Errno 2] No such file or directory: 'sshpass'`, which masked the real
# fault — OPENWRT_HOST was still the multi-box default 192.168.50.1, an
# address that does not exist behind the Pi.

def _no_nmcli(monkeypatch, bridge):
    """Pin the host fallback to "no Wi-Fi adapter here" so these tests describe
    the OpenWrt branch only. Without this the result depends on whether the
    machine running pytest happens to have nmcli."""
    monkeypatch.setattr(bridge, "scan_via_nmcli", lambda: (None, {}))


def _explodes(what: str):
    return lambda *a, **k: (_ for _ in ()).throw(AssertionError(what))


def test_a_box_with_no_uci_router_never_opens_an_ssh_scan(
        monkeypatch: pytest.MonkeyPatch):
    """The single-box/edge-router shapes have no router to ask. Reaching for
    SSH there is not a degraded read, it is the wrong question."""
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "hostapd"})
    monkeypatch.setattr(bridge, "scan_via_openwrt",
                        _explodes("SSH scan attempted with no UCI router"))
    _no_nmcli(monkeypatch, bridge)

    snap = bridge.wifi_snapshot()

    assert snap["state"] == "not-applicable"
    assert snap["networks"] == []
    # Not an error: a box whose Wi-Fi is served by an external AP is behaving
    # correctly. `error` is for faults, and a fault here would be a lie.
    assert snap["error"] is None


def test_the_no_router_state_says_why_at_the_rack(
        monkeypatch: pytest.MonkeyPatch):
    """`state` alone tells the panel to render empty; `detail` is what tells a
    person standing at the rack that empty is the CORRECT answer here."""
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "hostapd"})
    _no_nmcli(monkeypatch, bridge)

    detail = bridge.wifi_snapshot()["detail"] or ""

    assert "access point" in detail.lower()
    assert "sshpass" not in detail


def test_a_host_adapter_still_wins_on_a_routerless_box(
        monkeypatch: pytest.MonkeyPatch):
    """Skipping the SSH scan must not skip the *host* scan: a routerless box
    that really does have a managed radio should still report it."""
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "hostapd"})
    monkeypatch.setattr(bridge, "scan_via_openwrt",
                        _explodes("SSH scan attempted with no UCI router"))
    monkeypatch.setattr(bridge, "scan_via_nmcli", lambda: (
        [{"ssid": "Home", "signal": 62, "security": "WPA2",
          "connected": True, "bssid": ""}],
        {"adapter": "wlp10s0", "state": "connected", "connected_to": "Home"}))

    snap = bridge.wifi_snapshot()

    assert snap["source"] == "host-nmcli"
    assert snap["state"] == "connected"
    assert snap["connected_to"] == "Home"


def test_the_multibox_ssh_scan_is_left_alone(monkeypatch: pytest.MonkeyPatch):
    """Regression guard: on a real multi-box the router IS the right thing to
    ask, and this change must be invisible there."""
    bridge = _load_bridge(monkeypatch, {})          # default AP_MODE == "uci"
    monkeypatch.setattr(bridge, "scan_via_openwrt", lambda: (
        [{"ssid": "Droplet-AI", "signal": 71, "security": "psk2",
          "connected": False, "bssid": "aa:bb:cc:dd:ee:ff"}], None))
    monkeypatch.setattr(bridge, "_openwrt_connected_ssid", lambda: "Droplet-AI")

    snap = bridge.wifi_snapshot()

    assert snap["source"] == "openwrt"
    assert snap["state"] == "connected"
    assert snap["adapter"] == bridge.OPENWRT_IFACE
    assert snap["networks"][0]["ssid"] == "Droplet-AI"


def test_a_missing_sshpass_reads_as_a_missing_package(
        monkeypatch: pytest.MonkeyPatch):
    """On a shape that SHOULD reach the router, a missing `sshpass` is a real
    fault — but "[Errno 2] ... 'sshpass'" reads like a missing config file.
    `sshpass` is in no Dockerfile, install script or package manifest in this
    repo, so name the actual remedy."""
    bridge = _load_bridge(monkeypatch, {})          # UCI shape
    monkeypatch.setattr(bridge, "OPENWRT_PASS", "router-password")
    monkeypatch.setattr(bridge.shutil, "which", lambda _name: None)
    monkeypatch.setattr(bridge, "_run",
                        _explodes("subprocess spawned with no sshpass"))
    _no_nmcli(monkeypatch, bridge)

    snap = bridge.wifi_snapshot()

    assert snap["state"] == "unavailable"
    assert "sshpass" in (snap["error"] or "")
    assert "not installed" in (snap["error"] or "")


def test_key_based_ssh_does_not_need_sshpass(monkeypatch: pytest.MonkeyPatch):
    """With no OPENWRT_PASS the bridge already uses a plain key-based `ssh`
    argv. The missing-binary guard must not fire on that path."""
    bridge = _load_bridge(monkeypatch, {})
    monkeypatch.setattr(bridge, "OPENWRT_PASS", "")
    monkeypatch.setattr(bridge.shutil, "which", lambda _name: None)
    seen = {}

    def _capture(cmd, timeout=15):
        seen["argv"] = cmd
        return 0, "", ""

    monkeypatch.setattr(bridge, "_run", _capture)
    bridge._ssh_openwrt("uci show wireless")

    assert seen["argv"][0] == "ssh"


# ---------------------------------------------------------------------------
# The local hostapd creds must be CORROBORATED by a live BSS before the panel
# advertises them.
#
# Live failure this reproduces (droplet-sys, 2026-08-14): the bridge's own env
# said DROPLET_AP_SSID=Warp / DROPLET_AP_PSK=Droplet123!, the container's
# hostapd.conf said ssid=Droplet-AI, and the household AP was broadcasting
# "Warp" under a completely different passphrase. The panel rendered
# `WIFI:T:WPA;S:Warp;P:Droplet123!;;` — a QR naming a real network with the
# wrong password, so every phone that scanned it failed to authenticate. The
# box's radio was in `type managed` and droplet-openwrt-attach had exited 1, so
# there was no local BSS at all.
#
# hostapd_wifi_credentials() documents its sources as "coherent with what
# hostapd serves". Nothing enforced that, and the env had drifted.
# ---------------------------------------------------------------------------

_IW_DEV_AP_UP = """phy#1
\tInterface phy01-0
\t\tifindex 17
\t\taddr 80:ea:0b:39:ae:26
\t\tssid Droplet
\t\ttype AP
\t\tchannel 36 (5180 MHz), width: 80 MHz
phy#0
\tInterface phy00-0
\t\tifindex 16
\t\taddr 80:ea:0b:39:ae:25
\t\tssid Droplet
\t\ttype AP
\t\tchannel 6 (2437 MHz), width: 20 MHz
"""

# The real droplet-sys output: the radio is a STATION and the P2P-device has no
# ssid at all. Nothing is being beaconed.
_IW_DEV_NO_AP = """phy#0
\tInterface wlp10s0
\t\tifindex 3
\t\twdev 0x1
\t\taddr f4:28:9d:d2:1d:db
\t\ttype managed
\t\ttxpower 3.00 dBm
\tUnnamed/non-netdev interface
\t\twdev 0x2
\t\taddr f6:28:9d:d2:1d:db
\t\ttype P2P-device
\t\ttxpower 3.00 dBm
"""


def _stub_iw(monkeypatch, bridge, rc: int, out: str, err: str = ""):
    """`_stub_run` scoped to the radio probe — no hostapd.conf arm at all.

    These tests are about the corroboration step, so a conf read here would be
    an unexpected shell-out and must raise rather than quietly answer.
    """
    return _stub_run(monkeypatch, bridge, iw=out, iw_rc=rc)


def _hostapd_box(monkeypatch, ssid="Warp", psk="Droplet123!"):
    return _load_bridge(monkeypatch, {
        "DROPLET_AP_MODE": "hostapd",
        "DROPLET_AP_SSID": ssid,
        "DROPLET_AP_PSK": psk,
    })


def test_no_local_bss_refuses_the_env_creds_and_asks_the_orchestrator(
        monkeypatch: pytest.MonkeyPatch):
    """The exact droplet-sys shape: env creds present, nothing on the air.

    The env is not evidence. The household answer has to come from the
    orchestrator's canonical resolver instead.
    """
    bridge = _hostapd_box(monkeypatch)
    _stub_iw(monkeypatch, bridge, 0, _IW_DEV_NO_AP)
    seen: dict = {}
    _fake_join_response(monkeypatch, bridge, {
        "ssid": "Warp", "key": "Warp123!", "source": "ap",
        "detail": "Broadcast by the access point.",
    }, seen)

    snap = bridge.qr_snapshot()

    assert snap["ok"] is True
    assert snap["source"] == "orchestrator", "the stale local env must not win"
    # The AP's REAL passphrase, not the bridge env's stale one.
    assert snap["key"] == "Warp123!"
    assert "Droplet123!" not in snap["payload"]


def test_no_local_bss_and_no_approved_ap_emits_no_qr_at_all(
        monkeypatch: pytest.MonkeyPatch):
    """droplet-sys as it actually stands: nothing local, no AP approved yet.

    A blank rail with a reason is the honest answer. An unjoinable QR is worse
    than no QR — the owner blames the Wi-Fi, not the missing setup step.
    """
    bridge = _hostapd_box(monkeypatch)
    _stub_iw(monkeypatch, bridge, 0, _IW_DEV_NO_AP)
    _fake_join_response(monkeypatch, bridge, {
        "ssid": None, "key": None, "source": None,
        "detail": "No Wi-Fi is being broadcast yet — this Droplet's radio "
                  "isn't hosting a network and no access point has been "
                  "approved.",
    }, {})

    snap = bridge.qr_snapshot()

    assert snap["ok"] is False
    assert snap["payload"] is None and snap["matrix"] is None
    # Both halves of the story survive: the local radio is idle AND no AP is
    # approved. Either alone sends someone debugging the wrong layer.
    assert "not hosting a network" in snap["error"]
    assert "no access point has been approved" in snap["error"]
    # Never echo the passphrase we just refused to trust.
    assert "Droplet123!" not in snap["error"]


def test_a_configured_ssid_absent_from_the_air_is_refused(
        monkeypatch: pytest.MonkeyPatch):
    """A BSS is up, but under a different name than the env claims.

    That proves the env drifted, which makes its PASSPHRASE untrustworthy too —
    so this is a refusal, not a silent SSID substitution.
    """
    bridge = _hostapd_box(monkeypatch, ssid="Warp")
    # On the air as "Droplet" — what the attach script actually wrote.
    _stub_iw(monkeypatch, bridge, 0, _IW_DEV_AP_UP)
    _fake_join_response(monkeypatch, bridge, {
        "ssid": "Droplet", "key": "realpsk123456", "source": "ap",
    }, {})

    snap = bridge.qr_snapshot()

    assert snap["source"] == "orchestrator"
    assert snap["ssid"] == "Droplet"


def test_a_live_bss_corroborates_the_local_creds(
        monkeypatch: pytest.MonkeyPatch):
    """The single-box happy path stays local, keeps its payload byte-order and
    never gains an orchestrator dependency."""
    bridge = _hostapd_box(monkeypatch, ssid="Droplet", psk="Droplet123!")
    _stub_iw(monkeypatch, bridge, 0, _IW_DEV_AP_UP)
    monkeypatch.setattr(bridge, "_orchestrator_household_wifi",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("orchestrator used on happy path")))

    snap = bridge.qr_snapshot()

    assert snap["ok"] is True and snap["source"] == "hostapd"
    assert snap["payload"] == "WIFI:T:WPA;S:Droplet;P:Droplet123!;;"


def test_an_unrunnable_probe_keeps_the_local_answer(
        monkeypatch: pytest.MonkeyPatch):
    """"Could not ask" is not "nothing is there".

    An install where `docker exec`/`iw` is unavailable must keep working exactly
    as it did — failing closed here would blank the QR on boxes whose hotspot is
    genuinely up. Same discipline as the AP fan-out's `apsNotReporting`: a
    degraded read never renders as a confident zero.
    """
    bridge = _hostapd_box(monkeypatch, ssid="Droplet", psk="Droplet123!")
    _stub_iw(monkeypatch, bridge, 127, "", "iw: not found")
    monkeypatch.setattr(bridge, "_orchestrator_household_wifi",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("unknown probe must not fall through")))

    snap = bridge.qr_snapshot()

    assert snap["ok"] is True and snap["source"] == "hostapd"


def test_the_bss_probe_is_cached_across_polls(
        monkeypatch: pytest.MonkeyPatch):
    """The panel polls this endpoint continuously; one `docker exec` per poll
    would be a self-inflicted load bug — the WARP-834 finding that gave
    _use_hostapd_mode its TTL."""
    bridge = _hostapd_box(monkeypatch, ssid="Droplet", psk="Droplet123!")
    calls = _stub_iw(monkeypatch, bridge, 0, _IW_DEV_AP_UP)

    bridge.qr_snapshot()
    bridge.qr_snapshot()
    bridge.qr_snapshot()

    assert len(calls) == 1, "expected one cached probe, got {}".format(len(calls))


def test_uci_mode_never_probes_the_local_radio(
        monkeypatch: pytest.MonkeyPatch):
    """The guard is about the box's OWN hostapd. On the UCI/SSH shape the creds
    already come from the router that hosts the network, so a local radio probe
    there would be a second opinion about someone else's AP."""
    bridge = _load_bridge(monkeypatch, {"DROPLET_AP_MODE": "uci"})
    monkeypatch.setattr(bridge, "openwrt_wifi_credentials", lambda: ({
        "ssid": "Droplet", "key": "routerpsk1234", "encryption": "psk2",
        "hidden": False, "disabled": False,
    }, None))

    def no_run(cmd, timeout=15):
        raise AssertionError("uci mode must not shell out: {}".format(cmd))

    monkeypatch.setattr(bridge, "_run", no_run)

    snap = bridge.qr_snapshot()
    assert snap["ok"] is True and snap["source"] == "uci"


# --- the iw parser ----------------------------------------------------------

def test_iw_parser_reads_only_ap_mode_interfaces(
        monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch, {})
    assert bridge._parse_iw_dev_ap_ssids(_IW_DEV_AP_UP) == {"Droplet"}
    assert bridge._parse_iw_dev_ap_ssids(_IW_DEV_NO_AP) == set()
    assert bridge._parse_iw_dev_ap_ssids("") == set()


def test_iw_parser_does_not_leak_an_ssid_across_interface_blocks(
        monkeypatch: pytest.MonkeyPatch):
    """`ssid` prints BEFORE `type`, so a scan that doesn't reset per interface
    carries one block's SSID into the next and invents an AP.

    This is not hypothetical on a Droplet: the box's Wi-Fi leg runs as a STATION
    joined to the household network (`type managed`, and it therefore HAS an
    ssid), and the AP interface that follows may have none while it is down.
    A leaking parser then reports the upstream network as the box's own hotspot
    and the panel publishes a QR for someone else's Wi-Fi.
    """
    bridge = _load_bridge(monkeypatch, {})
    station_then_downed_ap = (
        "phy#0\n"
        "\tInterface wlp10s0\n\t\tssid HomeNet-5G\n\t\ttype managed\n"
        "\tInterface ap0\n\t\ttype AP\n"
    )
    assert bridge._parse_iw_dev_ap_ssids(station_then_downed_ap) == set()

    # ...and the reverse order must still report the one real AP.
    ap_then_station = (
        "phy#0\n"
        "\tInterface ap0\n\t\tssid Droplet\n\t\ttype AP\n"
        "\tInterface wlp10s0\n\t\tssid HomeNet-5G\n\t\ttype managed\n"
    )
    assert bridge._parse_iw_dev_ap_ssids(ap_then_station) == {"Droplet"}


def test_iw_parser_keeps_ssids_with_spaces(monkeypatch: pytest.MonkeyPatch):
    bridge = _load_bridge(monkeypatch, {})
    out = "\tInterface ap0\n\t\tssid My Home Net\n\t\ttype AP\n"
    assert bridge._parse_iw_dev_ap_ssids(out) == {"My Home Net"}
