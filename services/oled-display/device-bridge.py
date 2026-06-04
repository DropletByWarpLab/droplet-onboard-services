"""
Droplet device-bridge — host-side HTTP API for the on-device screen.

Runs on the Jetson host (outside the oled-display container). Exposes a
stable read-only API the display service polls, with each endpoint
sourcing live data from the appropriate upstream:

  GET  /wifi           -> OpenWrt iwinfo scan (SSH), fallback to host nmcli
  GET  /openwrt/qr     -> OpenWrt's LAN SSID + PSK encoded as a WiFi QR
                          matrix + payload (status display renders the grid)
  GET  /files          -> file-indexer / orchestrator storage snapshot
  GET  /cameras        -> Frigate recent events + online camera count
  POST /wifi/connect   -> join an SSID (nmcli fallback path)
  GET  /health         -> liveness

All network calls have short timeouts with graceful degradation — an
upstream being down never takes the bridge down; the display UI shows
a "waiting for X" state instead.
"""

import datetime
import hmac
import json
import logging
import os
import secrets
import shlex
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest
from urllib.parse import unquote, urlparse

logger = logging.getLogger("droplet.bridge")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

OPENWRT_HOST      = os.environ.get("OPENWRT_HOST", "192.168.50.1")
OPENWRT_USER      = os.environ.get("OPENWRT_USER", "root")
OPENWRT_PASS      = os.environ.get("OPENWRT_PASS", "")
OPENWRT_IFACE     = os.environ.get("OPENWRT_IFACE", "wlan0")
SSH_TIMEOUT       = int(os.environ.get("SSH_CONNECT_TIMEOUT", "4"))

# Access-point credentials source for the pairing QR. The two shipping
# deployment shapes broadcast the AP differently:
#
#   uci      — multi-box: a Pi-5 OpenWrt router holds the AP in UCI
#              (`wireless.*`). We read SSID+PSK over SSH (the historical
#              path). This is the back-compat default.
#   hostapd  — single-box: the host runs a raw hostapd AP via the
#              `droplet-openwrt-attach` script (no UCI), so we read the
#              creds from DROPLET_AP_SSID/DROPLET_AP_PSK (set by that
#              script) and fall back to parsing /etc/hostapd.conf inside
#              the droplet-openwrt container.
#   auto     — pick `hostapd` when DROPLET_AP_SSID is set OR when UCI
#              wireless is empty/unreachable; otherwise `uci`. Lets a
#              single image serve both shapes without per-box env edits.
#
# Defaulting to `uci` keeps every existing multi-box install behaving
# exactly as before; single-box installs set DROPLET_AP_MODE=hostapd in
# /etc/droplet/device-bridge.env.
AP_MODE           = os.environ.get("DROPLET_AP_MODE", "uci").strip().lower()
AP_SSID           = os.environ.get("DROPLET_AP_SSID", "").strip()
AP_PSK            = os.environ.get("DROPLET_AP_PSK", "")
# Container that runs the single-box hostapd AP. Its /etc/hostapd.conf is
# the fallback creds source when DROPLET_AP_SSID isn't set in the env.
AP_HOSTAPD_CONTAINER = os.environ.get(
    "DROPLET_AP_CONTAINER", "droplet-openwrt").strip()
AP_HOSTAPD_CONF_PATH = os.environ.get(
    "DROPLET_AP_HOSTAPD_CONF", "/etc/hostapd.conf").strip()

FRIGATE_URL       = os.environ.get("FRIGATE_URL", "http://127.0.0.1:5000")
ORCHESTRATOR_URL  = os.environ.get("ORCHESTRATOR_URL", "http://127.0.0.1:3000")
FILES_ROOT        = os.environ.get("FILES_ROOT", "/home/droplet/Documents/droplet-onboard-services/.data/files")

BRIDGE_PORT       = int(os.environ.get("BRIDGE_PORT", "9090"))
# Bind host — default loopback so the bridge is only reachable from the
# oled-display container (which shares the host's network namespace) and
# other local services. Public/LAN exposure is a clear footgun: /wifi/connect
# would let any LAN neighbor force-join arbitrary SSIDs. Override with
# BRIDGE_BIND=0.0.0.0 only if you're putting an auth layer in front.
BRIDGE_BIND       = os.environ.get("BRIDGE_BIND", "127.0.0.1")

# Wi-Fi key rotation. OFF by default in production — rotating the key
# kicks every joined station, so a phone that's set to "auto-connect
# when I get home" stops working after each rotation. Operators who
# want key rotation (shared office deployments, visitor kiosks, etc.)
# can flip WIFI_KEY_ROTATION_ENABLED=true in the bridge env file.
ROTATION_ENABLED = os.environ.get(
    "WIFI_KEY_ROTATION_ENABLED", "false").lower() in ("1", "true", "yes", "on")
ROTATION_INTERVAL_S = int(os.environ.get(
    "WIFI_KEY_ROTATION_INTERVAL_SECONDS", str(24 * 3600)))

# Persisted state (survives bridge restarts; not the router).
# systemd creates /var/lib/droplet-bridge via StateDirectory= with 0700
# perms under the bridge user; if that's absent (dev install / container),
# fall back to /tmp with 0600 on the file. Either way the state contains
# only timestamps + a sha256 digest of the current wifi key — never the
# cleartext, so an accidentally-world-readable state file doesn't leak the
# passphrase.
STATE_FILE = os.environ.get(
    "BRIDGE_STATE_FILE", "/var/lib/droplet-bridge/state.json")
if not os.access(os.path.dirname(STATE_FILE) or "/", os.W_OK):
    STATE_FILE = "/tmp/droplet-bridge-state.json"

# Shared-secret auth for mutating endpoints. Primary source is
# BRIDGE_AUTH_TOKEN, populated by install-device-bridge.sh from
# SERVICE_TOKEN_DISPLAY in the repo .env (WARP-165). Older installs may
# still have DEVICE_SECRET_KEY / SERVICE_SECRET as the bridge token —
# we keep those as fallbacks so a bridge that hasn't been re-installed
# yet still authenticates correctly against an orchestrator that's also
# still on the old token. The next `sudo ./scripts/install-device-bridge.sh`
# run rotates the bridge env to SERVICE_TOKEN_DISPLAY.
#
# Even with the bridge bound to loopback, any unprivileged process on
# the inference host could currently POST to /openwrt/wifi/rotate or
# /wifi/connect — requiring the token moves that capability from
# "anyone with a shell" to "anyone with the secret".
BRIDGE_AUTH_TOKEN = (
    os.environ.get("BRIDGE_AUTH_TOKEN")
    or os.environ.get("SERVICE_TOKEN_DISPLAY")
    or os.environ.get("DEVICE_SECRET_KEY")
    or os.environ.get("SERVICE_SECRET")
    or ""
).strip()

# Minimum seconds between wifi-key rotations. Stops a stuck client or a
# fat-fingered human from bouncing hostapd repeatedly (each rotation kicks
# every associated station). 30s is long enough that the new QR is live
# and scanned before a second rotation is allowed; short enough that a
# legit "oops, didn't scan fast enough" retry works fine.
ROTATION_MIN_INTERVAL_S = int(os.environ.get(
    "WIFI_KEY_ROTATION_MIN_INTERVAL_SECONDS", "30"))

# In-process lock: only one rotation at a time (an SSH+UCI+wifi-up run
# takes ~4s and the HTTP server is threaded).
_ROTATION_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Shell helper
# ---------------------------------------------------------------------------

def _run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:                                          # noqa: BLE001
        return 1, "", str(e)


# ---------------------------------------------------------------------------
# OpenWrt via SSH
# ---------------------------------------------------------------------------

