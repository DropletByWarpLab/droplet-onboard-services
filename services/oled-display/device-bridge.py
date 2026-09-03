"""
Droplet device-bridge — host-side HTTP API for the on-device screen.

Runs on the appliance host (outside the oled-display container). Exposes a
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
import re
import secrets
import shlex
import re
import shutil
import socket
import struct
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest
from urllib.parse import parse_qs, unquote, urlparse

logger = logging.getLogger("droplet.bridge")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

OPENWRT_HOST      = os.environ.get("OPENWRT_HOST", "192.168.50.1")
OPENWRT_USER      = os.environ.get("OPENWRT_USER", "root")
OPENWRT_PASS      = os.environ.get("OPENWRT_PASS", "")
OPENWRT_IFACE     = os.environ.get("OPENWRT_IFACE", "wlan0")
SSH_TIMEOUT       = int(os.environ.get("SSH_CONNECT_TIMEOUT", "4"))
# Persistent SSH known_hosts for the OpenWrt control channel (multi-box uci AP
# path only — single-box hostapd never SSHes). Combined with
# StrictHostKeyChecking=accept-new this trusts the router key on first contact
# and then DETECTS any later key swap — a LAN MITM on 192.168.50.x trying to
# capture OPENWRT_PASS or inject UCI now fails the connection instead of being
# silently accepted (the old StrictHostKeyChecking=no + /dev/null accepted any
# key on every connect). Defaults under the systemd StateDirectory
# (/var/lib/droplet-bridge, created 0700) so the pin survives restarts;
# install-device-bridge.sh can pre-seed it via ssh-keyscan.
OPENWRT_KNOWN_HOSTS = os.environ.get(
    "OPENWRT_KNOWN_HOSTS", "/var/lib/droplet-bridge/openwrt_known_hosts")

# Access-point credentials source for the pairing QR. The two shipping
# deployment shapes broadcast the AP differently:
#
#   uci      — multi-box: a router-host OpenWrt instance holds the AP in UCI
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
# WARP-819: the single-box per-box AP PSK is generated + persisted host-side by
# droplet-openwrt-attach to this 0600 file (which it also mirrors into the
# bridge env). Reading the SAME file here guarantees the pairing QR/text equals
# the PSK hostapd actually serves even if the bridge process started before its
# env was refreshed — coherence. Used only when DROPLET_AP_PSK isn't in the env.
AP_PSK_FILE       = os.environ.get("DROPLET_AP_PSK_FILE", "/etc/droplet/ap-psk").strip()
# Container that runs the single-box hostapd AP. Its /etc/hostapd.conf is
# the fallback creds source when DROPLET_AP_SSID isn't set in the env.
AP_HOSTAPD_CONTAINER = os.environ.get(
    "DROPLET_AP_CONTAINER", "droplet-openwrt").strip()
AP_HOSTAPD_CONF_PATH = os.environ.get(
    "DROPLET_AP_HOSTAPD_CONF", "/etc/hostapd.conf").strip()

# Where the guest Wi-Fi creds are persisted. droplet-set-guest-wifi.sh upserts
# DROPLET_GUEST_SSID/PSK/ENABLED into the SAME droplet-openwrt-attach env file
# the home-AP write uses; we read those keys back for GET /openwrt/wifi/guest.
# WARP-843: the customer Wi-Fi creds are persisted in the bridge's OWN
# StateDirectory (/var/lib/droplet-bridge/openwrt-attach.env), which is already
# writable to this sandboxed process — so the host scripts write it and we read
# it back here without ever touching root-owned /etc/default. The unit pins
# DROPLET_HOSTAPD_ENV_FILE there too; the in-code fallback must AGREE so a dev
# run reads the same file the scripts write. This file is DELIBERATELY NOT the
# root attach service's EnvironmentFile — a droplet-writable file must never
# inject arbitrary env into a root unit; root parses only the whitelisted
# DROPLET_AP_*/DROPLET_GUEST_* keys out of it, with validation.
GUEST_ENV_FILE = (
    os.environ.get("DROPLET_GUEST_ENV_FILE")
    or os.environ.get("DROPLET_HOSTAPD_ENV_FILE")
    or "/var/lib/droplet-bridge/openwrt-attach.env"
).strip()

FRIGATE_URL       = os.environ.get("FRIGATE_URL", "http://127.0.0.1:5000")
ORCHESTRATOR_URL  = os.environ.get("ORCHESTRATOR_URL", "http://127.0.0.1:3000")


# WARP-1061 — internal mTLS for the ONE orchestrator call this bridge makes
# (the /api/health sync-state read in files_snapshot). Host-side stdlib-only
# process, so it reads the standard env contract directly; install-device-
# bridge.sh mirrors DROPLET_INTERNAL_TLS + the host-issued `device-bridge`
# bundle paths into /etc/droplet/device-bridge.env. Flag on → https:// +
# client cert; unset/0 → plain HTTP, byte-identical to before. FRIGATE_URL
# stays plaintext (documented exemption — third-party loopback listener).
# WARP-1646 — hosts for which certificate verification is deliberately skipped.
# ONLY loopback literals. See _orchestrator_tls_context() for the reasoning.
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "[::1]")


def _is_loopback_url(url):
    try:
        host = urlparse(url).hostname or ""
    except Exception:                                               # noqa: BLE001
        return False
    return host in ("127.0.0.1", "localhost", "::1")


def _orchestrator_tls_context():
    if os.environ.get("DROPLET_INTERNAL_TLS", "0") == "1":
        import ssl
        ctx = ssl.create_default_context(
            cafile=os.environ.get("DROPLET_TLS_CA", ""))
        ctx.load_cert_chain(
            certfile=os.environ.get("DROPLET_TLS_CERT", ""),
            keyfile=os.environ.get("DROPLET_TLS_KEY", ""),
        )
        return ctx

    # WARP-1646 — reaching the orchestrator over the LOOPBACK gateway.
    #
    # The bridge runs on the host; the orchestrator is on the docker network
    # and is only `expose:`d, so the sole host-side route is the gateway. The
    # gateway now redirects :80 to HTTPS, and its certificate is issued for the
    # box's device FQDN — so verifying it against the literal 127.0.0.1 fails,
    # and every orchestrator read from this process failed with it (silently,
    # in files_snapshot's case).
    #
    # Verification is therefore skipped for LOOPBACK LITERALS ONLY. The
    # trade is deliberate and narrow: this connection never leaves the box, and
    # anyone positioned to MITM the box's own loopback interface already has
    # code execution on it — so verification is buying nothing here that the
    # host's own integrity does not already provide.
    #
    # ⚠ WARP-1800 CHANGED WHAT RIDES THIS PATH. It used to carry only
    # unauthenticated health data, and the original note leaned on that. The
    # join-code read now sends a Bearer token and receives the household PSK.
    # The conclusion holds but the reasoning is different, so state it: an
    # attacker who can answer 127.0.0.1 ahead of the gateway, or read this
    # process's memory, already has the token out of BRIDGE_AUTH_TOKEN in the
    # bridge's own environment and passwordless `sudo -n` besides. Unverified
    # loopback TLS does not widen that boundary. It would be wrong to extend
    # the same skip to a NON-loopback host on the strength of this comment —
    # _is_loopback_url is what keeps that from happening, not this note.
    #
    # What was NOT done, and why:
    #   * publishing the orchestrator on a host port — a fixed port collides
    #     (it broke CI immediately: "address already in use" on 3000), and a
    #     new listener is a bigger change to the box's surface than this;
    #   * verifying against the device FQDN with a manual SNI override — works
    #     only while split-horizon DNS and the cert are both healthy, which is
    #     exactly what you cannot assume when something is already wrong.
    base = _orchestrator_base_url_raw()
    if base.startswith("https://") and _is_loopback_url(base):
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


def _orchestrator_base_url_raw():
    if (ORCHESTRATOR_URL.startswith("http://")
            and os.environ.get("DROPLET_INTERNAL_TLS", "0") == "1"):
        return "https://" + ORCHESTRATOR_URL[len("http://"):]
    return ORCHESTRATOR_URL


def _orchestrator_base_url():
    return _orchestrator_base_url_raw()


def _orchestrator_household_wifi(timeout=4.0):
    """The household join credentials, from the orchestrator's canonical
    resolver. Returns (creds, None) or (None, reason).

    WARP-1800. This is the THIRD shape a box can be, and the only one the two
    local sources below cannot see:

      * single-box  — the box's own hostapd IS the household AP  (local)
      * multi-box   — an OpenWrt/UCI router hosts it             (local, SSH)
      * edge-router — a standalone approved AP hosts it, and the box's
                      hostapd/UCI genuinely hold nothing         (here)

    On the edge-router shape the household SSID lives only on the approved AP,
    so /etc/hostapd.conf does not exist and reading UCI returns the Pi's
    disabled `OpenWrt` placeholder — an answer that is worse than none because
    it looks real. Rather than teach the bridge to talk to APs (a second
    opinion about household Wi-Fi, which is exactly what WARP-1723 collapsed),
    ask the orchestrator, which already resolves router-then-approved-AP.

    Deliberately NOT a general orchestrator client: one URL, short timeout,
    every failure a reason string. The panel renders a dark rail on "" and
    that has to stay true when the orchestrator is the thing that is down.
    """
    if not BRIDGE_AUTH_TOKEN:
        return None, "no service token configured for the orchestrator"
    url = _orchestrator_base_url() + "/api/network/wifi/join-code"
    req = urlrequest.Request(
        url, headers={"Authorization": "Bearer " + BRIDGE_AUTH_TOKEN})
    try:
        with urlrequest.urlopen(req, timeout=timeout,
                                context=_orchestrator_tls_context()) as r:
            body = json.loads(r.read().decode())
    except Exception as e:                                          # noqa: BLE001
        # 401 here means the orchestrator does not know SERVICE_TOKEN_DISPLAY
        # — say so plainly rather than "unreachable", because the fix is a
        # `setup.sh --sync-secrets`, not a reboot.
        code = getattr(e, "code", None)
        if code in (401, 403):
            return None, ("orchestrator rejected the panel's service token "
                          "— run ./scripts/setup.sh --sync-secrets")
        logger.debug("household wifi read failed: %s", e)
        return None, "orchestrator unreachable: {}".format(e)

    ssid = str(body.get("ssid") or "")
    key = str(body.get("key") or "")
    if not ssid or not key:
        # `detail` is the resolver's own operator-facing explanation ("no
        # access point has been approved", "run --sync-secrets", …). Pass it
        # through — a generic string here would throw away the one field that
        # tells someone at the rack what to do.
        return None, str(body.get("detail") or "no household Wi-Fi is set")

    return {
        "ssid": ssid,
        "key": key,
        # The resolver only ever reports a PSK network; it has no WEP/open
        # path. `psk2` maps to `T:WPA` in _wifi_payload.
        "encryption": "psk2",
        "hidden": False,
        "disabled": False,
        "source": str(body.get("source") or ""),
    }, None
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

# In-process lock for the single-box hostapd WRITE (WARP-808). The HTTP server is
# threaded, so two concurrent POST /openwrt/wifi/hostapd would both exec the host
# script AND both `systemctl restart droplet-openwrt-attach` — interleaving the
# env-file write + double-bouncing the AP. Serialize them exactly like
# _ROTATION_LOCK does for rotation: non-blocking acquire, 409 on contention.
_HOSTAPD_LOCK = threading.Lock()

# In-process lock for the single-box GUEST Wi-Fi write (sibling of
# _HOSTAPD_LOCK). Serializes POST/DELETE /openwrt/wifi/guest so two concurrent
# guest writes cannot interleave the env-file upsert + double-restart the attach
# service. Non-blocking acquire, 409 on contention.
_GUEST_LOCK = threading.Lock()

# In-process lock for the factory reset (WARP-825). The HTTP server is threaded,
# so two concurrent POST /system/factory-reset would each _spawn_detached the
# wipe script — two `docker compose down -v` runs racing the same teardown.
# Serialize the spawn decision exactly like _HOSTAPD_LOCK: non-blocking acquire,
# 409 on contention.
_FACTORY_RESET_LOCK = threading.Lock()

# Handle to the in-flight wipe's detached process (WARP-825 hardening). On a
# successful spawn the lock is held for the wipe's whole lifetime — the wipe is
# meant to tear this bridge down, so a SUCCESSFUL wipe never returns to this
# process at all. If a LATER reset request finds the lock held, polling this
# handle distinguishes a live wipe (poll() is None → genuinely in progress →
# 409) from one that exited WITHOUT completing the teardown (poll() is not None
# → the wipe FAILED mid-run → reclaim the stale lock so the owner can retry,
# instead of wedging every future reset at 409 for the life of the bridge).
_factory_reset_proc = None


# ---------------------------------------------------------------------------
# Shell helper
# ---------------------------------------------------------------------------

def _run(cmd, timeout=15):
    # argv list, shell=False — nothing is ever interpolated into a shell string.
    # CodeQL py/command-line-injection (#65) traces three request-derived
    # arguments to this call; each is allow-listed at its call site BEFORE it
    # gets here (collect_logs: _LOGS_SERVICE_RE, run_set_public_fqdn:
    # _valid_public_fqdn, run_set_box_name: _valid_box_name), and the host
    # scripts they reach validate again.
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
    # Pin the router host key to a persistent known_hosts and trust-on-first-use
    # (accept-new): first contact records the key, every later connect verifies
    # it, so a mid-stream key swap by a MITM is rejected rather than silently
    # accepted. Best-effort ensure the parent dir exists (systemd StateDirectory
    # normally creates it; this also covers manual/dev runs) — ssh surfaces any
    # real permission error itself.
    try:
        os.makedirs(os.path.dirname(OPENWRT_KNOWN_HOSTS) or ".", exist_ok=True)
    except OSError:
        pass
    ssh_args = [
        "ssh",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"UserKnownHostsFile={OPENWRT_KNOWN_HOSTS}",
        "-o", f"ConnectTimeout={SSH_TIMEOUT}",
        "-o", "LogLevel=ERROR",
        f"{OPENWRT_USER}@{OPENWRT_HOST}",
        remote_cmd,
    ]
    if OPENWRT_PASS:
        # WARP-1830: `sshpass` is an UNDOCUMENTED runtime dependency — it
        # appears in no Dockerfile, no install script and no package manifest
        # in this repo, and it is absent on the shipping box. Without this
        # check the failure arrives as `_run`'s stringified OSError,
        # "[Errno 2] No such file or directory: 'sshpass'", which reads like a
        # missing *config file* and sent this bug's first triage after the
        # wrong thing. Name the package and the alternative instead.
        if shutil.which("sshpass") is None:
            return 1, "", ("sshpass is not installed but OPENWRT_PASS is set "
                           "— install sshpass, or clear OPENWRT_PASS and use "
                           "a key-based SSH login")
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


def _read_persisted_psk():
    """Read the per-box AP PSK from the persisted 0600 file (WARP-819).

    droplet-openwrt-attach generates the PSK once and writes it here; this is
    the SAME value hostapd serves. Returns the stripped key, or "" when the
    file is absent/unreadable/empty. Never raises."""
    try:
        with open(AP_PSK_FILE) as f:
            return f.read().strip()
    except Exception:                                               # noqa: BLE001
        return ""


def hostapd_wifi_credentials():
    """Return the single-box hostapd AP's SSID + PSK.

    Source order for the PSK, all coherent with what hostapd serves:
      1. DROPLET_AP_PSK env (cleanest; mirrored in by droplet-openwrt-attach);
      2. the persisted 0600 file AP_PSK_FILE (the attach script's source of
         truth — covers a bridge started before its env was refreshed);
      3. /etc/hostapd.conf inside the droplet-openwrt container (last resort).
    Returns (creds, err) with the same dict shape as openwrt_wifi_credentials().
    """
    if AP_SSID:
        # Env PSK first, else the persisted per-box file (WARP-819). Both are the
        # value the attach script fed hostapd, so the displayed creds match the
        # live AP either way.
        key = AP_PSK or _read_persisted_psk()
        if key:
            return ({
                "ssid": AP_SSID,
                "key": key,
                "encryption": "psk2",
                "hidden": False,
                "disabled": False,
            }, None)
        # WARP-819 boot race: SSID is configured but neither the env nor the
        # persisted 0600 file has the PSK yet (droplet-openwrt-attach hasn't run,
        # or _read_persisted_psk() hit a PermissionError and swallowed it). Do
        # NOT return key:"" — that renders an unscannable `WIFI:T:WPA;S:..;P:;;`
        # QR a phone joins as a named-but-open network and then can't reach the
        # box. Fall through to the live hostapd.conf (the value hostapd actually
        # serves). _hostapd_conf_creds_or_error() rejects an empty-passphrase
        # conf too, so the caller emits NO QR rather than a broken one.
        return _hostapd_conf_creds_or_error()
    return _hostapd_conf_creds_or_error()


def _hostapd_conf_creds_or_error():
    """Read hostapd.conf creds, rejecting an empty/missing passphrase.

    Wraps _read_hostapd_conf_creds() so a parsed-but-keyless conf (an AP whose
    wpa_passphrase line is empty, or a container still mid-boot) degrades to
    (None, err) instead of leaking creds with key:"". The QR builder then emits
    an error placeholder rather than an empty-passphrase QR (WARP-819)."""
    creds, err = _read_hostapd_conf_creds()
    if creds is not None and not creds.get("key"):
        return None, "hostapd AP passphrase not available yet"
    return creds, err


# ---------------------------------------------------------------------------
# Is the box's own radio ACTUALLY hosting a network? (WARP-2047)
#
# Every source hostapd_wifi_credentials() reads is a *config* read — the env,
# a persisted file, hostapd.conf. Its docstring says those are "coherent with
# what hostapd serves", but nothing enforced it, and on droplet-sys they had
# drifted three ways at once: the bridge env said `Warp`/`T3stCamPw!`, the
# container's hostapd.conf said `Droplet-AI`, and the household AP was
# beaconing `Warp` under a different passphrase entirely. The panel published
# the env's pair, so the QR named a real network with the wrong password and
# no phone could join it.
#
# A config file is not evidence that a radio is transmitting. Ask the radio.
# `iw dev` is the same boundary the conf reader already uses (docker exec into
# the AP container, where droplet-openwrt-attach parks the phy) and it answers
# the only question that matters: which SSIDs are up in AP mode right now.
#
# Deliberately three-valued. `None` means the probe could not run, which is NOT
# "no AP is up" — an install without `iw` must keep behaving exactly as before
# rather than have its working QR blanked. Same discipline as the AP fan-out's
# `apsNotReporting`: a degraded read never renders as a confident zero.
# ---------------------------------------------------------------------------

def _parse_iw_dev_ap_ssids(out):
    """SSIDs of the `type AP` interfaces in `iw dev` output.

    Parsed per interface BLOCK, not line by line: `iw` prints `ssid` *before*
    `type`, so a running scan that just remembers the last SSID it saw will
    attribute it to the next interface and invent an AP on a station-only
    radio. Blocks start at `Interface <name>` (and at the `Unnamed/non-netdev`
    P2P pseudo-interface, which carries a type and no ssid).
    """
    found = set()
    ssid = None
    mode = None

    def _flush():
        if mode == "AP" and ssid:
            found.add(ssid)

    for raw in (out or "").splitlines():
        line = raw.strip()
        if line.startswith("Interface ") or line.startswith("Unnamed/"):
            _flush()
            ssid, mode = None, None
        elif line.startswith("ssid "):
            # SSIDs may contain spaces — take the remainder verbatim.
            ssid = line[len("ssid "):].strip()
        elif line.startswith("type "):
            mode = line[len("type "):].strip()
    _flush()
    return found


def _live_ap_ssids_uncached():
    """(ssids, None) when the radio answered; (None, reason) when it could not.

    An empty SET is a real, load-bearing answer: the radio is up and hosting
    nothing.
    """
    rc, out, err = _run(
        ["docker", "exec", AP_HOSTAPD_CONTAINER, "iw", "dev"], timeout=8)
    if rc != 0:
        return None, (err.strip() or "iw dev unavailable")
    return _parse_iw_dev_ap_ssids(out), None


_AP_LIVENESS_TTL_S = 30.0
_ap_liveness_lock = threading.Lock()
_ap_liveness_cache = {"value": None, "err": None, "at": 0.0}


def _live_ap_ssids():
    """TTL-cached `_live_ap_ssids_uncached()`.

    The panel polls /openwrt/qr continuously; an uncached `docker exec` per
    poll is the same self-inflicted load bug WARP-834 found behind
    _use_hostapd_mode, so it gets the same treatment (single-flight under a
    lock, short TTL). 30s is well under the time it takes anyone to notice a
    changed SSID and short enough that a hotspot coming up mid-boot is picked
    up on the next poll or two.
    """
    now = time.time()
    with _ap_liveness_lock:
        cached_at = _ap_liveness_cache["at"]
        if cached_at and (now - cached_at) < _AP_LIVENESS_TTL_S:
            return _ap_liveness_cache["value"], _ap_liveness_cache["err"]
        value, err = _live_ap_ssids_uncached()
        _ap_liveness_cache.update({"value": value, "err": err, "at": now})
        return value, err


def _corroborate_local_creds(creds):
    """Gate locally-read hostapd creds on the radio actually beaconing them.

    Returns (creds, err, liveness). liveness is the probe's three-valued
    verdict, mirrored into the snapshot's `liveness` field:

      "corroborated" — the radio is beaconing the configured SSID; publish.
      "refused"      — the radio answered and does NOT vouch for these creds
                       (creds is None, err says why); qr_snapshot()'s
                       WARP-1800 fallback asks the orchestrator, i.e. the AP
                       that really does host the network.
      "unavailable"  — the probe could not run; the creds still publish
                       (err is None) but UNCORROBORATED, and the snapshot
                       says so.

    A live BSS under a DIFFERENT name is refused rather than silently relabelled
    with the live SSID: if the configured SSID is stale then the passphrase
    sitting beside it is equally unverified, and publishing a name/password pair
    assembled from two sources is how the unjoinable QR happened in the first
    place.
    """
    live, probe_err = _live_ap_ssids()
    if live is None:
        # Could not ask. Keep the pre-WARP-2047 serve-anyway behaviour — an
        # install without `iw` must not lose its working QR — but not silently:
        # at WARNING, because an unverifiable radio is not routine, and with
        # the "unavailable" marker, because without one this snapshot reads
        # byte-identical to a corroborated answer and a wrong SSID on this
        # path would be invisible everywhere.
        logger.warning(
            "AP liveness probe unavailable (%s); publishing local creds "
            "uncorroborated", probe_err)
        return creds, None, "unavailable"
    if not live:
        return None, ("this Droplet's radio is not hosting a network "
                      "(no AP interface is up)"), "refused"
    if creds["ssid"] not in live:
        # Names only — never the passphrase we just declined to trust.
        return None, (
            "configured SSID {!r} is not on the air (broadcasting: {}) — "
            "the local Wi-Fi config has drifted from the radio".format(
                creds["ssid"], ", ".join(sorted(live)))), "refused"
    return creds, None, "corroborated"


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


# Cache the deployment-shape decision. In `auto` mode with no DROPLET_AP_SSID the
# decision requires a UCI probe over SSH — an up-to-12s round trip via
# openwrt_wifi_credentials(). qr_snapshot() calls _use_hostapd_mode() on every
# GET /openwrt/qr and the POST /openwrt/wifi/hostapd handler calls it on every
# Wi-Fi write; under ThreadingHTTPServer those run concurrently, so an uncached
# probe blocks every display/orchestrator poll for up to 12s AND opens a fresh
# SSH session each time. The mode is effectively static: DROPLET_AP_MODE is read
# once at import, and in `auto` the only dynamic input is whether UCI answers —
# which can't change without an explicit reconfiguration. A short TTL bounds any
# staleness (e.g. UCI flapping) while keeping the hot path cheap. The probe runs
# under _hostapd_mode_lock (single-flight) so a concurrent burst shares ONE probe
# instead of each opening a parallel SSH session (WARP-834 findings 2 + 3).
_HOSTAPD_MODE_TTL_S = 60.0
_hostapd_mode_lock = threading.Lock()
_hostapd_mode_cache = {"value": None, "at": 0.0}


def _compute_hostapd_mode():
    """Uncached deployment-shape decision — the real logic behind
    _use_hostapd_mode().

    - hostapd  -> always hostapd.
    - uci      -> always UCI/SSH (back-compat default).
    - auto     -> hostapd when a DROPLET_AP_SSID is configured (a clear
                  single-box signal) OR when UCI wireless is empty/
                  unreachable; otherwise UCI.

    Only the `auto` path with no DROPLET_AP_SSID issues the (up to 12s) SSH
    probe; `hostapd` and `uci` decide from process-static env alone.
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


