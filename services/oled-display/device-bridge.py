"""
Droplet device-bridge — host-side HTTP API for the on-device screen.

Runs on the Jetson host (outside the oled-display container). Exposes a
stable read-only API the display service polls, with each endpoint
sourcing live data from the appropriate upstream:

  GET  /wifi           -> OpenWrt iwinfo scan (SSH), fallback to Jetson nmcli
  GET  /openwrt/qr     -> OpenWrt's LAN SSID + PSK encoded as a WiFi QR
                          matrix + payload (PyPortal renders the grid)
  GET  /files          -> file-indexer / orchestrator storage snapshot
  GET  /cameras        -> Frigate recent events + online camera count
  POST /wifi/connect   -> join an SSID (nmcli fallback path)
  GET  /health         -> liveness

All network calls have short timeouts with graceful degradation — an
upstream being down never takes the bridge down; the display UI shows
a "waiting for X" state instead.
"""

import datetime
import json
import os
import shlex
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

OPENWRT_HOST      = os.environ.get("OPENWRT_HOST", "192.168.50.1")
OPENWRT_USER      = os.environ.get("OPENWRT_USER", "root")
OPENWRT_PASS      = os.environ.get("OPENWRT_PASS", "")
OPENWRT_IFACE     = os.environ.get("OPENWRT_IFACE", "wlan0")
SSH_TIMEOUT       = int(os.environ.get("SSH_CONNECT_TIMEOUT", "4"))

FRIGATE_URL       = os.environ.get("FRIGATE_URL", "http://127.0.0.1:5000")
ORCHESTRATOR_URL  = os.environ.get("ORCHESTRATOR_URL", "http://127.0.0.1:3000")
FILES_ROOT        = os.environ.get("FILES_ROOT", "/home/droplet/Documents/droplet-pi-platform/.data/files")

BRIDGE_PORT       = int(os.environ.get("BRIDGE_PORT", "9090"))
# Bind host — default loopback so the bridge is only reachable from the
# oled-display container (which shares the host's network namespace) and
# other local services. Public/LAN exposure is a clear footgun: /wifi/connect
# would let any LAN neighbor force-join arbitrary SSIDs. Override with
# BRIDGE_BIND=0.0.0.0 only if you're putting an auth layer in front.
BRIDGE_BIND       = os.environ.get("BRIDGE_BIND", "127.0.0.1")


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
    """Read the LAN-side SSID + WPA key from UCI."""
    script = (
        "ssid=$(uci -q get wireless.default_radio0.ssid "
        "  || uci -q get wireless.@wifi-iface[0].ssid); "
        "key=$(uci -q get wireless.default_radio0.key "
        "  || uci -q get wireless.@wifi-iface[0].key); "
        "enc=$(uci -q get wireless.default_radio0.encryption "
        "  || uci -q get wireless.@wifi-iface[0].encryption); "
        "hid=$(uci -q get wireless.default_radio0.hidden "
        "  || echo 0); "
        "disabled=$(uci -q get wireless.default_radio0.disabled "
        "  || echo 0); "
        "printf 'SSID=%s\\nKEY=%s\\nENC=%s\\nHID=%s\\nDISABLED=%s\\n' "
        "  \"$ssid\" \"$key\" \"$enc\" \"$hid\" \"$disabled\""
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
    rc, out, _ = _ssh_openwrt(
        "uci -q get wireless.sta.ssid 2>/dev/null || "
        "uci -q get wireless.default_radio0.ssid 2>/dev/null || true",
        timeout=6)
    return (out.strip() or None) if rc == 0 else None


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
        "scanned_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
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
        out["source"] = "jetson-nmcli"
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
    """Fetch OpenWrt wifi creds and return a QR-matrix + payload."""
    out = {
        "ok": False, "ssid": None, "security": None, "hidden": False,
        "disabled": False, "payload": None, "matrix": None,
        "version": None, "error": None,
    }
    creds, err = openwrt_wifi_credentials()
    if creds is None:
        out["error"] = err or "router unreachable"
        return out
    payload = _wifi_payload(creds["ssid"], creds["key"], creds["encryption"])
    try:
        matrix, ver = _qr_encode(payload)
    except Exception as e:                                           # noqa: BLE001
        out["error"] = "qr encode failed: {}".format(e)
        return out
    out.update({
        "ok": True, "ssid": creds["ssid"],
        "security": creds["encryption"], "hidden": creds["hidden"],
        "disabled": creds["disabled"], "payload": payload,
        "matrix": matrix, "version": ver,
    })
    return out


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
             "modified": datetime.datetime.utcfromtimestamp(m)
                               .strftime("%Y-%m-%dT%H:%M:%SZ")}
            for m, n, sz in recent
        ],
        "orchestrator": sync_state,
        "snapshot_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
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
# drives on microcontrollers (PyPortal, etc.) that technically mount
# but aren't user storage.
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
            by_mount[mp] = {
                "device": m.get("device"),
                "mount": mp,
                "label": m.get("label") or "",
                "uuid": m.get("uuid") or "",
                "size_bytes": total,
                "used_bytes": used,
                "free_bytes": free,
                "mounted": True,
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
                dev, mp, fs = parts[0], parts[1], parts[2]
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
                # (so a pulled PyPortal reports 113 GB of the eMMC root).
                # Skip if the backing block device is gone.
                if dev.startswith("/dev/") and not os.path.exists(dev):
                    continue
                total, used, free = _bytes_for(mp)
                if total < _MIN_DRIVE_BYTES:
                    continue
                label, uuid = _label_and_uuid_for(dev)
                by_mount[mp] = {
                    "device": dev,
                    "mount": mp,
                    "label": label,
                    "uuid": uuid,
                    "size_bytes": total,
                    "used_bytes": used,
                    "free_bytes": free,
                    "mounted": True,
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
        "snapshot_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _drives_cache["snap"] = snap
    _drives_cache["at"] = now
    return snap


def cameras_snapshot():
    out = {
        "online": 0, "total": 0, "events": [],
        "source": None, "error": None,
        "snapshot_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
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
        if self.path == "/wifi/connect":
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


if __name__ == "__main__":
    print("device-bridge listening on {}:{} (openwrt={})".format(
        BRIDGE_BIND, BRIDGE_PORT, OPENWRT_HOST))
    ThreadingHTTPServer((BRIDGE_BIND, BRIDGE_PORT), Handler).serve_forever()