# Shared "find the live AP wifi-iface" shell snippet. Sets $target to the
# uci section name of the first mode=ap + enabled + parent-radio-enabled
# wifi-iface. Bails with exit 1 if nothing matches. Reused by the creds
# lookup and the key rotation.
_FIND_AP_SH = r'''
target=""
# uci show prints "<section-path>=wifi-iface" for each anonymous/named
# wifi-iface. No quotes around the section type on OpenWrt 24.10, so
# match the bare suffix.
for s in $(uci show wireless 2>/dev/null | grep '=wifi-iface$' | cut -d= -f1); do
    mode=$(uci -q get "$s.mode" || true)
    if_dis=$(uci -q get "$s.disabled" || echo 0)
    radio=$(uci -q get "$s.device" || echo "")
    rad_dis=$(uci -q get "wireless.$radio.disabled" || echo 0)
    if [ "$mode" = "ap" ] && [ "$if_dis" != "1" ] && [ "$rad_dis" != "1" ]; then
        target=$s
        break
    fi
done
if [ -z "$target" ]; then echo "ERR no active AP" >&2; exit 1; fi
'''


def _ssh_openwrt(remote_cmd, timeout=20):
    ssh_args = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", f"ConnectTimeout={SSH_TIMEOUT}",
        "-o", "LogLevel=ERROR",
        f"{OPENWRT_USER}@{OPENWRT_HOST}",
        remote_cmd,
    ]
    if OPENWRT_PASS:
        cmd = ["sshpass", "-p", OPENWRT_PASS] + ssh_args
    else:
        cmd = ssh_args
    return _run(cmd, timeout=timeout)


def _parse_iwinfo(text):
    networks = []
    cur = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("Cell "):
            if cur:
                networks.append(cur)
            cur = {"ssid": "", "signal": 0, "security": "Open",
                   "connected": False, "bssid": ""}
        if cur is None:
            continue
        if line.startswith("ESSID:"):
            cur["ssid"] = line.split(":", 1)[1].strip().strip('"')
        elif line.startswith("Address:"):
            cur["bssid"] = line.split(":", 1)[1].strip()
        elif "Quality:" in line:
            try:
                q = line.split("Quality:")[1].strip().split()[0]
                num, den = q.split("/")
                cur["signal"] = int(round(int(num) * 100 / int(den)))
            except Exception:
                pass
        elif line.startswith("Encryption:"):
            enc = line.split(":", 1)[1].strip()
            cur["security"] = "Open" if enc.lower().startswith("none") else enc.split(" ")[0]
    if cur:
        networks.append(cur)
    return networks


def scan_via_openwrt():
    rc, out, err = _ssh_openwrt(f"iwinfo {shlex.quote(OPENWRT_IFACE)} scan",
                                timeout=25)
    if rc != 0:
        return None, (err.strip() or "iwinfo failed")
    networks = _parse_iwinfo(out)
    networks.sort(key=lambda n: -n["signal"])
    seen = set()
    deduped = []
    for n in networks:
        if not n["ssid"] or n["ssid"] in seen:
            continue
        seen.add(n["ssid"])
        deduped.append(n)
    return deduped, None


def openwrt_wifi_credentials():
    """Read the active AP's SSID + WPA key from UCI.

    "Active" = wifi-iface with mode=ap AND iface-level disabled!=1 AND
    its parent radio also not disabled. This matters on the router host
    where the first 4 radios (radio0..3) may be `disabled '1'` because
    only the Wi-Fi radio on radio4 actually works as an AP — without
    the radio-level check we'd hand the dashboard the stale default
    'Droplet/ChangeMe!2024' creds from default_radio0 that are never on
    the air.
    """
    script = _FIND_AP_SH + (
        "ssid=$(uci -q get \"$target.ssid\"); "
        "key=$(uci -q get \"$target.key\"); "
        "enc=$(uci -q get \"$target.encryption\"); "
        "hid=$(uci -q get \"$target.hidden\" || echo 0); "
        "disabled=$(uci -q get \"$target.disabled\" || echo 0); "
        "printf 'SSID=%s\\nKEY=%s\\nENC=%s\\nHID=%s\\nDISABLED=%s\\nSECTION=%s\\n' "
        "  \"$ssid\" \"$key\" \"$enc\" \"$hid\" \"$disabled\" \"$target\""
    )
    rc, out, err = _ssh_openwrt(script, timeout=12)
    if rc != 0:
        return None, (err.strip() or "ssh failed")
    creds = {"ssid": "", "key": "", "encryption": "none",
             "hidden": False, "disabled": False}
    for line in out.splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip()
        if k == "SSID":
            creds["ssid"] = v
        elif k == "KEY":
            creds["key"] = v
        elif k == "ENC":
            creds["encryption"] = v or "none"
        elif k == "HID":
            creds["hidden"] = v == "1"
        elif k == "DISABLED":
            creds["disabled"] = v == "1"
    if not creds["ssid"]:
        return None, "no ssid on router"
    return creds, None


def _openwrt_connected_ssid():
    """Return the SSID the router is currently broadcasting (active AP).

    Uses the same _FIND_AP_SH helper as openwrt_wifi_credentials so we
    can't return the stale default_radio0 "Droplet" name on the router
    host where only one radio actually runs as an AP. STA-mode lookup
    (client mode) stays first for the rare deployment where OpenWrt is
    an upstream client.
    """
    script = (
        "sta=$(uci -q get wireless.sta.ssid 2>/dev/null || true); "
        "if [ -n \"$sta\" ]; then printf '%s\\n' \"$sta\"; exit 0; fi; "
        + _FIND_AP_SH +
        "uci -q get \"$target.ssid\""
    )
    rc, out, _ = _ssh_openwrt(script, timeout=6)
    return (out.strip() or None) if rc == 0 else None


# ---------------------------------------------------------------------------
# Single-box hostapd AP credentials
# ---------------------------------------------------------------------------
# The single-box deployment shape runs a raw hostapd AP on the host (via the
# droplet-openwrt-attach script) instead of OpenWrt/UCI. There's no router to
# SSH into and `uci show wireless` is empty, so the multi-box creds lookup
# returns "no active AP" and the pairing QR comes back blank (WARP-654).
#
# Creds come from DROPLET_AP_SSID / DROPLET_AP_PSK (the host env the attach
# script already sets). When those aren't set we parse /etc/hostapd.conf out
# of the droplet-openwrt container, which is hostapd's own source of truth.

def _parse_hostapd_conf(text):
    """Parse SSID + WPA passphrase from a hostapd.conf body.

    hostapd.conf is a flat `key=value` file. We only need `ssid` and
    `wpa_passphrase`. Values may be quoted and/or carry surrounding
    whitespace; both are stripped. Returns (creds, err) mirroring
    openwrt_wifi_credentials() so the QR builder treats both shapes the
    same. The encryption is reported as "psk2" (WPA2-PSK) — the mode the
    attach script configures — so the shared QR/security plumbing keys off
    a WPA marker, identical to the UCI path.
    """
    ssid = key = None
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"')
        if k == "ssid" and ssid is None:
            ssid = v
        elif k == "wpa_passphrase" and key is None:
            key = v
    if not ssid:
        return None, "no ssid in hostapd.conf"
    return ({
        "ssid": ssid,
        "key": key or "",
        "encryption": "psk2",
        "hidden": False,
        "disabled": False,
    }, None)


def _read_hostapd_conf_creds():
    """Read the hostapd AP creds from the droplet-openwrt container.

    `docker exec <container> cat /etc/hostapd.conf` then parse. Read-only —
    never mutates the container. Returns (creds, err)."""
    rc, out, err = _run(
        ["docker", "exec", AP_HOSTAPD_CONTAINER, "cat", AP_HOSTAPD_CONF_PATH],
        timeout=8)
    if rc != 0:
        return None, (err.strip() or "hostapd.conf unreadable")
    return _parse_hostapd_conf(out)