def _use_hostapd_mode():
    """Whether to source the QR creds from hostapd vs. UCI, cached for
    _HOSTAPD_MODE_TTL_S.

    Without the cache the `auto`-mode UCI probe (an SSH round trip up to 12s)
    would run on every GET /openwrt/qr and every Wi-Fi write — continuously
    degrading those endpoints under ThreadingHTTPServer. The explicit `hostapd`
    and `uci` modes never probe, so the cache is essentially free there; it
    matters on the `auto` shape. Computed single-flight under _hostapd_mode_lock
    so a concurrent burst shares one probe rather than opening parallel SSH
    sessions.
    """
    now = time.monotonic()
    with _hostapd_mode_lock:
        cached = _hostapd_mode_cache["value"]
        if cached is not None and (now - _hostapd_mode_cache["at"]) < _HOSTAPD_MODE_TTL_S:
            return cached
        value = _compute_hostapd_mode()
        _hostapd_mode_cache["value"] = value
        _hostapd_mode_cache["at"] = time.monotonic()
        return value


# ---------------------------------------------------------------------------
# Appliance-local nmcli fallback
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


def _uci_router_is_the_right_question():
    """Whether asking an OpenWrt/UCI router over SSH makes sense on this box.

    WARP-1830. `wifi_snapshot()` used to run `scan_via_openwrt()` on EVERY
    shape. That is only correct on multi-box, where a router really does sit
    at OPENWRT_HOST. On the other two it dials a phone number nobody owns:

      * single-box  — the box's own hostapd is the AP; there is no UCI router
      * edge-router — the Pi owns the fabric and an external AP serves Wi-Fi;
                      the box is a wired DHCP client with its radio
                      deactivated (ADR-033 §3, and the founder rule of
                      2026-07-28 that onboard radios are never APs)

    Reuses the SAME shape decision as the credential path (WARP-654/834) so
    the scan can no longer disagree with the QR about what kind of box this
    is — the two answering differently is what let this sit unnoticed.
    """
    return not _use_hostapd_mode()


def wifi_snapshot():
    out = {
        "networks": [], "source": None, "adapter": None,
        "connected_to": None, "state": "unknown",
        "scanned_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "error": None, "detail": None,
    }
    # WARP-1830 — shape first, transport second. On a box with no UCI router
    # the SSH scan produced a failure that LOOKED like a broken dependency
    # ("[Errno 2] ... 'sshpass'") while the real fault was that OPENWRT_HOST
    # still pointed at the multi-box default, 192.168.50.1 — unreachable from
    # behind the Pi. Not asking is the fix; installing the binary would only
    # have swapped an instant honest error for a slow misleading one.
    uci_shape = _uci_router_is_the_right_question()
    if uci_shape:
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
    if uci_shape:
        # A router we were right to ask, that did not answer. A real fault.
        out["state"] = "unavailable"
        return out
    # Nothing to scan, and nothing broken. Report that plainly rather than
    # borrowing the vocabulary of failure: on this shape an empty network list
    # is the CORRECT answer, and `error` here would be a lie that costs
    # somebody an afternoon.
    out["state"] = "not-applicable"
    out["detail"] = ("this box has no OpenWrt router of its own to scan — "
                     "Wi-Fi is served by the external access point")
    return out


# ---------------------------------------------------------------------------
# Wi-Fi QR code
# ---------------------------------------------------------------------------
# Pure-Python QR encoder.
# Handles the subset we actually need: WIFI payload strings, byte mode,
# error-correction level Q (L fallback for oversized pathological payloads),
# auto version bump. No external deps.

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


# Hard cap on the QR matrix we ship to the panel — mirrors ClaimRequest's
# wifi_qr_matrix max_length=64 (main.py): a v-large QR would OOM the
# PyPortal. At Q only a pathological fully-escaped SSID+PSK (~200+ chars)
# exceeds it; _qr_encode degrades those to L, which always fits.
_QR_MAX_ROWS = 64


def _qr_encode(text):
    """Generate a QR code bit-matrix for `text` using the `qrcode` lib
    (apt: python3-qrcode). Returns (matrix, version).

    ERROR_CORRECT_Q (~25% codeword recovery), NOT L: the PyPortal's QR card
    (_v3_qr_card in pyportal/code.py) paints a 32x32px white droplet-mark
    pad dead-centre over the symbol, and at L the pad corrupts more
    codewords than Reed-Solomon can recover — the rendered card fails to
    decode for every typical Wi-Fi payload (verified empirically; same
    finding as the scan-to-claim QR in the PR #550 review). Typical WPA
    payloads land at v4 (33x33) at Q, well inside the firmware's 64-row
    tolerance. A payload too big for 64 rows at Q degrades to L — the same
    matrix the encoder always shipped for those — rather than risking the
    panel heap.
    """
    import qrcode
    from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_Q

    def _encode(level):
        q = qrcode.QRCode(
            error_correction=level,
            border=0,       # we pad on the display side
            box_size=1,
        )
        q.add_data(text)
        q.make(fit=True)
        matrix = [[1 if cell else 0 for cell in row]
                  for row in q.get_matrix()]
        return matrix, q.version

    matrix, version = _encode(ERROR_CORRECT_Q)
    if len(matrix) > _QR_MAX_ROWS:
        matrix, version = _encode(ERROR_CORRECT_L)
    return matrix, version


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
        # WARP-2047 — outcome of the local-radio corroboration step:
        # "corroborated" / "refused" / "unavailable", or None when the step
        # does not apply (UCI shape, or no local creds to check). Load-bearing
        # for "unavailable": that is the one path that still publishes creds
        # no radio vouched for, and without the marker such a snapshot is
        # indistinguishable from a corroborated one.
        "liveness": None,
    }
    if rotation_enabled:
        out["ttl_seconds"] = _key_ttl_seconds()
        out["rotation_interval_seconds"] = ROTATION_INTERVAL_S

    if hostapd:
        creds, err = hostapd_wifi_credentials()
        # WARP-2047 — every hostapd source above is a config read. Publish it
        # only if the radio is actually beaconing that SSID; otherwise drop to
        # the orchestrator fallback below, which asks the AP that really hosts
        # the network. Only the hostapd branch needs this: the UCI branch's
        # creds already come from the router that serves them.
        if creds is not None:
            creds, err, out["liveness"] = _corroborate_local_creds(creds)
    else:
        creds, err = openwrt_wifi_credentials()

    # WARP-1800 — the edge-router shape. Neither local source can answer when
    # the household SSID lives on a standalone approved AP, so fall through to
    # the orchestrator's canonical resolver rather than reporting "router
    # unreachable" for a router that is fine and simply hosts no Wi-Fi.
    #
    # Strictly a FALLBACK: a box whose own radio is the household AP keeps
    # answering locally, with no orchestrator dependency added to the path
    # that already worked. Only the shapes that were returning an error now
    # make a network call, so the happy path costs nothing.
    from_orchestrator = False
    if creds is None:
        creds, orch_err = _orchestrator_household_wifi()
        from_orchestrator = creds is not None
        if creds is None:
            # Lead with the LOCAL reason: on a single-box the local failure is
            # the real one and the orchestrator is a red herring. Carry the
            # orchestrator's reason too — on the edge-router shape the local
            # error is the red herring ("hostapd.conf: No such file" is
            # expected there, not a fault).
            out["error"] = " / ".join(
                m for m in (err, orch_err) if m
            ) or ("hostapd AP unavailable" if hostapd else "router unreachable")
            return out

    if hostapd and not from_orchestrator:
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
        # Track the branch actually taken, not the box shape: an edge-router
        # fallback on a hostapd box goes through _wifi_payload, so reporting
        # the hostapd constant here would describe a payload we did not build.
        "security": ("WPA" if (hostapd and not from_orchestrator)
                     else creds["encryption"]),
        # WARP-1800 — which of the three sources answered. The endpoint is
        # still called /openwrt/qr for compatibility with the panel and the
        # single-box pairing flow, but it is no longer always OpenWrt telling
        # us; anyone debugging a wrong SSID needs to know which one did.
        "source": "orchestrator" if from_orchestrator else (
            "hostapd" if hostapd else "uci"),
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
                _orchestrator_base_url() + "/api/health", timeout=3,
                context=_orchestrator_tls_context()) as r:
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


# WARP-827: hide partitions that live on the OS/root disk. The automounter can
# mount the install disk's EFI/boot partitions under /mnt/droplet/<uuid> (they
# look like generic data volumes), which then surface as confusing "drives" —
# and, worse, as reformat targets. We resolve each candidate's whole disk and
# drop it when that disk also backs root "/". Fails OPEN: if root's disk can't
# be resolved we hide nothing, so a real data drive is never lost.
_os_disk_cache = {"disk": None, "at": 0.0}


def _whole_disk(device):
    """Whole-disk kernel name backing a device/partition. Uses lsblk's inverse
    dependency walk (-s) so it resolves partitions (nvme0n1p2 -> nvme0n1) AND
    device-mapper/LVM (a root LV -> its PV's physical disk) — a plain PKNAME
    lookup returns nothing for dm devices, which is why the LVM root never
    matched. -r keeps the NAME column free of tree-drawing glyphs. Returns the
    deepest TYPE=disk in the chain, or "" when it can't be resolved."""
    dev = device or ""
    if not dev:
        return ""
    try:
        _rc, out, _e = _run(["lsblk", "-rnso", "NAME,TYPE", dev], timeout=4)
        disk = ""
        for line in (out or "").splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "disk":
                disk = parts[0].strip()  # last (deepest) disk in the chain
        if disk:
            return disk
    except Exception:                                                  # noqa: BLE001
        pass
    return os.path.basename(dev)


def _os_disk():
    """Whole-disk kernel name that backs root "/" (cached ~5 min; topology is
    stable). "" when undeterminable — callers then hide nothing (fail open)."""
    now = time.time()
    if _os_disk_cache["disk"] is not None and now - _os_disk_cache["at"] < 300:
        return _os_disk_cache["disk"]
    disk = ""
    try:
        _rc, src, _e = _run(["findmnt", "-fno", "SOURCE", "/"], timeout=4)
        rows = (src or "").strip().splitlines()
        root_src = rows[0].strip() if rows else ""
        if root_src:
            disk = _whole_disk(root_src)
    except Exception:                                                  # noqa: BLE001
        disk = ""
    _os_disk_cache["disk"] = disk
    _os_disk_cache["at"] = now
    return disk


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


# ---------------------------------------------------------------------------
# WARP-936: adoptable-disks inventory. The mounted-drives snapshot above is by
# construction blind to a present-but-unmounted disk (the live box's two
# RAID-member WD drives were invisible to every layer). This additive lsblk
# walk lists every WHOLE disk except the OS disk and <100MB devices, each with
# an EXPLICIT state enum — the dashboard branches on the enum, never guesses:
#   in_use      — the disk itself or a NON-md descendant (plain partition,
#                 dm/LVM volume) is mounted. A mount on the md ARRAY a member
#                 backs does NOT count (WARP-1336): that's the pool in use,
#                 not the disk — the member stays pool_member so Reclaim
#                 remains reachable on a healthy (mounted) pool.
#   pool_member — carries a linux_raid_member signature (md name + md_mounted
#                 included)
#   foreign     — has some fs/RAID/LVM signature but nothing mounted
#   available   — no signature at all
# READ-ONLY. Rides the drives_snapshot 10s cache (and its /drives/changed
# invalidation hook), so it costs one lsblk subprocess per cache refresh.

def _lsblk_disks_json():
    """Raw `lsblk -J -b` device tree as a parsed dict, or None when lsblk is
    unavailable / emits garbage. Isolated so tests feed canned topology."""
    _rc, out, _e = _run(
        ["lsblk", "-J", "-b", "-o",
         "NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,TRAN,MODEL,SERIAL"],
        timeout=8,
    )
    try:
        parsed = json.loads(out or "")
        return parsed if isinstance(parsed, dict) else None
    except (ValueError, TypeError):
        return None


def _walk_block_children(node):
    """Yield every descendant of an lsblk tree node (partitions, md arrays,
    dm/LVM volumes), depth-first."""
    for child in node.get("children") or []:
        yield child
        yield from _walk_block_children(child)


def _os_disk_filesystems(mount_meta, os_disk):
    """WARP-2098 — every mounted filesystem that physically lives on `os_disk`,
    measured, ONE row per backing device. Feeds system_disk_info; kept separate
    because this half touches the host (lsblk walks + statvfs) while that half
    is pure.

    Discovery, not a hardcoded path list: `/data` exists only after
    droplet-luks-provision.sh has moved the docker data-root there, and an
    operator-written daemon.json can leave it absent. Asking which mounts sit on
    the root disk answers correctly on every box shape, including the one where
    root, /boot and /data are three LVs on one NVMe.

    Deduplicated by BACKING DEVICE, keeping the shortest mount path. This is
    load-bearing, not tidiness: the automounter bind-mounts "/" at
    /mnt/droplet, so the root filesystem appears in /proc/mounts twice with
    identical statvfs numbers. Summing both would report double the used bytes —
    the same phantom-capacity mistake WARP-1960 fixed in camera storage.

    `mount_meta` is the /proc/mounts pass the caller already did, keyed by mount
    point. Mounts whose statvfs fails are dropped rather than reported as zero —
    an unmeasurable filesystem must not read as an empty one.
    """
    if not os_disk:
        return []
    by_device = {}
    try:
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                dev, mp = parts[0], _unescape_mount(parts[1])
                # Real block devices only: skips tmpfs/proc/sysfs/overlay, which
                # are not on any disk and would inflate the total.
                if not dev.startswith("/dev/") or not os.path.exists(dev):
                    continue
                if _whole_disk(dev) != os_disk:
                    continue
                previous = by_device.get(dev)
                if previous is not None and len(previous["mount"]) <= len(mp):
                    continue
                total, used, free = _bytes_for(mp)
                if total <= 0:
                    continue
                fs, _ro = mount_meta.get(mp, ("", True))
                by_device[dev] = {
                    "mount": mp,
                    "fs": fs,
                    "size_bytes": total,
                    "used_bytes": used,
                    "free_bytes": free,
                }
    except Exception:                                                  # noqa: BLE001
        # Best-effort, exactly like the drive-enumeration passes above: a
        # partial (or empty) list yields honest partial usage, never an error.
        pass
    return sorted(by_device.values(), key=lambda r: r["mount"])


def system_disk_info(lsblk_tree, os_disk, os_filesystems):
    """WARP-2098 — the appliance's OWN install disk, as its own object.

    WARP-827 removed the OS/boot disk from BOTH lists this bridge emits: from
    `drives` (any mount whose whole disk is the root disk) and from `disks`
    (classify_disks below). That is still correct and stays correct — every one
    of those lists feeds a destructive picker somewhere above (adopt, reclaim,
    pool-create, reformat), and the system disk must never be an option in any
    of them.

    What WARP-827 also did was make the disk INVISIBLE. The owner had no answer
    to "what is the Droplet's own disk, and how full is it?" — and on this
    appliance that is the disk that fills first. Nextcloud's data directory is a
    plain named volume under the docker data-root, which droplet-luks-provision
    points at /data: an LV on the OS disk (docs/security/at-rest-encryption.md).
    The storage pool reaches Nextcloud only as external storage. So uploads land
    on the install disk, and the install disk was the one thing the owner could
    not see.

    This reports it in a key of its OWN, never as a member of any list.

    `os_filesystems` is every mounted filesystem the CALLER has already resolved
    to this disk and measured — root, /boot, /boot/efi and (on a provisioned
    box) /data. Measuring only "/" would be the wrong answer: on an LVM install
    root is a small LV and /data holds everything, so a root-only figure reports
    a nearly-empty disk while the box is out of room. Host lookups stay in the
    caller so this stays pure and fixture-testable.

    `used_bytes` sums those filesystems — legitimate here, unlike the pooled sum
    ADR-019 forbids, because they are disjoint extents of ONE physical device.
    `free_bytes` is measured against the whole disk, so unallocated LVM extents
    correctly count as free.

    Returns None (the key is then omitted entirely) when the disk cannot be
    identified — the same fail-open contract as the WARP-827 filters.
    """
    if not os_disk:
        return None
    # `os_disk` must name a WHOLE DISK in the tree. _whole_disk() falls back to
    # basename(device) when lsblk is unavailable, so _os_disk() can hand back a
    # PARTITION name ("nvme0n1p2"); reporting that as the system disk would
    # quote a partition's geometry as the disk's. Omit instead.
    node = None
    for dev in (lsblk_tree or {}).get("blockdevices") or []:
        if (dev.get("type") or "") == "disk" and (dev.get("name") or "") == os_disk:
            node = dev
            break
    if node is None:
        return None
    try:
        disk_size = int(node.get("size") or 0)
    except (TypeError, ValueError):
        disk_size = 0

    filesystems = []
    for fs in os_filesystems or []:
        mount = fs.get("mount") or ""
        filesystems.append({
            "mount": mount,
            # Plain-language grouping for the UI, decided here so the dashboard
            # never has to pattern-match host paths.
            "role": "root" if mount == "/" else (
                "boot" if mount == "/boot" or mount.startswith("/boot/") else "data"),
            "fs": fs.get("fs") or "",
            "size_bytes": fs.get("size_bytes") or 0,
            "used_bytes": fs.get("used_bytes") or 0,
            "free_bytes": fs.get("free_bytes") or 0,
        })

    if filesystems:
        used = sum(f["used_bytes"] for f in filesystems)
        free = max(0, disk_size - used) if disk_size else None
    else:
        # The disk is real but nothing on it could be measured (statvfs denied,
        # no visible mounts). Report null, NEVER 0 — a zero would render as a
        # pristine empty disk, which is a claim and a false one.
        used = None
        free = None

    return {
        "name": os_disk,
        "size_bytes": disk_size,
        "used_bytes": used,
        "free_bytes": free,
        "model": (node.get("model") or "").strip(),
        "serial": (node.get("serial") or "").strip(),
        "bus": (node.get("tran") or "").lower(),
        "filesystems": filesystems,
    }