def hostapd_wifi_credentials():
    """Return the single-box hostapd AP's SSID + PSK.

    Source order: the host env (DROPLET_AP_SSID/DROPLET_AP_PSK — cleanest,
    set by droplet-openwrt-attach) first, then /etc/hostapd.conf inside the
    droplet-openwrt container. Returns (creds, err) with the same dict shape
    as openwrt_wifi_credentials()."""
    if AP_SSID:
        return ({
            "ssid": AP_SSID,
            "key": AP_PSK or "",
            "encryption": "psk2",
            "hidden": False,
            "disabled": False,
        }, None)
    return _read_hostapd_conf_creds()


def _hostapd_wifi_payload(ssid, key):
    """Format the WiFi QR payload for a WPA hostapd AP.

    hostapd's single-box AP is always WPA2-PSK, so the security type is a
    fixed `WPA`. Field order is T;S;P (the order the single-box pairing
    flow + PyPortal firmware expect). Escapes the WiFi-QR metacharacters
    (\\, ;, ,, :, ") per the de-facto standard so an SSID/PSK containing
    them still scans correctly.
    """
    def esc(s):
        return (s or "").replace("\\", "\\\\").replace(";", "\\;") \
                        .replace(",", "\\,").replace(":", "\\:") \
                        .replace('"', '\\"')

    return "WIFI:T:WPA;S:{};P:{};;".format(esc(ssid), esc(key))


def _use_hostapd_mode():
    """Decide whether to source the QR creds from hostapd vs. UCI.

    - hostapd  -> always hostapd.
    - uci      -> always UCI/SSH (back-compat default).
    - auto     -> hostapd when a DROPLET_AP_SSID is configured (a clear
                  single-box signal) OR when UCI wireless is empty/
                  unreachable; otherwise UCI.
    """
    if AP_MODE == "hostapd":
        return True
    if AP_MODE == "auto":
        if AP_SSID:
            return True
        # No explicit single-box signal — probe UCI. If the router answers
        # with a live AP, stay on the multi-box path; otherwise fall through
        # to hostapd (covers a single-box host where uci is empty).
        creds, _err = openwrt_wifi_credentials()
        return creds is None
    return False


# ---------------------------------------------------------------------------
# Jetson-local nmcli fallback
# ---------------------------------------------------------------------------

def scan_via_nmcli():
    rc, out, _ = _run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION",
                       "device", "status"], timeout=6)
    if rc != 0:
        return None, {}
    dev, connected, state = None, None, None
    for line in out.strip().splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[1] == "wifi":
            dev = parts[0]
            state = parts[2]
            connected = parts[3] if len(parts) > 3 and parts[3] else None
            break
    if not dev:
        return None, {}
    _run(["nmcli", "device", "wifi", "rescan"], timeout=10)
    rc, out, _ = _run(["nmcli", "-t", "-e", "no", "-f",
                       "IN-USE,SSID,SIGNAL,SECURITY",
                       "device", "wifi", "list", "ifname", dev],
                      timeout=20)
    if rc != 0:
        return None, {}
    seen = set()
    networks = []
    for line in out.strip().splitlines():
        parts = line.split(":")
        if len(parts) < 4:
            continue
        ssid = parts[1]
        if not ssid or ssid in seen:
            continue
        seen.add(ssid)
        try:
            sig = int(parts[2])
        except ValueError:
            sig = 0
        networks.append({
            "ssid": ssid, "signal": sig,
            "security": parts[3] or "Open",
            "connected": parts[0] == "*", "bssid": "",
        })
    networks.sort(key=lambda n: -n["signal"])
    return networks, {"adapter": dev, "state": state,
                      "connected_to": connected}


def wifi_snapshot():
    out = {
        "networks": [], "source": None, "adapter": None,
        "connected_to": None, "state": "unknown",
        "scanned_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "error": None,
    }
    networks, err = scan_via_openwrt()
    if networks is not None:
        out["networks"] = networks[:20]
        out["source"] = "openwrt"
        out["adapter"] = OPENWRT_IFACE
        out["connected_to"] = _openwrt_connected_ssid()
        out["state"] = "connected" if out["connected_to"] else "ready"
        return out
    out["error"] = err
    nets, meta = scan_via_nmcli()
    if nets is not None and meta:
        out["networks"] = nets[:20]
        out["source"] = "host-nmcli"
        out["adapter"] = meta.get("adapter")
        out["state"] = meta.get("state") or "unknown"
        out["connected_to"] = meta.get("connected_to")
        return out
    out["state"] = "unavailable"
    return out


# ---------------------------------------------------------------------------
# Wi-Fi QR code
# ---------------------------------------------------------------------------
# Pure-Python QR encoder.
# Handles the subset we actually need: WIFI payload strings, byte mode,
# error-correction level L, auto version bump. No external deps.

def _wifi_payload(ssid, key, encryption):
    """Format a WiFi:...; QR payload per the de-facto standard."""
    sec = "nopass"
    enc = (encryption or "").lower()
    if any(k in enc for k in ("wpa3", "wpa2", "wpa", "psk", "sae")):
        sec = "WPA"
    elif "wep" in enc:
        sec = "WEP"

    def esc(s):
        return (s or "").replace("\\", "\\\\").replace(";", "\\;") \
                        .replace(",", "\\,").replace(":", "\\:") \
                        .replace('"', '\\"')

    return "WIFI:S:{};T:{};P:{};;".format(esc(ssid), sec,
                                           esc(key) if sec != "nopass" else "")


def _qr_encode(text):
    """Generate a QR code bit-matrix for `text` using the `qrcode` lib
    (apt: python3-qrcode). Returns (matrix, version)."""
    import qrcode
    from qrcode.constants import ERROR_CORRECT_L
    q = qrcode.QRCode(
        error_correction=ERROR_CORRECT_L,
        border=0,       # we pad on the display side
        box_size=1,
    )
    q.add_data(text)
    q.make(fit=True)
    matrix = [[1 if cell else 0 for cell in row] for row in q.get_matrix()]
    return matrix, q.version


def qr_snapshot():
    """Fetch the live AP wifi creds and return a QR-matrix + payload.

    Sources creds from whichever deployment shape this box is (DROPLET_AP_MODE):
    the single-box hostapd AP or the multi-box OpenWrt/UCI router. The returned
    dict shape is identical for both so the PyPortal client is shape-agnostic.

    TTL/interval fields: rotation is only available on the UCI/SSH path, so
    `ttl_seconds` is populated (and `rotation_interval_seconds` added) only
    when rotation is enabled there. In hostapd mode rotation is always
    disabled — there's no UCI to push a new PSK to — so `rotation_enabled` is
    forced false and `ttl_seconds` is 0; the PyPortal gates its Rotate pill on
    `rotation_enabled` and the countdown chip on a non-zero TTL.
    """
    hostapd = _use_hostapd_mode()
    rotation_enabled = False if hostapd else ROTATION_ENABLED
    out = {
        "ok": False, "ssid": None, "security": None, "hidden": False,
        "disabled": False, "payload": None, "matrix": None,
        "version": None, "error": None,
        "rotation_enabled": rotation_enabled,
        # Always present so the client never has to branch on its absence;
        # 0 means "no expiry" (the production posture in both shapes unless
        # UCI-mode rotation is explicitly enabled).
        "ttl_seconds": 0,
    }
    if rotation_enabled:
        out["ttl_seconds"] = _key_ttl_seconds()
        out["rotation_interval_seconds"] = ROTATION_INTERVAL_S

    if hostapd:
        creds, err = hostapd_wifi_credentials()
    else:
        creds, err = openwrt_wifi_credentials()
    if creds is None:
        out["error"] = err or ("hostapd AP unavailable" if hostapd
                               else "router unreachable")
        return out

    if hostapd:
        # Single-box hostapd AP is WPA2-PSK; use the fixed-security T;S;P
        # payload the single-box pairing flow expects.
        payload = _hostapd_wifi_payload(creds["ssid"], creds["key"])
    else:
        payload = _wifi_payload(creds["ssid"], creds["key"], creds["encryption"])
    try:
        matrix, ver = _qr_encode(payload)
    except Exception as e:                                           # noqa: BLE001
        out["error"] = "qr encode failed: {}".format(e)
        return out
    out.update({
        "ok": True, "ssid": creds["ssid"],
        "security": "WPA" if hostapd else creds["encryption"],
        "hidden": creds["hidden"],
        "disabled": creds["disabled"], "payload": payload,
        # Cleartext key is already inside `payload` (the phone QR scanner
        # reads it from there), so exposing it as a dedicated field costs
        # nothing extra but lets the status display render it legibly
        # under the QR without parsing the payload. Endpoint is
        # loopback-only and auth-gated for mutating routes.
        "key": creds["key"],
        "matrix": matrix, "version": ver,
    })
    return out