def classify_disks(lsblk_tree, os_disk):
    """Classify the lsblk -J tree into the WARP-936 `disks` list.

    Pure function — no subprocess, no host state — so the fixture-driven
    tests cover every enum branch. Excludes the OS disk (same WARP-827
    fail-open contract: an empty os_disk hides nothing, but a mounted root
    still classifies the disk `in_use`, so it is never offered as adoptable)
    and trivially small devices (<100 MB, CIRCUITPY-class)."""
    disks = []
    for dev in (lsblk_tree or {}).get("blockdevices") or []:
        if (dev.get("type") or "") != "disk":
            continue  # loop/md/dm top-level nodes are not physical disks
        name = dev.get("name") or ""
        if not name:
            continue
        if os_disk and name == os_disk:
            continue  # never surface the OS/boot disk as inventory
        try:
            size = int(dev.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        if size < _MIN_DRIVE_BYTES:
            continue
        descendants = list(_walk_block_children(dev))
        # WARP-1336: split mounts by WHERE they sit. On a healthy box the
        # pool filesystem is mounted on the md array the members back, and
        # counting that mount against the member disk classified every
        # member in_use with no `md` — making the dashboard's Reclaim
        # affordance (gated on pool_member + md) unreachable exactly when
        # the pool worked. A mount on an md descendant is the ARRAY in use;
        # only the disk node itself or a non-md descendant (plain partition,
        # dm/LVM volume) being mounted makes the DISK in_use.
        md_name = next(
            (d.get("name") for d in descendants
             if (d.get("name") or "").startswith("md")),
            "",
        )
        md_mounted = any(
            d.get("mountpoint") for d in descendants
            if (d.get("name") or "").startswith("md")
        )
        mounted = bool(dev.get("mountpoint")) or any(
            d.get("mountpoint") for d in descendants
            if not (d.get("name") or "").startswith("md")
        )
        signatures = [
            t for t in [dev.get("fstype")] + [d.get("fstype") for d in descendants]
            if t
        ]
        if mounted:
            state = "in_use"  # wins over everything — never adoptable
        elif "linux_raid_member" in signatures:
            state = "pool_member"
        elif md_mounted:
            # A mounted md descendant WITHOUT a raid-member signature on the
            # disk is a shape we can't reason about — fail closed as in_use
            # (never adoptable, and not reclaimable: there is no superblock
            # for drive_reclaim to zero).
            state = "in_use"
        elif signatures:
            state = "foreign"
        else:
            state = "available"
        entry = {
            "name": name,
            "size_bytes": size,
            "state": state,
            "fstype": dev.get("fstype") or "",
            "bus": (dev.get("tran") or "").lower(),
            "model": (dev.get("model") or "").strip(),
            "serial": (dev.get("serial") or "").strip(),
        }
        if md_name or state == "pool_member":
            # Name the array so the dashboard routes the member to Reclaim
            # (drive_reclaim needs the owning md) instead of a per-disk
            # adopt that would fail EBUSY on an md-held member anyway.
            # WARP-1336: attached in EVERY state that has an md descendant —
            # the member→array linkage must survive the state — plus
            # `md_mounted` so UI copy can distinguish a live pool from
            # leftover metadata.
            entry["md"] = md_name
            entry["md_mounted"] = md_mounted
        disks.append(entry)
    return disks


def drives_snapshot(invalidate=False):
    """Return every 'data' drive mounted on /mnt/*, from both the automount
    state file (hot-plug USB/NVMe) and /proc/mounts (fstab-installed
    storage like /mnt/cameras and /mnt/cloud-storage). Deduplicates by
    mount point when both sources report the same drive.

    WARP-936: additionally carries a top-level `disks` array — the whole-disk
    inventory with explicit states (see classify_disks) — so unmounted disks
    are no longer invisible. Additive: older orchestrators ignore the field;
    the mounted `drives` semantics are unchanged.
    """
    now = time.time()
    if not invalidate and _drives_cache["snap"] and now - _drives_cache["at"] < 10:
        return _drives_cache["snap"]

    by_mount = {}  # mount-point -> entry, so state + /proc/mounts merge cleanly
    os_disk = _os_disk()  # WARP-827: whole disk backing root "/"; "" = unknown

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
            device = m.get("device")
            parent_disk = _whole_disk(device)
            if os_disk and parent_disk and parent_disk == os_disk:
                continue  # WARP-827: partition on the OS/root disk, not a data drive
            total, used, free = _bytes_for(mp)
            # Fail SAFE on a /proc/mounts miss: report read-only, never a false
            # "writable". The UI renders mount status from this flag and the
            # deferred eject/fsck work will trust it — for a data-integrity-first
            # product an unknown state must not present as writable.
            fs, readonly = mount_meta.get(mp, ("", True))
            smart, temp = _smart_for(device)  # one smartctl pass, not two
            by_mount[mp] = {
                "device": device,
                "parent_disk": parent_disk,
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
                parent_disk = _whole_disk(dev)
                if os_disk and parent_disk and parent_disk == os_disk:
                    continue  # WARP-827: partition on the OS/root disk, not a data drive
                label, uuid = _label_and_uuid_for(dev)
                smart, temp = _smart_for(dev)  # one smartctl pass, not two
                by_mount[mp] = {
                    "device": dev,
                    "parent_disk": parent_disk,
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

    # WARP-827: one card per PHYSICAL drive. A drive can be mounted at more than
    # one path (e.g. a friendly /mnt/droplet/data + the automount
    # /mnt/droplet/data-<uuid>), which otherwise shows the same disk twice.
    # Collapse by backing device, keeping the friendliest mount (fstab first,
    # then the shortest path), and preserve ejectability if any duplicate was
    # removable.
    ordered = sorted(
        by_mount.values(),
        key=lambda d: (d.get("source") != "fstab", len(d.get("mount", "")), d.get("mount", "")),
    )
    by_device = {}
    for e in ordered:
        dev = e.get("device") or e.get("mount")
        if dev in by_device:
            if e.get("removable"):
                by_device[dev]["removable"] = True
            continue
        by_device[dev] = e
    mounts = list(by_device.values())

    # One lsblk walk feeds both the inventory and the system-disk lookup —
    # the classifier used to call this inline, which would now run lsblk twice
    # per snapshot.
    lsblk_tree = _lsblk_disks_json()

    snap = {
        "drives": mounts,
        "count": len(mounts),
        "os_disk": os_disk,
        # WARP-936: whole-disk inventory with explicit states. Degrades to []
        # (never a missing key, never an error) on a host without lsblk.
        "disks": classify_disks(lsblk_tree, os_disk),
        "snapshot_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # WARP-2098: the install disk, in a key of its own. ABSENT (never null,
    # never a zeroed object) when it can't be identified, so a consumer can tell
    # "this bridge has nothing to say about the system disk" apart from "the
    # system disk is empty". Added AFTER the two lists above and never merged
    # into either — see system_disk_info.
    system_disk = system_disk_info(
        lsblk_tree, os_disk, _os_disk_filesystems(mount_meta, os_disk))
    if system_disk is not None:
        snap["system_disk"] = system_disk
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
# live behind the auth-gated destructive POST (run_pool_command), which hands
# the op to the root executor unit that runs the repo-tracked host script —
# never mdadm directly. Returns [] honestly when md has no arrays (the
# owner's "no fake pool" constraint at the read layer).

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
                # WARP-936: parenthesised state annotations — e.g.
                # "(auto-read-only)" on a fresh, never-written array — sit
                # between the md state and the raid token and are NOT member
                # disks. The live box's /pools listed "(auto-read-only)" as a
                # member before this guard.
                if t.startswith("("):
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


# ---------------------------------------------------------------------------
# Single-box host-uplink probe (VPN home-mode P1.5)
# ---------------------------------------------------------------------------
# On the single-box deployment shape the WAN uplink is HOST-owned (not inside the
# containerised OpenWrt), so the routing-service network summary reports
# wan.present == false and the orchestrator's home-mode endpoint discovery has no
# IP to hand a HOME-mode WireGuard peer (homeEndpointHost stays null, the mobile
# home toggle stays hidden). This bridge runs in the host's network namespace
# (User=droplet, no PrivateNetwork), so it CAN see the host's real default route.
#
# GET /host/uplink-ip reports the default-route egress source IPv4 — the address
# a HOME-mode peer on the same home LAN dials directly. READ-ONLY: it only
# queries `ip route get` (no host mutation), so — unlike the .env write-backs —
# there is no host script; it shells `ip` directly, exactly like pools_snapshot
# reads /proc/mdstat. Returns {"uplinkIp": "<ip>" | null} — honest null, never a
# fabricated guess.

# The public resolver 1.1.1.1 is used ONLY as a route-lookup target; no packet is
# sent (`ip route get` is a kernel FIB query). It picks the default route the box
# would use to reach the internet, whose `prefsrc` is the box's uplink source IP.
_UPLINK_ROUTE_TARGET = "1.1.1.1"

# Extracts the `src <ip>` field from `ip route get` plain-text output.
_IP_ROUTE_SRC_RE = re.compile(r'\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b')


def _usable_uplink_ip(addr):
    """True unless `addr` is a placeholder that could never be a dial-able home
    endpoint. RFC1918 (192.168/10/172.16-31) is VALID — the home client is on the
    same LAN and reaches the box at its private address. Mirrors the orchestrator's
    isUsableHostIp() in lib/vpn-home-endpoint.ts."""
    if not isinstance(addr, str):
        return False
    a = addr.strip()
    if not a:
        return False
    if a == "0.0.0.0":            # unspecified / DHCP-pending placeholder
        return False
    if a.startswith("127."):      # loopback (no default route → resolves to lo)
        return False
    if a.startswith("169.254."):  # link-local (no DHCP lease)
        return False
    return True


def _parse_uplink_ip(output):
    """Parse the default-route source IPv4 out of `ip route get` output.

    Accepts BOTH shapes so we don't depend on iproute2 JSON support:
      - `ip -j route get`  → a JSON array; read the first entry's `prefsrc`.
      - `ip route get`     → plain text `... src <ip> ...`.
    Returns the usable source IP, or None (never a guess) when the output has no
    usable address (loopback/link-local/unspecified placeholders are filtered)."""
    if not output:
        return None
    text = output.strip()
    # JSON shape first (only if it actually looks like JSON — a plain-text line
    # starting with the target IP is not JSON).
    if text.startswith("[") or text.startswith("{"):
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, dict):
            data = [data]
        if isinstance(data, list):
            for entry in data:
                if isinstance(entry, dict):
                    src = entry.get("prefsrc") or entry.get("src")
                    if isinstance(src, str) and _usable_uplink_ip(src):
                        return src.strip()
            return None
    # Plain-text fallback.
    m = _IP_ROUTE_SRC_RE.search(text)
    if m and _usable_uplink_ip(m.group(1)):
        return m.group(1)
    return None


def uplink_ip_snapshot():
    """Return {"uplinkIp": "<ip>" | null} — the host default-route egress source
    IPv4. READ-ONLY. Tries `ip -j route get` first, then falls back to plain-text
    `ip route get` for older iproute2 builds. Honest null on any failure; never
    raises (mirrors pools_snapshot's degrade-cleanly posture)."""
    try:
        rc, out, _err = _run(
            ["ip", "-j", "route", "get", _UPLINK_ROUTE_TARGET])
        ip = _parse_uplink_ip(out) if rc == 0 else None
        if ip is None:
            # -j unsupported (older iproute2) or empty JSON — try plain text.
            rc, out, _err = _run(
                ["ip", "route", "get", _UPLINK_ROUTE_TARGET])
            ip = _parse_uplink_ip(out) if rc == 0 else None
        return {"uplinkIp": ip}
    except Exception as e:                                          # noqa: BLE001
        logger.warning("uplink-ip probe failed: %s", e)
        return {"uplinkIp": None}


# ---------------------------------------------------------------------------
# STUN reflexive-mapping probe (WARP-1385) — the box's own public UDP mapping
# ---------------------------------------------------------------------------
# The direct-punch remote-access overlay (ADR-030) needs the box to learn the
# {ip, port} an upstream NAT assigns to traffic leaving from the WireGuard
# source port (51820). The orchestrator's overlay connect agent calls this,
# then hands the mapping to HQ in the `answer` so the phone can aim its
# WireGuard endpoint at the box.
#
# device-bridge runs in the HOST network namespace (root), so it is the one
# place that can send a STUN Binding request FROM host udp/51820 and read the
# reflexive mapping back. This is valid only once WARP-1385 Part A removes
# docker-proxy from host:51820 (wg's socket is in the container netns, so the
# host port is free).
#
# LPE invariant: the STUN server list is INLINED below — device-bridge is root,
# so it must NEVER read this from a droplet-writable path (a guard test
# enforces the no-writable-config rule).

# The host UDP source port the box's WireGuard listener uses. The probe MUST
# originate from it so the observed mapping is the SAME public ip:port the
# overlay hole-punch will use (Part A preserves this source port on egress).
STUN_SOURCE_PORT = 51820

# Two public STUN servers (RFC 5389 Binding). Cloudflare answers on 3478;
# Google's public STUN answers on 19302. Both are registered in
# docs/security/allowed-egress.yaml (WARP-1385). Tried in order; the first that
# answers wins.
_STUN_SERVERS = (
    ("stun.cloudflare.com", 3478),
    ("stun.l.google.com", 19302),
)

# Bounded: one request per server, short timeout, fail closed.
_STUN_TIMEOUT_S = 3.0

_STUN_MAGIC_COOKIE = 0x2112A442
_STUN_BINDING_REQUEST = 0x0001
_STUN_BINDING_SUCCESS = 0x0101
_STUN_ATTR_MAPPED_ADDRESS = 0x0001
_STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020


def _parse_stun_mapped_address(data: bytes, txid: bytes) -> tuple[str, int]:
    """Parse the reflexive (public) IPv4 {ip, port} out of a STUN Binding
    Success Response. Prefers XOR-MAPPED-ADDRESS (0x0020); falls back to the
    legacy MAPPED-ADDRESS (0x0001). Raises ValueError on anything malformed —
    the caller treats a raise as "this server didn't give me a usable mapping"
    and fails closed rather than fabricating one."""
    if len(data) < 20:
        raise ValueError("STUN response shorter than the 20-byte header")
    msg_type, msg_len, cookie = struct.unpack(">HHI", data[:8])
    resp_txid = data[8:20]
    if msg_type != _STUN_BINDING_SUCCESS:
        raise ValueError(f"not a Binding Success Response (type={msg_type:#06x})")
    if cookie != _STUN_MAGIC_COOKIE:
        raise ValueError("STUN magic cookie mismatch")
    if resp_txid != txid:
        raise ValueError("STUN transaction id mismatch (stale/forged response)")
    body = data[20:20 + msg_len]
    off = 0
    while off + 4 <= len(body):
        attr_type, attr_len = struct.unpack(">HH", body[off:off + 4])
        val = body[off + 4:off + 4 + attr_len]
        # Attributes are 32-bit aligned.
        off += 4 + attr_len + ((4 - (attr_len % 4)) % 4)
        if attr_type not in (_STUN_ATTR_XOR_MAPPED_ADDRESS, _STUN_ATTR_MAPPED_ADDRESS):
            continue
        if len(val) < 8:
            raise ValueError("mapped-address attribute too short")
        family = val[1]
        if family != 0x01:
            raise ValueError("mapped address is not IPv4")
        port = struct.unpack(">H", val[2:4])[0]
        addr = struct.unpack(">I", val[4:8])[0]
        if attr_type == _STUN_ATTR_XOR_MAPPED_ADDRESS:
            port ^= (_STUN_MAGIC_COOKIE >> 16)
            addr ^= _STUN_MAGIC_COOKIE
        ip = socket.inet_ntoa(struct.pack(">I", addr))
        return ip, port
    raise ValueError("no MAPPED-ADDRESS attribute in the STUN response")


def _stun_query(host: str, port: int, source_port: int = STUN_SOURCE_PORT,
                timeout: float = _STUN_TIMEOUT_S) -> tuple[str, int]:
    """Send ONE STUN Binding request from host UDP <source_port> to host:port
    and return the reflexive (public) {ip, port}. Raises on timeout / socket
    error / malformed response — the caller fails closed."""
    txid = secrets.token_bytes(12)
    req = struct.pack(">HHI", _STUN_BINDING_REQUEST, 0, _STUN_MAGIC_COOKIE) + txid
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # Bind to the WireGuard source port on all host interfaces so the mapping
        # we observe is the SAME one the wg0 punch uses.
        sock.bind(("0.0.0.0", source_port))
        sock.settimeout(timeout)
        sock.sendto(req, (host, port))
        data, _addr = sock.recvfrom(2048)
    finally:
        sock.close()
    return _parse_stun_mapped_address(data, txid)


def stun_probe_snapshot():
    """Return (ok, payload). On success payload = {"ip", "port", "server"} — the
    box's observed public UDP mapping from host udp/51820. On failure ok=False
    and payload = {"error": ...}. Fails CLOSED — never fabricates a mapping. Each
    inlined STUN server is tried once, in order, until one answers."""
    errors = []
    for host, port in _STUN_SERVERS:
        try:
            ip, mapped_port = _stun_query(host, port)
            return True, {"ip": ip, "port": mapped_port, "server": f"{host}:{port}"}
        except Exception as e:                                      # noqa: BLE001
            errors.append(f"{host}:{port}: {e}")
    return False, {"error": "no STUN response from any server: " + "; ".join(errors)}


# ---------------------------------------------------------------------------
# Host uplink topology (WARP-817) — auto-collapse the onboarding Wi-Fi step
# ---------------------------------------------------------------------------
# The routing service's GET /network/topology (ADR-018,
# droplet_openwrt_sdk.detect_deployment_topology) determines the deployment
# posture by probing the CONTAINERISED OpenWrt's "wan" ubus interface. On
# single-box that interface is never configured — WAN is HOST-owned — so the
# routing-service probe always reports UNKNOWN, and the onboarding wizard can
# never tell "downstream of an existing home router" (the common case) apart
# from "this box IS the primary router".
#
# This bridge runs in the host's network namespace, so it can answer the SAME
# question detect_deployment_topology() answers in the container, translated
# to `ip route` terms — mirroring that function's posture semantics exactly:
#
#   * a default route with an upstream `via <gw>` next-hop -> DOWNSTREAM_ROUTER
#     (something upstream — an existing home router — is routing for us).
#   * a default route with NO next-hop (the box resolves the probe target
#     directly, e.g. a point-to-point WAN)                 -> PRIMARY_ROUTER
#     (the box owns the edge).
#   * no default route resolvable at all                    -> UNKNOWN
#     (never guessed).
#
# READ-ONLY: `ip route get` is a kernel FIB query (mirrors uplink_ip_snapshot
# above) — no mutation, no packet actually sent to the probe target.

_IP_ROUTE_VIA_RE = re.compile(r'\bvia\s+(\d{1,3}(?:\.\d{1,3}){3})\b')
_IP_ROUTE_DEV_RE = re.compile(r'\bdev\s+(\S+)\b')


def _parse_route_topology(output):
    """Parse the uplink iface + optional upstream gateway out of `ip route get`
    output. Accepts the same JSON / plain-text shapes _parse_uplink_ip() does.

    Returns (iface, gateway) — either may be None. `iface` is None only when
    the output carries no usable route at all (never raises)."""
    if not output:
        return None, None
    text = output.strip()
    if text.startswith("[") or text.startswith("{"):
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, dict):
            data = [data]
        if isinstance(data, list):
            for entry in data:
                if isinstance(entry, dict):
                    dev = entry.get("dev")
                    if isinstance(dev, str) and dev:
                        gw = entry.get("gateway")
                        gw = gw.strip() if isinstance(gw, str) and gw.strip() else None
                        return dev, gw
            return None, None
    # Plain-text fallback: "<target> [via <gw>] dev <iface> src <ip> ...".
    dev_m = _IP_ROUTE_DEV_RE.search(text)
    if not dev_m:
        return None, None
    via_m = _IP_ROUTE_VIA_RE.search(text)
    return dev_m.group(1), (via_m.group(1) if via_m else None)


def host_topology_snapshot():
    """Return the host uplink posture — {"posture": ..., "evidence": {...}}.

    Mirrors droplet_openwrt_sdk.detect_deployment_topology()'s posture
    semantics (ADR-018), sourced from the HOST's own default route instead of
    the containerised OpenWrt's ubus WAN status (which single-box never
    populates). READ-ONLY; never raises — any probe failure degrades to
    UNKNOWN with null evidence rather than a guessed posture."""
    iface = gateway = None
    try:
        rc, out, _err = _run(["ip", "-j", "route", "get", _UPLINK_ROUTE_TARGET])
        iface, gateway = _parse_route_topology(out) if rc == 0 else (None, None)
        if iface is None:
            # -j unsupported (older iproute2) or empty JSON — try plain text.
            rc, out, _err = _run(["ip", "route", "get", _UPLINK_ROUTE_TARGET])
            iface, gateway = _parse_route_topology(out) if rc == 0 else (None, None)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("host topology probe failed: %s", e)
        iface, gateway = None, None

    if iface is None:
        posture = "UNKNOWN"
    elif gateway is not None:
        posture = "DOWNSTREAM_ROUTER"
    else:
        posture = "PRIMARY_ROUTER"
    return {
        "posture": posture,
        "evidence": {"uplink_iface": iface, "upstream_gateway": gateway},
    }


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
    # WARP-662: adopt (wipe + reformat + mount) a previously-used disk. Same
    # auth + single-use-confirm-token + host-script-only posture as the pool
    # ops; the host script enforces the OS-disk refusal.
    "drive_adopt",
    # WARP-1048: reclaim a pool-member disk — detach it from its md array
    # (mdadm --fail/--remove + --zero-superblock) then adopt it. Same posture;
    # the host script enforces the OS-disk refusal and requires the owning md.
    "drive_reclaim",
})

# ADR-019 follow-up: the bridge CANNOT exec droplet-storage-pool.sh itself —
# this process runs as User=droplet inside ProtectSystem=strict +
# NoNewPrivileges, where mdadm/mkfs/mount all fail (EPERM on the root:disk
# 0660 block devices, EROFS under /mnt) and the script's blkid "has data"
# probe silently degrades (an unprivileged blkid can't open the device,
# prints nothing, and the guard passes). Verified on the shipping box. So,
# same posture as the WARP-808 hostapd Wi-Fi write but with a different
# split (mdadm is a direct binary — there is no unit to polkit-restart):
# the bridge writes the owner-confirmed request into a spool inside its own
# StateDirectory, then `systemctl start`s a root oneshot
# (droplet-storage-pool-apply.service — authorized for the droplet user by
# 50-droplet-device-bridge.rules, start verb only) which runs the pool
# script as root and writes a result file back into the spool.
POOL_SPOOL_DIR = os.environ.get(
    "DROPLET_POOL_SPOOL_DIR", "/var/lib/droplet-bridge/pool-spool").strip()
POOL_APPLY_UNIT = os.environ.get(
    "DROPLET_POOL_APPLY_UNIT", "droplet-storage-pool-apply.service").strip()

# Serialize concurrent pool writes (mirrors _HOSTAPD_LOCK). The spool holds
# exactly ONE request/result pair, so two racing POSTs would clobber each
# other's files; non-blocking acquire → the second caller is refused, not
# queued.
_POOL_LOCK = threading.Lock()


def run_pool_command(operation, params):
    """Forward an owner-confirmed destructive pool op to the root executor.

    The bridge does NOT run mdadm/mkfs — and (ADR-019 follow-up) it does not
    exec droplet-storage-pool.sh either, because this sandbox can't grant the
    root that script needs. It writes {request_id, operation, params} to the
    pool spool and starts the root apply unit, whose ExecStart consumes the
    request, runs the pool script (whose hard pre-flight — refuse mounted /
    has-data / OS-disk, require the typed double-confirm — is the real safety
    gate, and actually works under root), and writes back a result file
    carrying the script's rc/stdout/stderr. This function only (a) refuses
    operations outside the allow-list, (b) refuses a second in-flight write,
    and (c) surfaces the executor's result honestly. Returns (ok, info);
    never raises — mirrors eject_drive()."""
    if operation not in _POOL_OPS:
        return False, "unknown pool operation: {}".format(operation)
    if not _POOL_LOCK.acquire(blocking=False):
        logger.warning("pool command %s rejected: another storage operation "
                       "is already in progress", operation)
        return False, "another storage operation is already in progress"
    try:
        return _run_pool_via_executor(operation, params)
    finally:
        _POOL_LOCK.release()


def _run_pool_via_executor(operation, params):
    """Spool the request, start the root apply unit, collect the result.

    Split out of run_pool_command so the lock handling above stays trivially
    correct. Same (ok, info) contract; never raises."""
    request_id = secrets.token_hex(8)
    req_path = os.path.join(POOL_SPOOL_DIR, "request.json")
    res_path = os.path.join(POOL_SPOOL_DIR, "result.json")
    try:
        # 0700 like the StateDirectory it lives in — only the bridge user
        # (or root) may place a request. os.makedirs ignores `mode` when the
        # directory already exists, so explicitly chmod it on every start to
        # close the window where a prior install left a looser umask (0755).
        os.makedirs(POOL_SPOOL_DIR, mode=0o700, exist_ok=True)
        os.chmod(POOL_SPOOL_DIR, 0o700)
        # Drop any stale pair from an interrupted earlier run so the executor
        # can never consume an old request and we never read an old result.
        for stale in (req_path, res_path):
            try:
                os.remove(stale)
            except FileNotFoundError:
                pass
        tmp = req_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"request_id": request_id, "operation": operation,
                       "params": params or {}}, f)
        # Atomic rename: the executor never sees a half-written request.
        os.replace(tmp, req_path)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("pool command %s failed to spool request: %s",
                       operation, e)
        return False, "could not spool the pool request"
    try:
        # Blocking start of a Type=oneshot unit returns when its ExecStart
        # exits, i.e. when the result file is already in place. mdadm/mkfs on
        # a large array can take a while; generous but bounded (the unit's
        # own TimeoutStartSec sits just under this).
        rc, out, err = _run(["systemctl", "start", POOL_APPLY_UNIT],
                            timeout=600)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("pool command %s failed to start executor unit: %s",
                       operation, e)
        rc, out, err = 1, "", str(e)
    if rc != 0:
        # The unit never ran (polkit denied / not installed) or died at the
        # executor level (no/malformed request). Remove the unconsumed
        # request so it can't be picked up by a later start.
        try:
            os.remove(req_path)
        except OSError:
            pass
        msg = (err.strip() or out.strip() or "pool executor failed to start")
        logger.warning("pool command %s executor start failed (rc=%s): %s",
                       operation, rc, msg)
        return False, msg
    try:
        with open(res_path) as f:
            result = json.load(f)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("pool command %s: executor wrote no readable result: %s",
                       operation, e)
        return False, "pool executor returned no readable result"
    finally:
        try:
            os.remove(res_path)
        except OSError:
            pass
    if result.get("request_id") != request_id:
        # A leftover from some other run — never report it as ours.
        logger.warning("pool command %s: stale executor result ignored",
                       operation)
        return False, "pool executor result did not match this request"
    script_rc = result.get("rc")
    script_out = result.get("stdout") or ""
    script_err = result.get("stderr") or ""
    if script_rc is None or script_rc != 0:
        msg = (script_err.strip() or script_out.strip()
               or "host script refused")
        logger.warning("pool command %s refused/failed (rc=%s): %s",
                       operation, script_rc, msg)
        return False, msg
    # Invalidate the pools cache so the next GET /pools reflects the change.
    pools_snapshot(invalidate=True)
    # Any pool op can change which drives are free vs. in-use (pool_create,
    # pool_destroy, pool_format, pool_add_spare, pool_remove_disk all alter
    # md membership; drive_adopt also mounts under /mnt/droplet). Invalidate
    # drives unconditionally so the next GET /drives reflects the new state
    # within the cache TTL. NB this deliberately BROADENS the previous
    # behavior (main invalidated drives only for drive_adopt; pools_snapshot
    # was the unconditional one) — every pool op changes free/in-use drive
    # state, so they all deserve the invalidation.
    drives_snapshot(invalidate=True)
    try:
        return True, json.loads(script_out or "{}")
    except (ValueError, TypeError):
        return True, {"message": script_out.strip()}


# ---------------------------------------------------------------------------
# Single-box hostapd Wi-Fi WRITE (WARP-808)
# ---------------------------------------------------------------------------
#
# The single-box AP is a raw `hostapd -B` in the droplet-openwrt container,
# configured from /etc/hostapd.conf which droplet-openwrt-attach regenerates
# from DROPLET_AP_SSID/DROPLET_AP_PSK. So writing the customer's Wi-Fi name +
# key is a host action: upsert the customer keys in the bridge's StateDirectory
# creds file (/var/lib/droplet-bridge/openwrt-attach.env, droplet-owned so this
# sandboxed process can rewrite it — WARP-843; root then parses only the
# whitelisted DROPLET_AP_*/DROPLET_GUEST_* keys out of it with validation, never
# as an EnvironmentFile). Exactly like the destructive pool ops, the bridge
# NEVER writes /etc/hostapd.conf or restarts hostapd itself — it shells the
# repo-tracked host script (scripts/host/droplet-set-hostapd.sh, installed to
# /usr/local/sbin by setup.sh), whose hard validation (SSID 1-32 / PSK 8-63,
# reject-before-write) is the real gate. Because the bridge runs unprivileged
# the script skips the systemctl restart; the root-owned
# droplet-openwrt-attach.path unit watches that creds file and re-applies the
# change (regenerate hostapd.conf + respawn via the HOSTAPD_CHANGED gate).
# The PSK is a per-device secret and is NEVER logged here.

HOSTAPD_SCRIPT = os.environ.get(
    "DROPLET_HOSTAPD_SCRIPT", "/usr/local/sbin/droplet-set-hostapd.sh").strip()


def run_set_hostapd(params):
    """Forward an owner-confirmed single-box Wi-Fi write to the host script.

    `params` is {"ssid": str, "psk": str}. The bridge does NOT touch hostapd /
    systemctl — it execs droplet-set-hostapd.sh with the params as a single JSON
    argument; the script validates (SSID 1-32 / PSK 8-63) BEFORE writing and
    upserts the attach env file. Running unprivileged here, the script defers
    the re-apply to the root droplet-openwrt-attach.path unit (WARP-843) — its
    success JSON reports restarted:false, reapply:"path-unit".
    Never raises — mirrors run_pool_command()/eject_drive().

    Returns a structured (ok, code, info) triple so the HTTP handler keys the
    status code on a stable machine `code`, NOT a substring of the human
    message (WARP-834 finding 1):
      - (True,  "ok",           <host-script JSON dict>) — applied
      - (False, "busy",         <msg>) — another write holds the lock → 409
      - (False, "script_error", <msg>) — host-script validation/run failure → 422
      - (False, "exec_error",   <msg>) — couldn't exec the host script → 422
    The host script restarts droplet-openwrt-attach.service, whose systemd
    stderr can itself contain the words "in progress" (e.g. "Job is already
    queued or in progress for ..."); keying contention on `code == "busy"`
    instead of `"in progress" in msg` stops that from being misread as a 409.
    The PSK is never logged (architecture-guard rule 19)."""
    ssid = (params or {}).get("ssid", "")
    psk = (params or {}).get("psk", "")
    payload = json.dumps({"ssid": ssid, "psk": psk})
    # Serialize concurrent writes (mirrors rotate_wifi_key's _ROTATION_LOCK). Two
    # threads racing here would interleave the env-file write and double-restart
    # the attach service / bounce hostapd. Non-blocking: a second in-flight write
    # is rejected (the handler maps code == "busy" to 409) rather than queued.
    if not _HOSTAPD_LOCK.acquire(blocking=False):
        logger.warning("set_hostapd rejected: a Wi-Fi write is already in progress")
        return False, "busy", "hostapd write already in progress"
    try:
        try:
            # Writing the env file + restarting the attach service (which respawns
            # hostapd) takes a few seconds; allow a bounded window.
            rc, out, err = _run([HOSTAPD_SCRIPT, payload], timeout=60)
        except Exception as e:                                      # noqa: BLE001
            # Log the SSID only — never the params dict (it carries the PSK).
            logger.warning("set_hostapd failed to exec host script (ssid=%r): %s",
                           ssid, e)
            return False, "exec_error", "host script unavailable"
        if rc != 0:
            msg = (err.strip() or out.strip() or "host script refused")
            logger.warning("set_hostapd refused/failed (rc=%s, ssid=%r): %s",
                           rc, ssid, msg)
            return False, "script_error", msg
        # qr_snapshot() re-reads the creds on every call (the cached value is only
        # the hostapd-vs-uci *mode*, which a Wi-Fi write never changes) and the
        # hostapd creds fall back to parsing the container's regenerated
        # /etc/hostapd.conf, so the next GET /openwrt/qr reflects the new SSID with
        # no invalidation.
        try:
            return True, "ok", json.loads(out or "{}")
        except (ValueError, TypeError):
            return True, "ok", {"message": (out or "").strip()}
    finally:
        _HOSTAPD_LOCK.release()


# ---------------------------------------------------------------------------
# Guest Wi-Fi write (single-box second BSS)
# ---------------------------------------------------------------------------
#
# Sibling of run_set_hostapd. The guest network is an OPTIONAL, isolated second
# hostapd BSS. The bridge NEVER writes hostapd.conf / restarts hostapd itself —
# it shells the repo-tracked host script (scripts/host/droplet-set-guest-wifi.sh,
# installed to /usr/local/sbin by setup.sh), whose hard validation (SSID 1-32 /
# PSK 8-63, reject-before-write) is the real gate. The guest PSK is a per-device
# secret and is NEVER logged here.
GUEST_SCRIPT = os.environ.get(
    "DROPLET_GUEST_SCRIPT", "/usr/local/sbin/droplet-set-guest-wifi.sh").strip()