# ---------------------------------------------------------------------------
# Wi-Fi key rotation — on-demand passphrase change via UCI + wifi reload
# ---------------------------------------------------------------------------

# Avoid visually-confusable characters (0/O, 1/l/I). 30^16 ≈ 78 bits of
# entropy, plenty for a WPA2/WPA3 passphrase, and every char is easy to
# key in manually if the QR won't scan.
_KEY_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
_KEY_FIRST_CHAR = "23456789"   # subset of the alphabet — digits only
_KEY_LEN = 16


def _gen_passphrase():
    """Generate a 16-char random wifi passphrase.

    First char is forced to a digit so iOS / Android password fields
    don't auto-capitalize it. Auto-cap is silent — users who type a
    lowercase key like `gpz…` end up submitting `Gpz…` and get a PSK
    mismatch with no obvious cause. Starting with a digit sidesteps the
    whole problem; entropy loss is trivial (log2 30^16 → log2 8 + log2
    30^15 ≈ 77.6 bits, still well past any practical WPA2 attack).
    """
    head = secrets.choice(_KEY_FIRST_CHAR)
    tail = "".join(secrets.choice(_KEY_ALPHABET) for _ in range(_KEY_LEN - 1))
    return head + tail


def _load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _save_state(s):
    """Persist bridge state atomically with tight perms.

    Writes to a temp file then renames so a crash mid-write can't leave a
    truncated state file. 0600 on the file unconditionally; 0700 on the
    parent dir only if it looks like a dedicated bridge dir (not a shared
    system dir like /tmp — tightening /tmp to 0700 would kill the host
    if the bridge ever ran as root).
    """
    try:
        d = os.path.dirname(STATE_FILE)
        if d:
            os.makedirs(d, exist_ok=True)
            # Only tighten perms on a dir we own. Matching on basename
            # catches the systemd StateDirectory (droplet-bridge) and
            # any override the operator sets via BRIDGE_STATE_FILE as
            # long as it points into a dedicated folder; shared dirs
            # like /tmp or /var/tmp are left alone.
            base = os.path.basename(d.rstrip("/"))
            if base and base not in ("tmp", "var", "run", ""):
                try:
                    os.chmod(d, 0o700)
                except Exception:
                    pass
        tmp = STATE_FILE + ".tmp"
        old_umask = os.umask(0o077)
        try:
            with open(tmp, "w") as f:
                json.dump(s, f)
            os.replace(tmp, STATE_FILE)
            try:
                os.chmod(STATE_FILE, 0o600)
            except Exception:
                pass
        finally:
            os.umask(old_umask)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("bridge state save failed: %s", e)


def _key_ttl_seconds():
    """Seconds until the next scheduled rotation window — for the QR UI."""
    at = _load_state().get("wifi_key_rotated_at")
    if not at:
        return 0
    elapsed = time.time() - float(at)
    return max(0, int(ROTATION_INTERVAL_S - elapsed))


# Shell script that rotates the active AP's key.
# - Passes the new key in via environment (NEW_KEY) so it never lands in
#   the process list or UCI audit logs as a command argument.
# - Uses the shared _FIND_AP_SH helper so we always target the same
#   wifi-iface the creds lookup does.
_ROTATE_SH = "set -e\n" + _FIND_AP_SH + r'''
old_ssid=$(uci -q get "$target.ssid" || echo "")
radio=$(uci -q get "$target.device" || echo "")
uci set "$target.key=$NEW_KEY"
uci commit wireless
# `wifi reload` regenerates /var/run/hostapd-*.conf but on OpenWrt 24.10
# doesn't always force hostapd to pick up a changed PSK — we've seen
# AP-STA-POSSIBLE-PSK-MISMATCH for minutes after a reload because the
# old hostapd process keeps serving the stale config. A targeted
# `wifi down/up` on just the affected radio respawns hostapd cleanly
# without bouncing any other radio, and finishes in <1s.
if [ -n "$radio" ]; then
    wifi down "$radio" >/dev/null 2>&1 || true
    sleep 1
    wifi up "$radio" >/dev/null 2>&1 || true
else
    wifi reload >/dev/null 2>&1 || true
fi
printf 'OK %s %s\n' "$target" "$old_ssid"
'''


def rotate_wifi_key():
    """Generate a new passphrase, push to OpenWrt via UCI, return status.

    The full key is never returned by this endpoint — callers get the fresh
    QR via /openwrt/qr on the next request. That keeps the cleartext off
    curl logs / HTTP access logs while still letting the phone scan it.
    """
    # Serialize concurrent rotations. Two threads racing here would
    # double-cycle hostapd and possibly interleave UCI writes.
    if not _ROTATION_LOCK.acquire(blocking=False):
        return False, "rotation already in progress"
    try:
        # Rate-limit: reject if we just rotated. The min interval defends
        # against both stuck clients (retrying every frame) and fat-finger
        # double-clicks from the status display.
        st = _load_state()
        last = st.get("wifi_key_rotated_at") or 0
        elapsed = time.time() - float(last)
        if last and elapsed < ROTATION_MIN_INTERVAL_S:
            return False, ("rate_limited: wait {}s".format(
                int(ROTATION_MIN_INTERVAL_S - elapsed)))

        new_key = _gen_passphrase()
        # Encode the key into the remote env via `NEW_KEY='...'` sh prelude.
        # Alphabet excludes ', \, $, so single-quoting is safe; we still
        # double-check by refusing anything outside the alphabet.
        if any(c not in _KEY_ALPHABET for c in new_key):
            return False, "generated key failed alphabet check"
        prelude = "NEW_KEY={} ".format(shlex.quote(new_key))
        script = prelude + "sh -c " + shlex.quote(_ROTATE_SH)
        rc, out, err = _ssh_openwrt(script, timeout=25)
        if rc != 0:
            msg = (err.strip() or out.strip() or "ssh/uci failed")
            logger.warning("wifi rotate failed: %s", msg)
            return False, msg
        first = (out.strip().splitlines() or [""])[0]
        st["wifi_key_rotated_at"] = time.time()
        # Key digest only — never the cleartext. Truncated to 16 hex chars
        # so it fits comfortably in logs without being useful for brute
        # force (still 2^64 search space).
        import hashlib
        st["wifi_key_digest"] = hashlib.sha256(new_key.encode()).hexdigest()[:16]
        _save_state(st)
        logger.info("wifi key rotated: %s digest=%s",
                    first, st["wifi_key_digest"])
        return True, {
            "message": first, "rotated_at": st["wifi_key_rotated_at"],
            "interval_seconds": ROTATION_INTERVAL_S,
            "key_digest": st["wifi_key_digest"],
        }
    finally:
        _ROTATION_LOCK.release()


# ---------------------------------------------------------------------------
# Files (local tree walk + orchestrator storage endpoint if present)
# ---------------------------------------------------------------------------

_files_cache = {"snapshot": None, "at": 0}