def _read_guest_env():
    """Read the persisted guest Wi-Fi state from the attach env file.

    droplet-set-guest-wifi.sh upserts DROPLET_GUEST_SSID/PSK/ENABLED there. We
    parse only those three keys. Returns the orchestrator-facing status dict
    {configured, enabled, ssid, password}; `configured` is False when no guest
    SSID is set (the common default). Never raises."""
    vals = {}
    try:
        with open(GUEST_ENV_FILE, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if line.startswith("DROPLET_GUEST_") and "=" in line:
                    key, _, val = line.partition("=")
                    vals[key] = val
    except Exception:                                               # noqa: BLE001
        pass
    ssid = vals.get("DROPLET_GUEST_SSID", "") or None
    psk = vals.get("DROPLET_GUEST_PSK", "") or None
    enabled = vals.get("DROPLET_GUEST_ENABLED", "0") == "1"
    return {
        "configured": ssid is not None,
        "enabled": bool(ssid) and enabled,
        "ssid": ssid,
        "password": psk,
    }


# --- Guest radio capability -------------------------------------------------
# A guest network is a SECOND AP BSS on the same radio. Whether the card can do
# that is hardware-dependent: mt76/MT7922 hosts many BSSes; iwlwifi/AX210 caps AP
# interfaces at 1 (`iw phy` reports `#{ AP, ... } <= 1`), so a guest BSS is
# IMPOSSIBLE there. We must report `supported` honestly per box so the dashboard
# never offers (or fakes) a guest network the radio can't broadcast — and so the
# write path refuses up front instead of leaning on the attach script's
# home-AP-only fallback (which would leave a "configured" guest that never airs).
#
# Cached like _use_hostapd_mode: the AP-BSS limit is a static hardware property,
# and the `iw phy` read is a docker exec we don't want on every status poll.
# Definitive hardware results (True/False) use the full 300 s TTL; a None result
# (container/iw transiently unavailable) uses 30 s so a brief container restart
# doesn't block writes on a capable radio for the full window.
_GUEST_RADIO_TTL_S = 300.0
_GUEST_RADIO_INFRA_TTL_S = 30.0
_guest_radio_lock = threading.Lock()
_guest_radio_cache = {"value": None, "at": 0.0}


def _ap_phy_in_container():
    """Find the phy hosting the AP iface (`type AP`) inside the AP container.

    Parses `iw dev`. Returns the phy name (e.g. "phy1") or None. Never raises."""
    rc, out, _ = _run(["docker", "exec", AP_HOSTAPD_CONTAINER, "iw", "dev"], timeout=8)
    if rc != 0:
        return None
    cur_phy = None
    cur_if = None
    for raw in (out or "").splitlines():
        s = raw.strip()
        m = re.match(r"phy#(\d+)", s)
        if m:
            cur_phy = "phy" + m.group(1)
            cur_if = None
            continue
        m = re.match(r"Interface\s+(\S+)", s)
        if m:
            cur_if = m.group(1)
            continue
        if s == "type AP" and cur_phy and cur_if:
            return cur_phy
    return None


def _radio_supports_second_bss(phy):
    """True iff `phy` advertises an interface combination allowing >= 2 AP BSSes.

    Reads `iw phy <phy> info` and scans the `valid interface combinations` for
    any `#{ ...AP... } <= N` group with N >= 2. iwlwifi/AX210 -> N=1 (False);
    mt76/MT7922 -> N>=2 (True). Never raises."""
    if not phy:
        return False
    rc, out, _ = _run(
        ["docker", "exec", AP_HOSTAPD_CONTAINER, "iw", "phy", phy, "info"], timeout=8)
    if rc != 0:
        return False
    # `[^}]*` spans the wrapped, multi-line combination groups (it matches \n).
    nums = [int(n) for grp, n in re.findall(r"#\{\s*([^}]*)\}\s*<=\s*(\d+)", out or "")
            if re.search(r"\bAP\b", grp)]
    return bool(nums) and max(nums) >= 2


def guest_radio_supported():
    """Whether the AP radio can host a guest (second) BSS. Cached + fail-CLOSED.

    Returns False whenever the capability can't be determined (container/iw
    unreachable) — we never claim a guest network the card may not be able to
    broadcast. Definitive hardware results (True/False) are cached for the full
    _GUEST_RADIO_TTL_S; a None result (infra transiently unavailable) uses the
    shorter _GUEST_RADIO_INFRA_TTL_S so a brief container restart doesn't block
    writes on a capable radio for the full window."""
    now = time.time()
    with _guest_radio_lock:
        cached = _guest_radio_cache["value"]
        age = now - _guest_radio_cache["at"]
        ttl = _GUEST_RADIO_INFRA_TTL_S if cached is None else _GUEST_RADIO_TTL_S
        if _guest_radio_cache["at"] > 0.0 and age < ttl:
            return False if cached is None else cached
    value = _radio_supports_second_bss(_ap_phy_in_container())
    with _guest_radio_lock:
        _guest_radio_cache["value"] = value
        _guest_radio_cache["at"] = now
    return value if value is not None else False


def run_set_guest_wifi(params):
    """Forward an owner-confirmed guest Wi-Fi create/update to the host script.

    `params` is {"ssid": str, "psk": str}. Mirrors run_set_hostapd: shells
    droplet-set-guest-wifi.sh with a single JSON arg; the script validates,
    upserts the guest keys, and restarts droplet-openwrt-attach.service (which
    stands up the second BSS + guest subnet + isolated firewall zone). Never
    raises. Returns (ok, code, info) with the SAME code vocabulary as
    run_set_hostapd (ok / busy / script_error / exec_error). PSK never logged."""
    ssid = (params or {}).get("ssid", "")
    psk = (params or {}).get("psk", "")
    payload = json.dumps({"ssid": ssid, "psk": psk})
    if not _GUEST_LOCK.acquire(blocking=False):
        logger.warning("set_guest_wifi rejected: a guest Wi-Fi write is already in progress")
        return False, "busy", "guest Wi-Fi write already in progress"
    try:
        try:
            rc, out, err = _run([GUEST_SCRIPT, payload], timeout=60)
        except Exception as e:                                      # noqa: BLE001
            logger.warning("set_guest_wifi failed to exec host script (ssid=%r): %s", ssid, e)
            return False, "exec_error", "host script unavailable"
        if rc != 0:
            msg = (err.strip() or out.strip() or "host script refused")
            logger.warning("set_guest_wifi refused/failed (rc=%s, ssid=%r): %s", rc, ssid, msg)
            return False, "script_error", msg
        try:
            return True, "ok", json.loads(out or "{}")
        except (ValueError, TypeError):
            return True, "ok", {"message": (out or "").strip()}
    finally:
        _GUEST_LOCK.release()


def run_remove_guest_wifi():
    """Tear down the guest network via the host script ({"action":"remove"}).

    Idempotent — a remove on a never-configured box is a clean no-op. Same lock +
    (ok, code, info) contract as run_set_guest_wifi. No secret to log."""
    payload = json.dumps({"action": "remove"})
    if not _GUEST_LOCK.acquire(blocking=False):
        logger.warning("remove_guest_wifi rejected: a guest Wi-Fi write is already in progress")
        return False, "busy", "guest Wi-Fi write already in progress"
    try:
        try:
            rc, out, err = _run([GUEST_SCRIPT, payload], timeout=60)
        except Exception as e:                                      # noqa: BLE001
            logger.warning("remove_guest_wifi failed to exec host script: %s", e)
            return False, "exec_error", "host script unavailable"
        if rc != 0:
            msg = (err.strip() or out.strip() or "host script refused")
            logger.warning("remove_guest_wifi failed (rc=%s): %s", rc, msg)
            return False, "script_error", msg
        try:
            return True, "ok", json.loads(out or "{}")
        except (ValueError, TypeError):
            return True, "ok", {"message": (out or "").strip()}
    finally:
        _GUEST_LOCK.release()


# ---------------------------------------------------------------------------
# Factory reset (WARP-825)
# ---------------------------------------------------------------------------
#
# A factory reset wipes every data volume + the generated secrets and bounces
# the whole stack (scripts/factory-reset.sh runs `docker compose down -v`, which
# kills the orchestrator AND eventually this device-bridge). So unlike every
# other host action here — which shells a host script via the BLOCKING `_run`
# and waits for the result — the reset MUST be spawned DETACHED: we hand the
# wipe to the repo-tracked host script (scripts/host/droplet-factory-reset.sh,
# installed to /usr/local/sbin by setup.sh) with a non-blocking Popen and return
# ~immediately, so the wipe survives the bridge's own teardown.
#
# The bridge NEVER runs `docker compose down -v` itself — the host script (which
# wraps scripts/factory-reset.sh --yes) is the real executor.

RESET_SCRIPT = os.environ.get(
    "DROPLET_FACTORY_RESET_SCRIPT",
    "/usr/local/sbin/droplet-factory-reset.sh").strip()


def _spawn_detached(cmd):
    """Spawn a long-running host command fully detached from this process.

    Returns (proc, error). `proc` is the live `subprocess.Popen` on a
    successful launch — NOT a finished wipe (we deliberately don't wait; the
    wipe outlives us). The caller keeps the handle so a LATER reset request can
    poll() it: a detached wipe that exits without tearing this bridge down has
    failed, and polling lets us reclaim the stale lock instead of wedging every
    future reset at 409. A launch failure (script missing / not executable)
    returns (None, <reason>).

    Detached so the child keeps running after the bridge is torn down by the
    very wipe it kicked off: new session (setsid / new process group), stdio
    redirected away from our pipes so the child isn't tied to our lifetime.
    """
    try:
        kwargs = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        # Detach into its own session so a teardown of the bridge's process
        # group doesn't take the wipe down with it. start_new_session is the
        # portable (POSIX) way; guard for platforms without it.
        if hasattr(os, "setsid"):
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(cmd, **kwargs)  # noqa: S603 — fixed argv, no shell
        return proc, None
    except FileNotFoundError:
        return None, "host script not found"
    except Exception as e:                                          # noqa: BLE001
        return None, str(e)


# Allow-listed shape for the informational factory-reset context fields
# (CodeQL py/command-line-injection #66). jobId is a cuid (`ResetJob.id`);
# targetName is boxDisplayName() — the validated box-name slug, else the
# public FQDN, else the LAN fallback host — which the owner typed to confirm.
# ASCII word characters and `._:-`, bounded — nothing legitimate is excluded,
# nothing else reaches the host script's argv.
_RESET_CONTEXT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


def _reset_context_field(key, value):
    """The allow-listed value, or "". Logged by KEY only — never the value."""
    if isinstance(value, str) and _RESET_CONTEXT_RE.fullmatch(value):
        return value
    if value not in ("", None):
        logger.warning(
            "factory reset: dropping out-of-shape %s from the job context", key)
    return ""


def run_factory_reset(params):
    """Dispatch an owner-confirmed factory reset to the host script, DETACHED.

    `params` is {"jobId": str, "targetName": str} (informational — the host
    script wipes the whole box regardless; we pass them so the host log can
    attribute the reset). The bridge does NOT touch docker/volumes/.env itself —
    it spawns droplet-factory-reset.sh detached. Returns (ok, info); never raises
    — mirrors run_pool_command()/run_set_hostapd().

    `ok` means the wipe was LAUNCHED, not that it finished: a factory reset
    cannot report completion (the stack it would report through is being wiped).
    """
    # CodeQL py/command-line-injection (#66): both fields come off the request
    # body and end up in the host script's argv (as one JSON string — never a
    # shell; see _spawn_detached). They are informational only — the script
    # pulls jobId out for its log line and wipes the box regardless — so an
    # out-of-shape value is dropped to "" and logged rather than refusing the
    # reset over a cosmetic field. What reaches argv is always allow-listed.
    job_id = _reset_context_field("jobId", (params or {}).get("jobId", ""))
    target_name = _reset_context_field(
        "targetName", (params or {}).get("targetName", ""))
    payload = json.dumps({"jobId": job_id, "targetName": target_name})
    global _factory_reset_proc
    # Serialize the spawn decision (mirrors run_set_hostapd's _HOSTAPD_LOCK). Two
    # threads racing here would each launch the wipe — two `docker compose down
    # -v` runs racing the same teardown. Non-blocking: a second in-flight reset is
    # rejected (the handler maps code == "busy" to 409) rather than queued.
    if not _FACTORY_RESET_LOCK.acquire(blocking=False):
        # The lock is held. Either a wipe is genuinely in flight, or a previous
        # wipe FAILED mid-run — it exited without tearing this bridge down and
        # left the lock held forever, so every later reset 409s for the life of
        # the process (manual SSH to restart the bridge was the only recovery).
        # Poll the tracked process to tell the two apart.
        prior = _factory_reset_proc
        if prior is None or prior.poll() is None:
            # No tracked process, or it is still running → genuinely in progress.
            logger.warning("factory reset rejected: a reset is already in progress")
            return False, "busy"
        # The prior wipe exited without completing the teardown → it failed.
        # Reclaim the stale lock so this attempt can proceed.
        logger.warning(
            "factory reset: prior wipe exited (rc=%s) without completing the "
            "teardown — reclaiming the stale lock for a retry", prior.returncode)
        _factory_reset_proc = None
        _FACTORY_RESET_LOCK.release()
        if not _FACTORY_RESET_LOCK.acquire(blocking=False):
            # Lost the race to a concurrent retry — treat as in-progress.
            logger.warning("factory reset rejected: a reset is already in progress")
            return False, "busy"
    released = False
    try:
        try:
            # Pass the job context as a single JSON arg, same convention as the
            # pool / hostapd host scripts.
            proc, err = _spawn_detached([RESET_SCRIPT, payload])
        except Exception as e:                                      # noqa: BLE001
            logger.warning("factory reset failed to spawn host script: %s", e)
            return False, "host script unavailable"
        if proc is None:
            logger.warning("factory reset host script not launched: %s", err)
            return False, (err or "host script refused")
        # Launched. Track the process so a later reset can distinguish a live
        # wipe from one that failed (see _factory_reset_proc). Do NOT release the
        # lock: the wipe is now tearing the box (and this process) down, and a
        # release here would re-open the double-fire window for a request that
        # lands before teardown completes. On the failure paths above we DO
        # release (via finally) so a retry after a failed launch can proceed.
        _factory_reset_proc = proc
        released = True
        logger.warning("factory reset dispatched to host script (job=%s)", job_id)
        return True, {"dispatched": True, "jobId": job_id}
    finally:
        if not released:
            _FACTORY_RESET_LOCK.release()


# ---------------------------------------------------------------------------
# Diagnostics log bundle (WARP-823) — READ-ONLY, via the host collector script
# ---------------------------------------------------------------------------
#
# The Settings → "Download diagnostics" feature ships the box's service logs
# (journald units + container logs) to the owner. The bridge does NOT read
# journald / `docker logs` itself — it execs the repo-tracked host collector
# (scripts/host/droplet-collect-logs.sh, installed to /usr/local/sbin by
# setup.sh / install-device-bridge.sh), which bounds the window + per-service
# size AND redacts secrets on the host. The orchestrator redacts AGAIN before
# zipping, so a stale collector can never leak past that gate.
#
# Mirrors run_pool_command()/run_set_hostapd(): allow-listed shape, host-script
# only, surfaces the script's exit honestly, never raises.

LOGS_SCRIPT = os.environ.get(
    "DROPLET_LOGS_SCRIPT", "/usr/local/sbin/droplet-collect-logs.sh").strip()

# Bounded look-back window the collector accepts (hours). Matches the
# orchestrator route's cap so a client can't ask the host for an unbounded
# journald history.
_LOGS_MIN_HOURS = 1
_LOGS_MAX_HOURS = 168  # 7 days
# Service-filter allow-list: 1–64 ASCII word characters / hyphens, no leading
# dash (see collect_logs). Compose service names all fit; nothing else passes.
_LOGS_SERVICE_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,63}")


def collect_logs(window_hours, service):
    """Collect bounded, host-side-redacted service logs via the host script.

    `window_hours` is clamped to [1, 168] BEFORE it reaches the script so the
    bridge never requests an unbounded history. `service`, when set, is an
    optional single-service filter passed through. The bridge execs
    droplet-collect-logs.sh with the window as a positional arg and the service
    as a second arg; the script returns a JSON bundle on stdout. Returns
    (ok, info); never raises — mirrors run_pool_command()/eject_drive()."""
    try:
        hours = int(window_hours)
    except (TypeError, ValueError):
        hours = 24
    hours = max(_LOGS_MIN_HOURS, min(_LOGS_MAX_HOURS, hours))
    # Pass the service filter only when it is a sane, shell-safe token. The
    # orchestrator already validates it, but the bridge is defense-in-depth: an
    # empty/garbage value becomes "" (the script treats that as "all services").
    # The gate is an explicit ASCII allow-list (CodeQL py/command-line-injection
    # #65 — this value reaches the host script's argv): no leading dash, so a
    # flag-shaped value like "--orchestrator" cannot reach
    # droplet-collect-logs.sh as an option argument rather than a service name;
    # and a fixed character class rather than `str.isalnum()`, which is
    # Unicode-aware and let non-ASCII "letters" through.
    svc = service if (isinstance(service, str)
                      and _LOGS_SERVICE_RE.fullmatch(service)) else ""
    cmd = [LOGS_SCRIPT, str(hours), svc]
    try:
        # Collecting + redacting logs across services can take a moment on a busy
        # box; allow a bounded window (the orchestrator fetch has its own outer
        # timeout).
        rc, out, err = _run(cmd, timeout=45)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("collect_logs failed to exec host script: %s", e)
        return False, "host script unavailable"
    if rc != 0:
        msg = (err.strip() or out.strip() or "host script refused")
        logger.warning("collect_logs refused/failed (rc=%s): %s", rc, msg)
        return False, msg
    try:
        return True, json.loads(out or "{}")
    except (ValueError, TypeError):
        # A 0-exit script that printed non-JSON: surface honestly rather than
        # pretend it failed (mirrors run_pool_command()).
        return True, {"message": (out or "").strip()}


# --- ADR-023 (C2): gateway-nginx reload host executor -----------------------
# The orchestrator's tls-issuance cron writes a freshly-issued LE fullchain into
# docker/certs/droplet.crt and then POSTs /tls/reload here. The bridge execs the
# repo-tracked host wrapper (scripts/host/droplet-tls-reload.sh, installed to
# /usr/local/sbin by setup.sh / install-device-bridge.sh), which delegates to the
# shared scripts/lib/tls-reload.sh::reload_gateway_nginx — the SAME reload path
# the self-signed bootstrap uses. The orchestrator deliberately does NOT mount
# the docker socket (ADR-023), so the `docker compose exec gateway nginx -s
# reload` has to run on the host.
#
# Mirrors collect_logs(): allow-listed shape (no args), host-script only,
# synchronous + bounded, surfaces the script's exit honestly, never raises.

TLS_RELOAD_SCRIPT = os.environ.get(
    "DROPLET_TLS_RELOAD_SCRIPT", "/usr/local/sbin/droplet-tls-reload.sh").strip()


def run_tls_reload():
    """Reload the gateway nginx so a freshly-installed cert is served at once.

    Takes no parameters — the cert files are already on disk (the orchestrator
    wrote them atomically before calling). Returns (ok, info); never raises —
    mirrors collect_logs()/run_pool_command()."""
    try:
        # A reload is fast; a stuck `docker compose exec` is the only slow case.
        rc, out, err = _run([TLS_RELOAD_SCRIPT], timeout=30)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("tls reload failed to exec host script: %s", e)
        return False, "host script unavailable"
    if rc != 0:
        msg = (err.strip() or out.strip() or "host script refused")
        logger.warning("tls reload refused/failed (rc=%s): %s", rc, msg)
        return False, msg
    return True, {"message": (out or "").strip() or "gateway reloaded"}


# --- WARP-1639: rack-panel console handback ---------------------------------
# THE DEBUG BUTTON'S PRIVILEGED HALF.
#
# The rack panel is a plain HDMI monitor on the box's iGPU, so the display
# service owning it means the kernel console does NOT — i.e. claiming the panel
# takes the operator's physical console away. That is only acceptable if there
# is a way back that does not already require a shell. This is it: the panel's
# own on-screen debug affordance POSTs /panel/console, and we hand the
# framebuffer back to fbcon and switch to a login VT.
#
# The bridge cannot do the work itself — writing /sys/class/vtconsole/*/bind
# and calling chvt both need root, and this sandbox is User=droplet +
# ProtectSystem=strict + NoNewPrivileges. So, exactly like the storage-pool
# split, the privileged half lives in a root oneshot
# (droplet-panel-console.service) and the bridge only asks PID 1 to start it.
# 50-droplet-device-bridge.rules grants the droplet user the `start` verb on
# that unit and nothing else.
#
# Note there is deliberately NO reverse route. Handing the console BACK to the
# display service (`claim`) must not be remotely triggerable — pulling the
# console out from under someone who is mid-debug is exactly the failure this
# whole path exists to prevent. Reclaim happens on the host, either from the
# deadman once the hold expires or explicitly over SSH.
PANEL_CONSOLE_UNIT = os.environ.get(
    "DROPLET_PANEL_CONSOLE_UNIT", "droplet-panel-console.service").strip()


def run_panel_console():
    """Hand the rack panel's framebuffer back to the kernel console.

    Returns (ok, info); never raises — mirrors run_tls_reload(). A blocking
    start of a Type=oneshot unit returns once its ExecStart has exited, so a
    200 here means the console really is back, not merely requested."""
    try:
        rc, out, err = _run(["systemctl", "start", PANEL_CONSOLE_UNIT],
                            timeout=30)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("panel console handback failed to start unit: %s", e)
        return False, "could not start the panel console unit"
    if rc != 0:
        # The unit is missing, or polkit denied the start. Say so plainly: the
        # caller is a person standing at a rack trying to get a prompt.
        msg = (err.strip() or out.strip() or "panel console unit failed")
        logger.warning("panel console handback failed (rc=%s): %s", rc, msg)
        return False, msg
    logger.info("panel console handed back to the operator")
    return True, {"message": "console returned to the panel"}


# --- ADR-023 PR-1: public-FQDN write-back host executor ---------------------
# The orchestrator's tls-issuance service LEARNS the box's opaque per-device
# FQDN from the HQ challenge response and POSTs it to /host/public-fqdn so it can
# be persisted back to the host .env (DROPLET_PUBLIC_FQDN) for the next boot, and
# so split-horizon DNS re-registers. The bridge execs the repo-tracked host
# wrapper (scripts/host/droplet-set-public-fqdn.sh, installed to /usr/local/sbin
# by install-device-bridge.sh). The orchestrator can't write the host .env
# itself (no host mount), so — exactly like run_tls_reload for the docker socket
# — the write has to run on the host.
#
# Mirrors run_set_hostapd()/run_tls_reload(): allow-listed shape, host-script
# only, synchronous + bounded, surfaces the script's exit honestly, never raises.

SET_PUBLIC_FQDN_SCRIPT = os.environ.get(
    "DROPLET_SET_PUBLIC_FQDN_SCRIPT",
    "/usr/local/sbin/droplet-set-public-fqdn.sh").strip()

# STRICT validation BEFORE exec. Accept either the opaque per-device shape
# (`d-<16 hex>.devices.warp-lab.ai`) or a conservative lowercase hostname charset
# (defence in depth — the host script validates again). Anything with shell
# metacharacters, whitespace, uppercase, path traversal, or absurd length is
# refused here and the host script is NEVER invoked.
_PUBLIC_FQDN_OPAQUE_RE = re.compile(r'^d-[0-9a-f]{16}\.devices\.warp-lab\.ai$')
_PUBLIC_FQDN_CONSERVATIVE_RE = re.compile(r'^[a-z0-9.-]+$')


def _valid_public_fqdn(fqdn):
    if not isinstance(fqdn, str):
        return False
    if not (1 <= len(fqdn) <= 253):
        return False
    if _PUBLIC_FQDN_OPAQUE_RE.match(fqdn):
        return True
    # Conservative fallback: lowercase letters/digits/dot/hyphen only, and it
    # must look like a dotted hostname (no leading/trailing dot or hyphen).
    if any(c in fqdn for c in (' ', '\n', '\r', '\t')):
        return False
    if not _PUBLIC_FQDN_CONSERVATIVE_RE.match(fqdn):
        return False
    if fqdn[0] in ".-" or fqdn[-1] in ".-":
        return False
    if not all(label and not label.startswith('-') and not label.endswith('-')
               for label in fqdn.split('.')):
        return False
    return "." in fqdn


def run_set_public_fqdn(fqdn):
    """Persist the learned DROPLET_PUBLIC_FQDN to the host .env via the host
    script. Returns (ok, info); never raises — mirrors run_tls_reload()."""
    if not _valid_public_fqdn(fqdn):
        logger.warning("public-fqdn write-back refused: invalid fqdn shape")
        return False, "invalid fqdn"
    try:
        rc, out, err = _run([SET_PUBLIC_FQDN_SCRIPT, fqdn], timeout=30)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("public-fqdn write-back failed to exec host script: %s", e)
        return False, "host script unavailable"
    if rc != 0:
        msg = (err.strip() or out.strip() or "host script refused")
        logger.warning("public-fqdn write-back refused/failed (rc=%s): %s", rc, msg)
        return False, msg
    return True, {"message": (out or "").strip() or "public fqdn persisted"}


# --- WARP-988: box-name write-back host executor -----------------------------
# The wizard's "name your box" step (WARP-979) picks the owner's slug; the
# orchestrator POSTs it to /host/box-name so it can be persisted back to the
# host .env (DROPLET_BOX_NAME) for the next boot, when tls-issuance sends it to
# HQ as `requested_name`. The bridge execs the repo-tracked host wrapper
# (scripts/host/droplet-set-box-name.sh, installed to /usr/local/sbin by
# install-device-bridge.sh). The orchestrator can't write the host .env itself
# (no host mount), so — exactly like run_set_public_fqdn — the write has to run
# on the host.
#
# Mirrors run_set_public_fqdn()/run_tls_reload(): allow-listed shape, host-script
# only, synchronous + bounded, surfaces the script's exit honestly, never raises.

SET_BOX_NAME_SCRIPT = os.environ.get(
    "DROPLET_SET_BOX_NAME_SCRIPT",
    "/usr/local/sbin/droplet-set-box-name.sh").strip()

# STRICT validation BEFORE exec. Conservatively mirrors the shared ruleset in
# packages/shared-types/src/box-name.ts (which the dashboard + orchestrator both
# import): a lowercase slug of [a-z0-9-], 3-40 chars, no leading/trailing/double
# hyphen, and never the `d-<16 hex>` opaque per-device lookalike (ADR-023 —
# a customer name must not impersonate an HQ-minted device identifier). The
# reserved-word blocklist is policy, enforced upstream (orchestrator + HQ);
# the bridge's job is the injection-safe SHAPE (defence in depth — the host
# script validates again). Anything with shell metacharacters, whitespace,
# uppercase, or dots is refused here and the host script is NEVER invoked.
_BOX_NAME_SHAPE_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
_BOX_NAME_DEVICE_LOOKALIKE_RE = re.compile(r'^d-[0-9a-f]{16}$')


def _valid_box_name(name):
    if not isinstance(name, str):
        return False
    if not (3 <= len(name) <= 40):
        return False
    if not _BOX_NAME_SHAPE_RE.match(name):
        return False
    if _BOX_NAME_DEVICE_LOOKALIKE_RE.match(name):
        return False
    return True


def run_set_box_name(name):
    """Persist the owner-chosen DROPLET_BOX_NAME to the host .env via the host
    script. Returns (ok, info); never raises — mirrors run_set_public_fqdn()."""
    if not _valid_box_name(name):
        logger.warning("box-name write-back refused: invalid name shape")
        return False, "invalid name"
    try:
        rc, out, err = _run([SET_BOX_NAME_SCRIPT, name], timeout=30)
    except Exception as e:                                          # noqa: BLE001
        logger.warning("box-name write-back failed to exec host script: %s", e)
        return False, "host script unavailable"
    if rc != 0:
        msg = (err.strip() or out.strip() or "host script refused")
        logger.warning("box-name write-back refused/failed (rc=%s): %s", rc, msg)
        return False, msg
    return True, {"message": (out or "").strip() or "box name persisted"}


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
# WARP-1645: service health for the rack panel's SERVICES cell
# ---------------------------------------------------------------------------
# The orchestrator ALREADY maintains exactly this: health-monitor.service.ts
# background-polls 8 components every 15s and caches the result, and
# /api/orchestrator/health returns that snapshot cheaply (it is what Docker's
# healthcheck hits). We reuse it rather than forming a second opinion.
#
# Deliberately NOT ops-console's /ops/containers: that is backed by
# /var/run/docker.sock, which is root-equivalent on the host. Nothing on the
# panel's data path should need it, and the display container must never get it.
#
# This lives in the bridge rather than in display.py because every other panel
# feed already does (/wifi, /files, /cameras, /drives, /openwrt/qr), and the
# bridge already owns the orchestrator client including the internal-mTLS
# context. One place to normalise, one place to get the TLS right.

# Mirrors HARD_DEPS in health-monitor.service.ts. PRESENTATION ONLY — it drives
# row ordering and dot colour. The authority on whether the box is merely
# degraded or actually down is the orchestrator's own aggregate `status`, which
# we pass through untouched; do not re-derive that here from this list.
_CORE_COMPONENTS = ("postgres",)


def services_snapshot():
    """Normalise the orchestrator's health snapshot for the panel.

    Returns {up, total, status, degraded[]}. On ANY failure every field stays
    None so the panel renders em dashes — never zeros. WARP-1643 shipped two
    fake zeros already; "0/0 services" on a rack front is worse than an honest
    gap, because it reads as a measurement.
    """
    out = {"up": None, "total": None, "status": None, "degraded": []}

    body = None
    url = _orchestrator_base_url() + "/api/orchestrator/health"
    try:
        with urlrequest.urlopen(url, timeout=4,
                                context=_orchestrator_tls_context()) as r:
            body = json.loads(r.read().decode())
    except Exception as e:                                          # noqa: BLE001
        # ⚠ The endpoint answers 503 when the aggregate is `down` — and urlopen
        # raises on 503. Without reading the error body we would show "no data"
        # at exactly the moment the box is most broken, which is the one time
        # this cell has to work. HTTPError is a response object; read it.
        payload = getattr(e, "read", None)
        if callable(payload):
            try:
                body = json.loads(payload().decode())
            except Exception:                                       # noqa: BLE001
                body = None
        if body is None:
            logger.debug("services snapshot unavailable: %s", e)
            return out

    comps = body.get("components") or []
    if not isinstance(comps, list) or not comps:
        return out

    degraded = []
    up = 0
    for c in comps:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "?")
        if c.get("status") == "ok":
            up += 1
        else:
            degraded.append({
                "name": name,
                # Prefer the component's own error text — at a rack, "connection
                # refused" is worth more than "down".
                "state": str(c.get("error") or c.get("status") or "down")[:40],
                "core": name in _CORE_COMPONENTS,
            })
    # Core first, then alphabetical, so the row that matters is never the one
    # pushed off by the 3-row cap.
    degraded.sort(key=lambda s: (not s["core"], s["name"]))

    out["up"] = up
    out["total"] = len(comps)
    out["status"] = body.get("status")
    out["degraded"] = degraded
    return out


# ---------------------------------------------------------------------------
# GPU telemetry (WARP-1861)
# ---------------------------------------------------------------------------
#
# The bridge runs on the host, so it can read both halves of "why is the GPU
# busy": the card's counters under /sys/class/drm, and the processes holding
# it under /sys/class/kfd. Container attribution comes from /proc/<pid>/cgroup,
# whose path already carries the container id — no Docker socket, so this stays
# a read-only probe with no privilege beyond what the bridge already has.
#
# Module-level so tests can repoint them at a fixture tree.
_SYS_DRM = "/sys/class/drm"
_SYS_KFD_PROC = "/sys/class/kfd/kfd/proc"
_PROC = "/proc"

# `card1` yes; `card1-HDMI-A-3` (a connector) no.
_DRM_CARD_RE = re.compile(r"card(\d+)$")
# The 12-char short id, as `docker ps` shows it, out of a cgroup path like
# /system.slice/docker-<64 hex>.scope or /docker/<64 hex>.
_CGROUP_CONTAINER_RE = re.compile(r"(?:docker[-/]|containerd.*?[-/])([0-9a-f]{64})")


def _read_sysfs_int(path):
    """Read a single integer from sysfs, or None if it isn't readable.

    None — never 0. A missing counter and an idle card are different facts,
    and the `|| echo 0` reflex collapses them into a reading that every
    threshold check happily passes.
    """
    try:
        with open(path, "r") as fh:
            return int(fh.read().strip().split()[0])
    except Exception:                                                # noqa: BLE001
        return None


def _drm_cards():
    """DRM card node names, numerically sorted, connector entries excluded.

    Numeric sort so card10 doesn't precede card2 — lexical order would make
    the enumeration depend on how many cards happen to be present.
    """
    try:
        names = os.listdir(_SYS_DRM)
    except Exception:                                                # noqa: BLE001
        return []
    cards = []
    for name in names:
        m = _DRM_CARD_RE.match(name)
        if not m:
            continue
        if not os.path.isdir(os.path.join(_SYS_DRM, name, "device")):
            continue
        cards.append((int(m.group(1)), name))
    return [name for _, name in sorted(cards)]


def resolve_gpu_card():
    """Return the discrete GPU's card node name, or None.

    Resolved by LARGEST mem_info_vram_total — not lowest index, and not a
    hardcoded name. The mini-rack exposes a 15.9 GiB discrete card alongside
    a 512 MiB iGPU carve-out, and the iGPU publishes the same attributes;
    its ~17 MiB of usage sits permanently below any multi-GiB "is the card
    free?" threshold. A lowest-index resolver therefore reports a card that
    is idle by construction while the real one is saturated. Same rule as
    scripts/dmr/flip-single-box.sh's resolve_vram_node().

    BRIDGE_GPU_CARD pins a specific node. A pin naming a card that isn't
    present resolves to None rather than falling back: an operator who
    mistyped the pin should get "unavailable", not plausible numbers from a
    different device.
    """
    cards = _drm_cards()
    pinned = os.environ.get("BRIDGE_GPU_CARD", "").strip()
    if pinned:
        return pinned if pinned in cards else None
    best, best_size = None, -1
    for name in cards:
        size = _read_sysfs_int(
            os.path.join(_SYS_DRM, name, "device", "mem_info_vram_total"))
        if size is not None and size > best_size:
            best, best_size = name, size
    return best


def _hwmon_value(device_dir, filename):
    """Read a hwmon attribute from whichever hwmonN subdir exposes it."""
    hwmon_root = os.path.join(device_dir, "hwmon")
    try:
        subdirs = sorted(os.listdir(hwmon_root))
    except Exception:                                                # noqa: BLE001
        return None
    for sub in subdirs:
        val = _read_sysfs_int(os.path.join(hwmon_root, sub, filename))
        if val is not None:
            return val
    return None


def gpu_processes():
    """Processes currently holding the GPU, newest-listed first.

    Sourced from /sys/class/kfd/kfd/proc, whose entries are named by pid.
    A pid can exit between listing and reading — that race is ordinary, so
    the entry is dropped rather than surfacing a half-null row.
    """
    try:
        entries = os.listdir(_SYS_KFD_PROC)
    except Exception:                                                # noqa: BLE001
        return []
    procs = []
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        base = os.path.join(_PROC, entry)
        try:
            with open(os.path.join(base, "comm"), "r") as fh:
                comm = fh.read().strip()
        except Exception:                                            # noqa: BLE001
            continue                    # exited between listing and read
        try:
            with open(os.path.join(base, "cmdline"), "r") as fh:
                # /proc renders argv NUL-separated; spaces make it readable
                # and keep it a single JSON string.
                cmdline = fh.read().replace("\x00", " ").strip()
        except Exception:                                            # noqa: BLE001
            cmdline = ""
        container_id = None
        try:
            with open(os.path.join(base, "cgroup"), "r") as fh:
                m = _CGROUP_CONTAINER_RE.search(fh.read())
                if m:
                    container_id = m.group(1)[:12]
        except Exception:                                            # noqa: BLE001
            pass
        procs.append({
            "pid": pid,
            "comm": comm,
            # Bounded: a llama-server argv with a long model path is fine to
            # truncate, and an unbounded string here would be echoed into
            # every dashboard poll.
            "cmdline": cmdline[:300],
            "container_id": container_id,
        })
    procs.sort(key=lambda p: p["pid"])
    return procs