def files_snapshot():
    now = time.time()
    if _files_cache["snapshot"] and now - _files_cache["at"] < 30:
        return _files_cache["snapshot"]

    total_files = 0
    total_size = 0
    recent = []  # (mtime, name, size)
    try:
        for root, dirs, files in os.walk(FILES_ROOT):
            for name in files:
                p = os.path.join(root, name)
                try:
                    st = os.stat(p)
                except Exception:
                    continue
                total_files += 1
                total_size += st.st_size
                recent.append((st.st_mtime, name, st.st_size))
                if len(recent) > 200:
                    recent.sort(reverse=True)
                    recent = recent[:20]
    except Exception as e:                                          # noqa: BLE001
        pass

    recent.sort(reverse=True)
    recent = recent[:5]

    # Ask orchestrator for sync state (best-effort, no auth required for
    # /api/health; if /api/storage needs auth we fall back silently).
    sync_state = None
    try:
        with urlrequest.urlopen(
                ORCHESTRATOR_URL + "/api/health", timeout=3) as r:
            body = json.loads(r.read().decode())
            sync_state = {
                "orchestrator": body.get("status"),
                "uptime": body.get("uptime"),
            }
    except Exception:
        pass

    snap = {
        "root": FILES_ROOT,
        "count": total_files,
        "size_bytes": total_size,
        "recent": [
            {"name": n, "size": sz,
             "modified": datetime.datetime.fromtimestamp(m, tz=datetime.timezone.utc)
                               .strftime("%Y-%m-%dT%H:%M:%SZ")}
            for m, n, sz in recent
        ],
        "orchestrator": sync_state,
        "snapshot_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _files_cache["snapshot"] = snap
    _files_cache["at"] = now
    return snap


# ---------------------------------------------------------------------------
# Cameras — Frigate recent events + camera-discovery
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Drives (USB auto-mount)
# ---------------------------------------------------------------------------

_drives_cache = {"snap": None, "at": 0}


def _bytes_for(path):
    """Return (total, used, free) in bytes for a mounted path."""
    try:
        st = os.statvfs(path)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        return total, total - free, free
    except Exception:
        return 0, 0, 0


def _bus_for(device):
    """Real bus transport for a block device — read from the kernel via lsblk,
    not guessed from the device name. A SATA disk is `/dev/sd*` too, so the old
    name heuristic mislabeled SATA/SAS data drives as 'usb'; ADR-011 forbids
    that kind of hardware assumption.

    lsblk reports TRAN on the *whole disk*, not the partition, so resolve the
    parent (PKNAME) first, then read its transport. Returns the kernel's own
    label (sata/usb/nvme/sas/scsi/mmc/virtio); falls back to a name heuristic
    only if lsblk is unavailable. Presentation only (card icon + connection
    chip) — NEVER an eject/mount/security gate; that's `removable`.
    """
    base = os.path.basename(device or "")
    if not base:
        return "disk"
    try:
        _rc, pk, _e = _run(["lsblk", "-ndo", "PKNAME", device], timeout=4)
        parent = (pk or "").strip().splitlines()
        parent = parent[0].strip() if parent else ""
        target = "/dev/" + parent if parent else device
        _rc, tr, _e = _run(["lsblk", "-ndo", "TRAN", target], timeout=4)
        rows = (tr or "").strip().splitlines()
        tran = rows[0].strip().lower() if rows else ""
        if tran in ("sata", "usb", "nvme", "sas", "scsi", "mmc", "virtio"):
            return tran
    except Exception:                                              # noqa: BLE001
        pass
    # Fallback — no lsblk / odd device. Stay neutral for sd* rather than
    # guessing USB (it could be SATA/SAS).
    if base.startswith("nvme"):
        return "nvme"
    if base.startswith("mmcblk"):
        return "mmc"
    return "disk"


# WARP-612: SMART health + temperature. OFF by default — smartctl spins up
# disks and adds a subprocess per drive, which we don't want on the 10s drive
# poll. Operators opt in with DRIVE_SMART_ENABLED=true; results are cached per
# device for 5 min so even then smartctl isn't hammered. Best-effort: any
# failure (smartctl absent, not root, a USB bridge without SAT passthrough)
# yields (None, None) and the dashboard simply hides the SMART/temp chips.
SMART_ENABLED = os.environ.get(
    "DRIVE_SMART_ENABLED", "false").lower() in ("1", "true", "yes", "on")
_smart_cache = {}  # device -> (checked_at, health, temp_c)
_SMART_TTL_S = 300


def _smart_for(device):
    """Return (health, temp_c) for a device. health is 'PASSED'/'FAILED'/None;
    temp_c is an int °C or None. Gated by DRIVE_SMART_ENABLED, cached 5 min,
    never raises."""
    if not SMART_ENABLED or not device:
        return None, None
    now = time.time()
    hit = _smart_cache.get(device)
    if hit and now - hit[0] < _SMART_TTL_S:
        return hit[1], hit[2]
    health = None
    temp = None
    # `-j` (JSON) so we read the canonical fields instead of scraping columns:
    # `temperature.current` is the real °C, and `smart_status.passed` is an
    # unambiguous bool. The old `-A` text scrape took the first plausible int on
    # the Temperature_Celsius row — usually the *normalized* value (~100), not
    # the raw temperature, so the chip showed the wrong number.
    _rc, out, _err = _run(["smartctl", "-j", "-H", "-A", device], timeout=8)
    try:
        data = json.loads(out or "{}")
        passed = data.get("smart_status", {}).get("passed")
        if passed is True:
            health = "PASSED"
        elif passed is False:
            health = "FAILED"
        cur = data.get("temperature", {}).get("current")
        if isinstance(cur, int) and 0 < cur < 120:  # plausible drive temp in °C
            temp = cur
    except (ValueError, AttributeError):
        pass  # non-JSON output (smartctl absent / too old) → no SMART chips
    _smart_cache[device] = (now, health, temp)
    return health, temp


# Filesystem types we consider "data storage" worth surfacing in the UI.
# Excludes tmpfs, devtmpfs, cgroup, overlay, squashfs, procfs, sysfs, etc.
_DATA_FSTYPES = {"ext4", "ext3", "ext2", "xfs", "btrfs", "f2fs",
                 "vfat", "exfat", "ntfs", "ntfs3", "zfs"}

# Mount points we deliberately hide from the dashboard:
#   /mnt/droplet — a shared-mount root (bind of /) created by the
#                  automount installer so hot-plug mounts can propagate
#                  into the Nextcloud container. Its device is the
#                  eMMC root (mmcblk0p1), so surfacing it would show
#                  the OS install as a "drive" — confusing for users.
# Hot-plug children at /mnt/droplet/<label-uuid> are still included.
_EXCLUDED_MOUNT_POINTS = {"/mnt/droplet"}

# Ignore trivially small filesystems (< 100 MB) like CIRCUITPY flash
# drives on microcontrollers (the status display, etc.) that technically
# mount but aren't user storage.
_MIN_DRIVE_BYTES = 100 * 1024 * 1024


def _label_and_uuid_for(device):
    """Look up filesystem LABEL and UUID for a device path via /dev/disk/by-*.

    Pure filesystem walk — no subprocess, no blkid dependency — so this
    stays cheap on every poll.
    """
    label = uuid = ""
    try:
        real = os.path.realpath(device)
        for by, attr in (("/dev/disk/by-label", "label"),
                         ("/dev/disk/by-uuid", "uuid")):
            if not os.path.isdir(by):
                continue
            for name in os.listdir(by):
                if os.path.realpath(os.path.join(by, name)) == real:
                    if attr == "label":
                        label = name.replace("\\x20", " ")
                    else:
                        uuid = name
                    break
    except Exception:
        pass
    return label, uuid


# /proc/mounts octal-escapes whitespace + backslash in the mount path
# (space -> \040, tab -> \011, newline -> \012, backslash -> \134). Unescape so
# the keys/paths match the real ones the automount state file + statvfs use;
# backslash is decoded last so an escaped backslash can't swallow the digits
# of a following escape.
def _unescape_mount(path: str) -> str:
    return (
        path.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
    )


def drives_snapshot(invalidate=False):
    """Return every 'data' drive mounted on /mnt/*, from both the automount
    state file (hot-plug USB/NVMe) and /proc/mounts (fstab-installed
    storage like /mnt/cameras and /mnt/cloud-storage). Deduplicates by
    mount point when both sources report the same drive.
    """
    now = time.time()
    if not invalidate and _drives_cache["snap"] and now - _drives_cache["at"] < 10:
        return _drives_cache["snap"]

    by_mount = {}  # mount-point -> entry, so state + /proc/mounts merge cleanly

    # Filesystem type + read-only flag per mount, parsed once from
    # /proc/mounts so both the automount and fstab branches below can
    # annotate their entries (fs/readonly) without a second pass or a
    # blkid subprocess. Read-only — never mutates anything.
    mount_meta = {}  # mount-point -> (fstype, readonly)
    try:
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 4:
                    # Key on the unescaped path so lookups by the real mount
                    # point (automount state / statvfs) match even when the path
                    # contains a space or other escaped char.
                    mount_meta[_unescape_mount(parts[1])] = (
                        parts[2],
                        "ro" in parts[3].split(","),
                    )
    except Exception:
        pass

    # 1) Hot-plug automount state (authoritative label/uuid for USB drives)
    state_path = "/var/lib/droplet-automount/mounts.json"
    try:
        with open(state_path) as f:
            state = json.load(f)
        for m in state.get("mounts", []):
            mp = m.get("mount")
            if not mp:
                continue
            # Skip stale entries: automount may have recorded a mount that
            # has since been unmounted (e.g. the drive was reformatted and
            # remounted by fstab at a different path). The /proc/mounts
            # pass below will pick up the current location if any.
            if not os.path.ismount(mp):
                continue
            total, used, free = _bytes_for(mp)
            # Fail SAFE on a /proc/mounts miss: report read-only, never a false
            # "writable". The UI renders mount status from this flag and the
            # deferred eject/fsck work will trust it — for a data-integrity-first
            # product an unknown state must not present as writable.
            fs, readonly = mount_meta.get(mp, ("", True))
            smart, temp = _smart_for(m.get("device"))  # one smartctl pass, not two
            by_mount[mp] = {
                "device": m.get("device"),
                "mount": mp,
                "label": m.get("label") or "",
                "uuid": m.get("uuid") or "",
                "size_bytes": total,
                "used_bytes": used,
                "free_bytes": free,
                "mounted": True,
                "fs": fs,
                "bus": _bus_for(m.get("device")),
                "readonly": readonly,
                "smart": smart,
                "temp_c": temp,
                # Hot-plug auto-mounted → removable/ejectable regardless of bus.
                "removable": True,
                "source": "automount",
            }
    except Exception:
        pass

    # 2) Installed storage from /proc/mounts: any real-fs mount on /mnt/*
    # that isn't already covered by automount state. Covers fstab-mounted
    # NVMe/SATA partitions that never go through the udev hot-plug path.
    try:
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                dev, mp, fs = parts[0], _unescape_mount(parts[1]), parts[2]
                if not mp.startswith("/mnt/"):
                    continue
                if fs not in _DATA_FSTYPES:
                    continue
                if mp in by_mount:
                    continue  # automount state already has it
                if mp in _EXCLUDED_MOUNT_POINTS:
                    continue
                # Zombie mounts: /proc/mounts keeps the entry even after a
                # USB drive is yanked without a clean unmount, and statvfs
                # on such a path falls through to the parent filesystem
                # (so a pulled USB device reports eMMC root size instead).
                # Skip if the backing block device is gone.
                if dev.startswith("/dev/") and not os.path.exists(dev):
                    continue
                total, used, free = _bytes_for(mp)
                if total < _MIN_DRIVE_BYTES:
                    continue
                label, uuid = _label_and_uuid_for(dev)
                smart, temp = _smart_for(dev)  # one smartctl pass, not two
                by_mount[mp] = {
                    "device": dev,
                    "mount": mp,
                    "label": label,
                    "uuid": uuid,
                    "size_bytes": total,
                    "used_bytes": used,
                    "free_bytes": free,
                    "mounted": True,
                    "fs": fs,
                    "bus": _bus_for(dev),
                    # Same fail-safe default as the automount branch above.
                    "readonly": mount_meta.get(mp, (fs, True))[1],
                    "smart": smart,
                    "temp_c": temp,
                    # Installed (fstab) storage — not hot-plug, not ejectable.
                    "removable": False,
                    "source": "fstab",
                }
    except Exception:
        pass

    # Stable order: fstab first (usually the big data drives), then
    # automount (hot-plug), each group sorted by mount path for a
    # predictable on-screen list.
    mounts = sorted(by_mount.values(),
                    key=lambda d: (d["source"] != "fstab", d["mount"]))

    snap = {
        "drives": mounts,
        "count": len(mounts),
        "snapshot_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _drives_cache["snap"] = snap
    _drives_cache["at"] = now
    return snap


def _device_at_mountpoint(mountpoint):
    """The backing device the kernel currently has mounted at `mountpoint`, or
    None. Reads /proc/mounts (the kernel's source of truth) so a tampered
    automount state file can't misrepresent what is actually mounted where."""
    try:
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and _unescape_mount(parts[1]) == mountpoint:
                    return parts[0]
    except Exception:                                               # noqa: BLE001
        pass
    return None


def eject_drive(uuid):
    """Safely unmount + forget a hot-plug auto-mounted drive by FS UUID
    (WARP-612). Bus-agnostic per ADR-011 — works for USB, external NVMe, SD,
    SATA docks, anything the automounter mounted.

    Guarded hard — only ever acts on a drive that (a) is in the automount
    state file and (b) is mounted under /mnt/droplet/<…>. Internal/boot disks
    and fstab-installed mounts are never in that set, so they are never
    ejectable. Does not use `umount -l`: a busy drive should fail loudly so the
    user closes files and retries, not silently lazy-unmount.
    Returns (ok, message_or_dict). Never raises.
    """
    if not uuid:
        return False, "missing uuid"
    state_path = "/var/lib/droplet-automount/mounts.json"
    try:
        with open(state_path) as f:
            state = json.load(f)
    except Exception as e:                                          # noqa: BLE001
        return False, "automount state unreadable: {}".format(e)
    mounts = state.get("mounts", [])
    target = next((m for m in mounts if (m.get("uuid") or "") == uuid), None)
    if not target:
        return False, "no hot-plug drive with that uuid"
    mp = (target.get("mount") or "").rstrip("/")
    # Bus-agnostic (ADR-011): any hot-plug drive the automounter placed under
    # /mnt/droplet/ is ejectable — USB, external NVMe, SD, SATA dock, etc.
    # System/boot disks are never in the automount state, so membership + the
    # /mnt/droplet/ prefix is the gate; bus is irrelevant.
    #
    # Defense in depth: the automount state file is writable state, so a
    # malformed/poisoned entry must not be able to redirect the umount. Resolve
    # symlinks/traversal and re-check the prefix on the real path; require it to
    # actually be a mountpoint now; and confirm the kernel has the *expected*
    # device mounted there (/proc/mounts) before touching anything.
    real_mp = os.path.realpath(mp)
    if not real_mp.startswith("/mnt/droplet/") or real_mp == "/mnt/droplet":
        return False, "refusing to eject a non-/mnt/droplet mount"
    if not os.path.ismount(real_mp):
        return False, "drive is not currently mounted"
    expected_dev = target.get("device") or ""
    actual_dev = _device_at_mountpoint(real_mp)
    if (
        expected_dev
        and actual_dev
        and os.path.realpath(actual_dev) != os.path.realpath(expected_dev)
    ):
        return False, "mount/device mismatch — refusing to eject"
    _run(["sync"], timeout=10)
    rc, _out, err = _run(["umount", real_mp], timeout=20)
    if rc != 0:
        return False, (err.strip() or "umount failed — the drive may be in use")
    # Forget it so the next snapshot drops it. umount already succeeded, so a
    # write failure here only leaves a stale entry that self-heals (the next
    # snapshot skips it via the os.path.ismount check).
    state["mounts"] = [m for m in mounts if (m.get("uuid") or "") != uuid]
    try:
        tmp = state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, state_path)
    except Exception as e:                                          # noqa: BLE001
        logger.warning(
            "eject: failed to rewrite automount state (%s); the stale entry "
            "self-heals on the next snapshot via the ismount check", e
        )
    drives_snapshot(invalidate=True)
    return True, {"ejected": uuid, "mount": mp}


# ---------------------------------------------------------------------------
# Storage pools (mdadm software RAID) — READ-ONLY (BUG-3 / ADR-019)
# ---------------------------------------------------------------------------
# Reads /proc/mdstat (+ mdadm --detail --scan) and maps the raw md state onto
# the ADR-019 explicit enums. NEVER mutates an array — create/destroy/format
# live behind the auth-gated destructive POST (run_pool_command) which shells
# the repo-tracked host script, never mdadm directly. Returns [] honestly when
# md has no arrays (the owner's "no fake pool" constraint at the read layer).

_pools_cache = {"snap": None, "at": 0}

# md raid token (from /proc/mdstat) -> ADR-019 ArrayLevel enum value.
_MD_LEVEL_MAP = {
    "raid0": "raid0",
    "raid1": "raid1",
    "raid4": "raid5",   # raid4 is a parity variant; surface as raid5-class
    "raid5": "raid5",
    "raid6": "raid6",
    "raid10": "raid10",
    "linear": "jbod",   # md calls JBOD/concat "linear"
}


def _array_level_from_md(token):
    """Map a raw md raid token to an ADR-019 ArrayLevel value.

    Unknown tokens fall back to 'jbod' (the safest "we don't model this as
    real RAID" bucket) rather than guessing a parity level."""
    return _MD_LEVEL_MAP.get((token or "").strip().lower(), "jbod")


def _pool_status_from_md(md_state, health_block, resyncing=False):
    """Map raw md status onto an ADR-019 PoolStatus value.

    - resyncing (a rebuild/resync line present) wins over everything — the
      array is being repaired right now.
    - an inactive/failed/empty md_state is `failed`.
    - a `[U_U]`-style health block with any '_' (a down member) is `degraded`.
    - an all-`U` (or absent) health block on an active array is `active`.

    Always returns one of the five explicit enum values, never a raw md string
    (rule 10 — the dashboard branches on the enum, never parses mdstat)."""
    state = (md_state or "").strip().lower()
    if resyncing:
        return "resyncing"
    if state in ("inactive", "failed", "broken", ""):
        return "failed"
    if "_" in (health_block or ""):
        return "degraded"
    return "active"


def _parse_mdstat(text):
    """Parse /proc/mdstat into a list of pool dicts.

    Each entry: {device, level, status, members:[bare disk names]}. The status
    is an explicit PoolStatus enum value (never a raw md string). A trailing
    `resync`/`recovery` progress line on a device flips it to `resyncing`.

    Pure text parsing — no subprocess — so it's cheap and host-independent
    (the fixture-driven tests feed it canned mdstat text)."""
    pools = []
    current = None
    for raw in (text or "").splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        # Device header lines start at column 0 and look like
        #   "md0 : active raid1 sdb[1] sda[0]"
        if line and not line[0].isspace() and " : " in line:
            name, _, rest = line.partition(" : ")
            name = name.strip()
            if not name.startswith("md"):
                current = None
                continue
            toks = rest.split()
            # toks[0] = md_state (active/inactive/...), toks[1] = raid token
            md_state = toks[0] if toks else ""
            level_token = ""
            members = []
            for t in toks[1:]:
                if t.startswith("raid") or t == "linear":
                    level_token = t
                    continue
                # member entries look like "sdb[1]" / "nvme0n1[0]" / with (S)/(F)
                base = t.split("[")[0]
                if base and base not in ("level",):
                    members.append(base)
            current = {
                "device": name,
                "_md_state": md_state,
                "level": _array_level_from_md(level_token),
                "members": members,
                "_health": "",
                "_resyncing": False,
            }
            pools.append(current)
            continue
        if current is None:
            continue
        # Continuation lines (indented): capture the [U_U] health block and
        # any resync/recovery progress marker.
        if "[" in stripped and "]" in stripped:
            # The health block is the last [..] token made only of U/_ chars.
            for chunk in stripped.replace("]", "] ").split():
                inner = chunk.strip("[]")
                if inner and set(inner) <= {"U", "_"}:
                    current["_health"] = "[" + inner + "]"
        low = stripped.lower()
        if "resync" in low or "recovery" in low or "rebuild" in low:
            current["_resyncing"] = True

    # Finalise: compute the explicit status, drop internal scratch fields.
    out = []
    for p in pools:
        status = _pool_status_from_md(p["_md_state"], p["_health"], p["_resyncing"])
        out.append({
            "device": p["device"],
            "level": p["level"],
            "status": status,
            "members": p["members"],
        })
    return out


def _read_mdstat():
    """Return the raw /proc/mdstat text, or None if md isn't present on this
    host. Read-only. Isolated so tests can feed canned text without a real
    md stack."""
    try:
        with open("/proc/mdstat") as f:
            return f.read()
    except Exception:                                               # noqa: BLE001
        return None


def pools_snapshot(invalidate=False):
    """Return {pools, count, snapshot_at} for the md arrays on this host.

    READ-ONLY. Returns an empty list honestly when md has no arrays (or no md
    at all) — it NEVER synthesises a pool from loose drives. Cached ~10s like
    the drives snapshot so the front panel / dashboard poll is cheap."""
    now = time.time()
    if not invalidate and _pools_cache["snap"] and now - _pools_cache["at"] < 10:
        return _pools_cache["snap"]

    pools = _parse_mdstat(_read_mdstat())
    snap = {
        "pools": pools,
        "count": len(pools),
        "snapshot_at": datetime.datetime.now(datetime.timezone.utc)
                              .strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _pools_cache["snap"] = snap
    _pools_cache["at"] = now
    return snap


# Destructive pool operations the bridge will forward to the host script.
# This is an allow-list — anything else is refused before we shell out. These
# are Tier-3-class (data-destroying); they are owner-only + confirm-token-gated
# at the orchestrator and reach this bridge route only with the bridge auth
# token. The bridge NEVER runs mdadm/mkfs itself; the host script does, behind
# its own hard pre-flight.
_POOL_OPS = frozenset({
    "pool_create",
    "pool_destroy",
    "pool_format",
    "pool_set_level",
    "pool_add_spare",
    "pool_remove_disk",
})

# Path to the repo-tracked host script, installed by setup.sh via
# install-device-bridge.sh. Overridable for tests / non-standard installs.
POOL_SCRIPT = os.environ.get(
    "DROPLET_POOL_SCRIPT", "/usr/local/sbin/droplet-storage-pool.sh").strip()


def run_pool_command(operation, params):
    """Forward an owner-confirmed destructive pool op to the host script.

    The bridge does NOT run mdadm/mkfs — it execs droplet-storage-pool.sh,
    passing the operation and the params as a single JSON argument. The host
    script's hard pre-flight (refuse if a target disk is mounted / holds data /
    is the OS disk; require the typed double-confirm) is the real safety gate;
    this function only (a) refuses operations outside the allow-list and (b)
    surfaces the script's exit code honestly. Returns (ok, info); never raises
    — mirrors eject_drive()."""
    if operation not in _POOL_OPS:
        return False, "unknown pool operation: {}".format(operation)
    payload = json.dumps(params or {})
    try:
        # The host script runs `mdadm`/`mkfs` which can take a while on a large
        # array; allow a generous timeout but still bounded.
        rc, out, err = _run([POOL_SCRIPT, operation, payload], timeout=600)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("pool command %s failed to exec host script: %s",
                       operation, e)
        return False, "host script unavailable"
    if rc != 0:
        msg = (err.strip() or out.strip() or "host script refused")
        logger.warning("pool command %s refused/failed (rc=%s): %s",
                       operation, rc, msg)
        return False, msg
    # Invalidate the pools cache so the next GET /pools reflects the change.
    pools_snapshot(invalidate=True)
    try:
        return True, json.loads(out or "{}")
    except (ValueError, TypeError):
        return True, {"message": (out or "").strip()}


def cameras_snapshot():
    out = {
        "online": 0, "total": 0, "events": [],
        "source": None, "error": None,
        "snapshot_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    # Try Frigate first — it's the source of truth for motion/object events.
    try:
        with urlrequest.urlopen(
                FRIGATE_URL + "/api/events?limit=5", timeout=3) as r:
            body = json.loads(r.read().decode())
            if isinstance(body, list):
                out["events"] = [
                    {
                        "camera": ev.get("camera"),
                        "label": ev.get("label"),
                        "score": ev.get("top_score") or ev.get("data", {}).get("top_score"),
                        "start": ev.get("start_time"),
                        "end": ev.get("end_time"),
                    } for ev in body[:5]
                ]
            out["source"] = "frigate"
    except Exception as e:                                           # noqa: BLE001
        out["error"] = "frigate: {}".format(e)

    try:
        with urlrequest.urlopen(
                FRIGATE_URL + "/api/config", timeout=3) as r:
            cfg = json.loads(r.read().decode())
            cams = cfg.get("cameras") or {}
            out["total"] = len(cams)
            out["online"] = sum(
                1 for c in cams.values() if c.get("enabled", True)
            )
    except Exception:
        # Frigate unreachable — set zeros unless camera-discovery gave us
        # something earlier.
        pass

    return out


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        """Return True if the request carries the right auth token.

        Fail closed: if BRIDGE_AUTH_TOKEN is empty every auth-gated route
        returns 401. _boot_banner() also refuses to start the server with
        an empty token (see __main__), so this is belt-and-braces.

        Accepts either `X-Droplet-Auth: <token>` or `Authorization:
        Bearer <token>` for flexibility with the orchestrator's existing
        bearer-token style.
        """
        if not BRIDGE_AUTH_TOKEN:
            return False
        got = (self.headers.get("X-Droplet-Auth") or "").strip()
        if not got:
            authz = (self.headers.get("Authorization") or "").strip()
            if authz.lower().startswith("bearer "):
                got = authz.split(None, 1)[1].strip()
        if not got:
            return False
        # Constant-time compare to avoid timing-oracle leaks of the token.
        return hmac.compare_digest(got, BRIDGE_AUTH_TOKEN)

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/wifi":
                return self._send(200, wifi_snapshot())
            if path == "/openwrt/qr":
                return self._send(200, qr_snapshot())
            if path == "/files":
                return self._send(200, files_snapshot())
            if path == "/cameras":
                return self._send(200, cameras_snapshot())
            if path == "/drives":
                return self._send(200, drives_snapshot())
            if path == "/pools":
                # BUG-3 / ADR-019: read-only mdadm array inventory. Returns []
                # honestly when no array exists — never a fabricated pool.
                return self._send(200, pools_snapshot())
            if path == "/health":
                return self._send(200, {"ok": True})
        except Exception as e:                                       # noqa: BLE001
            return self._send(500, {"error": str(e)})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/drives/changed":
            # Invalidate the cache — the automount script calls this
            # whenever a drive is added or removed. Body is ignored;
            # we just want to force the next GET /drives to re-read.
            drives_snapshot(invalidate=True)
            return self._send(200, {"ok": True})
        if self.path.startswith("/drives/") and self.path.endswith("/eject"):
            # WARP-612: unmount + forget a hot-plug USB drive. Auth-gated like
            # the other mutating routes; eject_drive() itself refuses anything
            # that isn't a USB mount under /mnt/droplet/.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            uuid = unquote(self.path[len("/drives/"):-len("/eject")])
            ok, info = eject_drive(uuid)
            if not ok:
                # 409 Conflict — the drive is busy or not ejectable; the
                # caller surfaces the message and the user retries.
                return self._send(409, {"ok": False, "error": info})
            return self._send(200, {"ok": True, **(info if isinstance(info, dict) else {})})
        if self.path == "/pools/command":
            # BUG-3 / ADR-019: destructive mdadm op. Auth-gated exactly like
            # /drives/:uuid/eject. The orchestrator only reaches here after an
            # owner session + a valid single-use confirm-token; the bridge
            # requires its own auth token on top, and run_pool_command() shells
            # the host script (whose hard pre-flight is the last safety gate) —
            # it never runs mdadm/mkfs itself.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode() if n else ""
            try:
                j = json.loads(raw) if raw else {}
            except Exception:                                       # noqa: BLE001
                return self._send(400, {"ok": False, "error": "bad json"})
            operation = j.get("operation", "")
            params = j.get("params", {})
            ok, info = run_pool_command(operation, params)
            if not ok:
                # 422 — the host-script pre-flight refused (mounted/has-data/
                # OS-disk/bad confirm) or the op was outside the allow-list.
                return self._send(422, {"ok": False, "error": info})
            return self._send(200, {"ok": True,
                                    **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/openwrt/wifi/rotate":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            if _use_hostapd_mode():
                # Single-box / hostapd mode: no Pi-5 router to SSH into —
                # return the same rotation_disabled sentinel as qr_snapshot()
                # so callers (PyPortal UI, scheduled timer) gracefully no-op.
                return self._send(410, {
                    "ok": False, "error": "rotation_disabled",
                    "hint": "Rotation is disabled in hostapd (single-box) mode.",
                })
            if not ROTATION_ENABLED:
                # 410 Gone signals "this route exists in code but is not
                # operational in this deployment" — callers (the status
                # display UI, scheduled timer) can look at this and
                # gracefully no-op instead of retrying or surfacing an error.
                return self._send(410, {
                    "ok": False, "error": "rotation_disabled",
                    "hint": ("Set WIFI_KEY_ROTATION_ENABLED=true in "
                             "/etc/droplet/device-bridge.env to re-enable."),
                })
            ok, info = rotate_wifi_key()
            if not ok:
                # 429 for rate-limit / lock contention, 502 for upstream
                # router/SSH errors, 500 for anything else unexpected.
                status = (429 if isinstance(info, str) and
                          ("rate_limited" in info or "in progress" in info)
                          else 502)
                return self._send(status, {"ok": False, "error": info})
            return self._send(200, {"ok": True, **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/wifi/connect":
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode() if n else ""
            try:
                j = json.loads(raw)
            except Exception:
                return self._send(400, {"error": "bad json"})
            ssid = j.get("ssid", "")
            password = j.get("password", "")
            rc, out, err = _run(
                ["nmcli", "device", "wifi", "connect", ssid] +
                (["password", password] if password else []),
                timeout=30)
            return self._send(200 if rc == 0 else 400,
                              {"ok": rc == 0,
                               "message": (out or err).strip()})
        self._send(404, {"error": "not found"})


def _boot_banner():
    logging.basicConfig(
        level=os.environ.get("BRIDGE_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger.info("device-bridge starting on %s:%s (openwrt=%s, state=%s)",
                BRIDGE_BIND, BRIDGE_PORT, OPENWRT_HOST, STATE_FILE)
    if not BRIDGE_AUTH_TOKEN:
        # Fail closed: refuse to start. /openwrt/wifi/rotate + /wifi/connect
        # are mutation paths that reach OpenWrt and nmcli respectively; even
        # loopback exposure to an unprivileged process is not acceptable.
        raise RuntimeError(
            "BRIDGE_AUTH_TOKEN (or SERVICE_TOKEN_DISPLAY / "
            "DEVICE_SECRET_KEY / SERVICE_SECRET) is required — refusing "
            "to start device-bridge without an auth secret. "
            "sudo ./scripts/install-device-bridge.sh provisions this "
            "automatically from the repo .env (WARP-165).")


if __name__ == "__main__":
    _boot_banner()
    ThreadingHTTPServer((BRIDGE_BIND, BRIDGE_PORT), Handler).serve_forever()