def gpu_snapshot():
    """Read-only GPU telemetry: card counters plus who is holding it.

    `available: false` when no card resolves — with every counter null and a
    `reason`, so a caller can never mistake "nothing found" for "idle".
    """
    card = resolve_gpu_card()
    if not card:
        pinned = os.environ.get("BRIDGE_GPU_CARD", "").strip()
        reason = (
            f"BRIDGE_GPU_CARD={pinned} names a card that is not present"
            if pinned else "no DRM card exposing mem_info_vram_total"
        )
        return {
            "available": False,
            "card": None,
            "reason": reason,
            "busy_percent": None,
            "vram_total_bytes": None,
            "vram_used_bytes": None,
            "vram_used_fraction": None,
            "power_watts": None,
            "temp_c": None,
            "processes": [],
        }

    dev = os.path.join(_SYS_DRM, card, "device")
    total = _read_sysfs_int(os.path.join(dev, "mem_info_vram_total"))
    used = _read_sysfs_int(os.path.join(dev, "mem_info_vram_used"))
    power_uw = _hwmon_value(dev, "power1_average")
    temp_mc = _hwmon_value(dev, "temp1_input")

    # Derived here rather than in each consumer so the dashboard tile and the
    # assistant tool can never disagree on the arithmetic.
    fraction = None
    if total and used is not None:
        fraction = round(used / total, 3)

    return {
        "available": True,
        "card": card,
        "reason": None,
        "busy_percent": _read_sysfs_int(os.path.join(dev, "gpu_busy_percent")),
        "vram_total_bytes": total,
        "vram_used_bytes": used,
        "vram_used_fraction": fraction,
        "power_watts": round(power_uw / 1_000_000, 1) if power_uw is not None else None,
        "temp_c": round(temp_mc / 1000, 1) if temp_mc is not None else None,
        "processes": gpu_processes(),
    }


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
                # WARP-659: this read endpoint returns the LAN SSID + PSK
                # (credential material). With BRIDGE_BIND=0.0.0.0 it is
                # LAN-reachable, so it MUST require the shared secret — a
                # wired/mgmt client without the token can no longer lift the
                # Wi-Fi password. Local display + orchestrator both send it.
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                return self._send(200, qr_snapshot())
            if path == "/openwrt/wifi/guest":
                # Guest Wi-Fi status (the body carries the guest PSK for the join
                # QR) — auth-gated like /openwrt/qr. Only meaningful on the
                # single-box hostapd shape; on a uci/multi-box box the guest
                # network lives in UCI (routing service), so refuse with 409.
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                if not _use_hostapd_mode():
                    return self._send(409, {
                        "error": "not_hostapd_mode",
                        "hint": ("Guest Wi-Fi on this deployment shape is managed "
                                 "via UCI through the routing service, not the "
                                 "host hostapd bridge."),
                    })
                # `supported` reflects the radio's REAL multi-BSS capability — a
                # single-AP card (iwlwifi/AX210) cannot broadcast a guest BSS, so
                # the dashboard shows an honest "not available" there instead of a
                # setup form whose write would only fail.
                status = _read_guest_env()
                status["supported"] = guest_radio_supported()
                return self._send(200, status)
            if path == "/files":
                return self._send(200, files_snapshot())
            if path == "/cameras":
                return self._send(200, cameras_snapshot())
            if path == "/services":
                # WARP-1645: component health for the panel's SERVICES cell.
                # Ungated like /wifi and /cameras — it carries no credential
                # material, just component names and up/down, and the panel it
                # feeds is already visible to anyone standing at the rack.
                return self._send(200, services_snapshot())
            if path == "/drives":
                # WARP-659: drive inventory (labels, mount points, usage) is
                # box-internal; gate it like /openwrt/qr now that the bridge
                # binds all interfaces. Both consumers (display, orchestrator)
                # send the token.
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                return self._send(200, drives_snapshot())
            if path == "/pools":
                # BUG-3 / ADR-019: read-only mdadm array inventory. Returns []
                # honestly when no array exists — never a fabricated pool.
                return self._send(200, pools_snapshot())
            if path == "/host/uplink-ip":
                # VPN home-mode P1.5: the host default-route egress source IP,
                # for the orchestrator's single-box home-endpoint fallback. The
                # source IP is box-internal network topology, so gate it like
                # /drives and /openwrt/qr now the bridge binds all interfaces.
                # READ-ONLY (`ip route get` FIB query) — returns
                # {"uplinkIp": <ip>|null}, an honest null, never a guess.
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                return self._send(200, uplink_ip_snapshot())
            if path == "/host/stun-probe":
                # WARP-1385: the box's own public UDP mapping (STUN reflexive
                # {ip, port}) observed from host udp/51820, for the overlay
                # connect agent's `answer`. Box-internal network detail behind a
                # udp/51820 socket bind — auth-gated like /host/uplink-ip. Fails
                # CLOSED with a 502 (never a fabricated mapping) when no STUN
                # server answers.
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                ok, info = stun_probe_snapshot()
                if not ok:
                    return self._send(502, info)
                return self._send(200, info)
            if path == "/host/topology":
                # WARP-817: host uplink posture, for the onboarding wizard's
                # auto-collapse decision. Same box-internal-network-detail
                # rationale as /host/uplink-ip — auth-gated identically.
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                return self._send(200, host_topology_snapshot())
            if path == "/gpu":
                # WARP-1861: read-only GPU telemetry — card counters plus the
                # processes holding it. Auth-gated like /host/topology: the
                # snapshot names running processes and their command lines,
                # which is box-internal detail, and with BRIDGE_BIND=0.0.0.0
                # this is LAN-reachable.
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                return self._send(200, gpu_snapshot())
            if path == "/logs/bundle":
                # WARP-823: diagnostics log bundle. Auth-gated like /openwrt/qr
                # and /drives — the logs can carry box-internal (and, pre-host-
                # redaction, secret) material, so a token is required even on a
                # loopback bind. collect_logs() shells the repo-tracked host
                # collector (which bounds + redacts); the orchestrator redacts
                # again before zipping.
                if not self._authed():
                    return self._send(401, {"error": "unauthorized"})
                q = parse_qs(urlparse(self.path).query)
                hours = (q.get("hours") or ["24"])[0]
                service = (q.get("service") or [""])[0] or None
                ok, info = collect_logs(hours, service)
                if not ok:
                    # 502 — the host collector failed/refused (journalctl absent,
                    # script error). The orchestrator maps this to a clean error.
                    return self._send(502, {"error": info})
                return self._send(200, info)
            if path == "/health":
                return self._send(200, {"ok": True})
        except Exception as e:                                       # noqa: BLE001
            return self._send(500, {"error": str(e)})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        # Mirror do_GET: wrap the whole dispatch so a handler that raises
        # before responding (a non-numeric Content-Length -> ValueError on
        # int(...), or rfile.read().decode() blowing up) returns a clean JSON
        # error instead of escaping the handler — which would otherwise leave
        # the client with a dangling/!200 connection and a stack trace in the
        # bridge log. The real routing lives in _dispatch_post.
        try:
            return self._dispatch_post()
        except ValueError as e:                                      # noqa: BLE001
            # Bad Content-Length (or other malformed-request value): 400.
            return self._send(400, {"ok": False, "error": str(e)})
        except Exception as e:                                       # noqa: BLE001
            # Do not surface str(e) — subprocess errors include the full command
            # line (which may contain OPENWRT_PASS in plaintext). Log for the
            # bridge operator and return a sanitised message to the HTTP client.
            logger.exception("unhandled error in do_POST: %s", e)
            return self._send(500, {"ok": False, "error": "internal server error"})

    def do_DELETE(self):
        # Only route today: DELETE /openwrt/wifi/guest (tear down the guest
        # network). Wrapped like do_POST so a malformed request returns a clean
        # JSON error instead of escaping the handler.
        try:
            if self.path == "/openwrt/wifi/guest":
                # Auth-gated + hostapd-mode gated exactly like the guest POST.
                if not self._authed():
                    return self._send(401, {"ok": False, "error": "unauthorized"})
                if not _use_hostapd_mode():
                    return self._send(409, {
                        "ok": False, "error": "not_hostapd_mode",
                        "hint": ("Guest Wi-Fi on this deployment shape is managed "
                                 "via UCI through the routing service; the host "
                                 "guest teardown does not apply."),
                    })
                ok, code, info = run_remove_guest_wifi()
                if not ok:
                    status = 409 if code == "busy" else (500 if code == "exec_error" else 422)
                    return self._send(status, {"ok": False, "error": info})
                return self._send(200, {"ok": True,
                                        **(info if isinstance(info, dict) else {"info": info})})
            return self._send(404, {"ok": False, "error": "not found"})
        except ValueError as e:                                      # noqa: BLE001
            return self._send(400, {"ok": False, "error": str(e)})
        except Exception as e:                                       # noqa: BLE001
            logger.exception("unhandled error in do_DELETE: %s", e)
            return self._send(500, {"ok": False, "error": "internal server error"})

    def _dispatch_post(self):
        if self.path == "/drives/changed":
            # Invalidate the cache — the automount script calls this
            # whenever a drive is added or removed. Body is ignored;
            # we just want to force the next GET /drives to re-read.
            # Auth-gated like the other mutating routes (WARP-659 left this one
            # open): with BRIDGE_BIND=0.0.0.0 the bridge is LAN-reachable, so an
            # unauthenticated caller could force cache churn. The automount
            # script presents the shared token (X-Droplet-Auth).
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
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
            # requires its own auth token on top, and run_pool_command() hands
            # the op to the root executor unit via the StateDirectory spool
            # (the host script's hard pre-flight is the last safety gate) —
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
        if self.path == "/openwrt/wifi/hostapd":
            # WARP-808: single-box Wi-Fi write. Auth-gated exactly like
            # /pools/command. The orchestrator only reaches here after an
            # owner/admin session (+ the Tier-2 confirm on the password path);
            # the bridge requires its own auth token on top, and run_set_hostapd
            # shells the host script (whose hard validation is the last gate) —
            # it never writes hostapd.conf / restarts hostapd itself.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            # This write only makes sense on the single-box hostapd shape. On a
            # uci / multi-box box there is no host hostapd to write — refuse with
            # 409 Conflict (wrong deployment shape) and NEVER invoke the host
            # script. This is the regression guard that keeps a uci box's Wi-Fi
            # path (UCI/SSH via the routing service) completely unaffected.
            if not _use_hostapd_mode():
                return self._send(409, {
                    "ok": False, "error": "not_hostapd_mode",
                    "hint": ("This box's Wi-Fi AP is managed via UCI, not host "
                             "hostapd; the Wi-Fi write goes through the routing "
                             "service on this deployment shape."),
                })
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode() if n else ""
            try:
                j = json.loads(raw) if raw else {}
            except Exception:                                       # noqa: BLE001
                return self._send(400, {"ok": False, "error": "bad json"})
            # Never log the body — it carries the PSK (rule 19).
            ok, code, info = run_set_hostapd({
                "ssid": j.get("ssid", ""),
                "psk": j.get("psk", ""),
            })
            if not ok:
                # 409 Conflict ONLY for true lock contention (another Wi-Fi write
                # already in flight) — same non-blocking-acquire posture as
                # rotate_wifi_key. Everything else (host-script validation refusal:
                # SSID/PSK out of range, exec/write failure) is 422, same shape as
                # /pools/command. Keyed on the machine `code`, NEVER a substring of
                # the human message: the host script restarts
                # droplet-openwrt-attach.service, whose systemd stderr can contain
                # "in progress" ("Job is already queued or in progress for ...")
                # and must not be misread as 409 (WARP-834 finding 1).
                status = 409 if code == "busy" else 422
                return self._send(status, {"ok": False, "error": info})
            return self._send(200, {"ok": True,
                                    **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/openwrt/wifi/guest":
            # Guest Wi-Fi create/update. Auth-gated + hostapd-mode gated exactly
            # like /openwrt/wifi/hostapd. The orchestrator only reaches here after
            # an owner/admin session (+ the Tier-2 confirm); run_set_guest_wifi
            # shells the host script (whose hard validation is the last gate) —
            # it never writes hostapd.conf / restarts hostapd itself.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            if not _use_hostapd_mode():
                # uci/multi-box: the guest network is provisioned via UCI through
                # the routing service, not this host write — refuse with 409 and
                # NEVER invoke the host script (regression guard for uci boxes).
                return self._send(409, {
                    "ok": False, "error": "not_hostapd_mode",
                    "hint": ("Guest Wi-Fi on this deployment shape is managed via "
                             "UCI through the routing service; the host guest "
                             "write does not apply."),
                })
            # Refuse up front on a radio that can't host a second BSS (iwlwifi/
            # AX210). Without this the write would "succeed" (env written), the
            # attach script's home-AP-only fallback would silently drop the guest
            # BSS, and getGuestWifi would then report a guest that never airs.
            if not guest_radio_supported():
                return self._send(409, {
                    "ok": False, "error": "guest_unsupported_radio",
                    "hint": ("This Droplet's Wi-Fi card can broadcast only one "
                             "network, so a separate guest Wi-Fi is not possible. "
                             "A multi-SSID-capable radio is required."),
                })
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode() if n else ""
            try:
                j = json.loads(raw) if raw else {}
            except Exception:                                       # noqa: BLE001
                return self._send(400, {"ok": False, "error": "bad json"})
            # Never log the body — it carries the guest PSK (rule 19).
            ok, code, info = run_set_guest_wifi({
                "ssid": j.get("ssid", ""),
                "psk": j.get("psk", ""),
            })
            if not ok:
                # 409 for lock contention (code == "busy"); 500 for infra failure
                # (code == "exec_error" — host script unavailable, server-side);
                # 422 for host-script validation refusal. Keyed on the machine
                # `code`, never a substring of the message (WARP-834 finding 1).
                status = 409 if code == "busy" else (500 if code == "exec_error" else 422)
                return self._send(status, {"ok": False, "error": info})
            return self._send(200, {"ok": True,
                                    **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/system/factory-reset":
            # WARP-825: owner-confirmed factory reset. Auth-gated exactly like
            # /pools/command + /openwrt/wifi/hostapd. The orchestrator only
            # reaches here after an owner session + the server-side
            # type-to-confirm check; the bridge requires its own auth token on
            # top, and run_factory_reset spawns the host script DETACHED (it
            # NEVER runs `docker compose down -v` itself). Returns 202 the
            # instant the wipe is launched — it does not (cannot) wait for the
            # wipe, which is tearing down this very process.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode() if n else ""
            try:
                j = json.loads(raw) if raw else {}
            except Exception:                                       # noqa: BLE001
                return self._send(400, {"ok": False, "error": "bad json"})
            ok, info = run_factory_reset({
                "jobId": j.get("jobId", ""),
                "targetName": j.get("targetName", ""),
            })
            if not ok:
                # 409 Conflict ONLY for true lock contention (another reset
                # already in flight) — same non-blocking-acquire posture as
                # /openwrt/wifi/hostapd. Keyed on the machine `info == "busy"`,
                # never a substring of a human message. Everything else (host
                # script missing / not executable) is 502; the box is untouched.
                if info == "busy":
                    return self._send(409, {
                        "ok": False,
                        "error": "reset already in progress",
                    })
                return self._send(502, {"ok": False, "error": info})
            return self._send(202, {"ok": True,
                                    **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/tls/reload":
            # ADR-023 (C2): reload the gateway nginx so a freshly-installed LE
            # cert is served immediately. Auth-gated exactly like the other
            # mutating routes. The orchestrator wrote docker/certs/droplet.crt +
            # .key atomically BEFORE calling; the bridge only triggers the
            # `docker compose exec gateway nginx -s reload` on the host (the
            # orchestrator has no docker socket). Synchronous + bounded — unlike
            # the detached factory-reset, a reload completes in well under the
            # 30 s host-script timeout, so we wait and report the outcome.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            ok, info = run_tls_reload()
            if not ok:
                # 502: the host script is missing / the reload command failed.
                # The cert files are already on disk, so the box keeps serving
                # the OLD cert until a later reload (or a gateway restart) lands.
                return self._send(502, {"ok": False, "error": info})
            return self._send(200, {"ok": True,
                                    **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/panel/console":
            # WARP-1639: hand the rack panel back to the kernel console. This
            # is what the panel's on-screen debug affordance calls. Auth-gated
            # like every other mutating route — it is a physical-access
            # recovery path, but the bridge can be LAN-reachable with
            # BRIDGE_BIND=0.0.0.0, and "anyone on the LAN can drop the status
            # screen to a login prompt" is not a posture we want.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            ok, info = run_panel_console()
            if not ok:
                # 502: the unit is missing or polkit denied it. The caller is a
                # person at a rack trying to get a prompt, so the message is
                # surfaced verbatim rather than flattened to "failed".
                return self._send(502, {"ok": False, "error": info})
            return self._send(200, {"ok": True,
                                    **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/host/public-fqdn":
            # ADR-023 PR-1: persist the orchestrator-LEARNED DROPLET_PUBLIC_FQDN
            # to the host .env (and re-register split-horizon DNS) via the host
            # script. Auth-gated exactly like /tls/reload + /openwrt/wifi/hostapd.
            # STRICT fqdn validation happens in run_set_public_fqdn BEFORE the
            # host script is ever invoked; a junk fqdn is a 400, never an exec.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            n = min(max(int(self.headers.get("Content-Length") or 0), 0), 4096)
            raw = self.rfile.read(n).decode() if n else ""
            try:
                j = json.loads(raw) if raw else {}
            except Exception:                                       # noqa: BLE001
                return self._send(400, {"ok": False, "error": "bad json"})
            fqdn = j.get("fqdn", "")
            if not _valid_public_fqdn(fqdn):
                # 400: the orchestrator sent a malformed name. The host script is
                # NOT invoked — defence in depth before any exec.
                return self._send(400, {"ok": False, "error": "invalid fqdn"})
            ok, info = run_set_public_fqdn(fqdn)
            if not ok:
                # 502: the host script is missing / refused. The learned name is
                # already in the orchestrator's cert-state row, so a failed
                # write-back only means the next boot re-learns it from HQ.
                return self._send(502, {"ok": False, "error": info})
            return self._send(200, {"ok": True,
                                    **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/host/box-name":
            # WARP-988: persist the owner-chosen DROPLET_BOX_NAME to the host
            # .env via the host script. Auth-gated exactly like
            # /host/public-fqdn + /tls/reload. STRICT name validation happens in
            # run_set_box_name BEFORE the host script is ever invoked; a junk
            # name is a 400, never an exec.
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            n = min(max(int(self.headers.get("Content-Length") or 0), 0), 4096)
            raw = self.rfile.read(n).decode() if n else ""
            try:
                j = json.loads(raw) if raw else {}
            except Exception:                                       # noqa: BLE001
                return self._send(400, {"ok": False, "error": "bad json"})
            name = j.get("name", "")
            if not _valid_box_name(name):
                # 400: the orchestrator sent a malformed name. The host script is
                # NOT invoked — defence in depth before any exec.
                return self._send(400, {"ok": False, "error": "invalid name"})
            ok, info = run_set_box_name(name)
            if not ok:
                # 502: the host script is missing / refused. The route already
                # accepted the name; a failed write-back only means the box keeps
                # its previous name until the owner retries.
                return self._send(502, {"ok": False, "error": info})
            return self._send(200, {"ok": True,
                                    **(info if isinstance(info, dict) else {"info": info})})
        if self.path == "/openwrt/wifi/rotate":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            if _use_hostapd_mode():
                # Single-box / hostapd mode: no router host to SSH into —
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
            # Validate the SSID before handing it to nmcli. With shell=False there
            # is no shell injection, but nmcli parses positional args by its own
            # grammar — an SSID like "--delete" would be read as an option, not a
            # network name. Mirror the hostapd host-script gate: strip control
            # characters, require 1–32 chars, and reject a leading dash.
            if not isinstance(ssid, str):
                ssid = ""
            # Length check runs on the raw value (before stripping) so a 33-byte
            # input that contains control chars isn't silently accepted after
            # strip reduces it to 32 printable chars (802.11 limit is 32 bytes).
            if not ssid or len(ssid) > 32:
                return self._send(400, {
                    "ok": False,
                    "error": "invalid SSID (1-32 chars, no control characters, no leading dash)",
                })
            ssid = "".join(ch for ch in ssid if ord(ch) >= 32 and ord(ch) != 127)
            if not ssid or ssid.startswith("-"):
                return self._send(400, {
                    "ok": False,
                    "error": "invalid SSID (1-32 chars, no control characters, no leading dash)",
                })
            if not isinstance(password, str):
                password = ""
            # Mirror the hostapd host-script PSK gate: WPA2 PSK must be 8–63
            # chars (IEEE 802.11 §H.4.1). An empty string means open-network
            # (nmcli connect without a password keyword), which is allowed.
            if password and (len(password) < 8 or len(password) > 63):
                return self._send(400, {
                    "ok": False,
                    "error": "invalid password (8-63 chars for WPA2 PSK)",
                })
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
