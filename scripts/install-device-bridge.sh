#!/usr/bin/env bash
# =============================================================================
# Droplet — install / refresh device-bridge systemd units
# =============================================================================
#
# Installs (or re-installs) the host-side device-bridge:
#   /etc/systemd/system/droplet-device-bridge.service
#   /etc/systemd/system/droplet-wifi-rotate.service
#   /etc/systemd/system/droplet-wifi-rotate.timer
#   /etc/droplet/device-bridge.env            (0600, root:root)
#
# Populates BRIDGE_AUTH_TOKEN, OPENWRT_PASS, and (single-box) DROPLET_AP_MODE
# from the repo .env if they aren't already set in the target env file, and
# ensures the host python3 can import qrcode for the pairing-QR render.
# Idempotent — safe to re-run after a git pull.
#
# Usage:
#   sudo ./scripts/install-device-bridge.sh
#
# Run from the appliance host, not inside any container.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/services/oled-display"
UNIT_DIR="/etc/systemd/system"
ENV_DIR="/etc/droplet"
ENV_FILE="$ENV_DIR/device-bridge.env"

if [[ $EUID -ne 0 ]]; then
  exec sudo --preserve-env "$0" "$@"
fi

log() { printf '[install-bridge] %s\n' "$*"; }

# --- 1) Install the unit files ---
for unit in droplet-device-bridge.service \
            droplet-wifi-rotate.service \
            droplet-wifi-rotate.timer \
            droplet-shutdown-screen.service \
            droplet-storage-pool-apply.service \
            droplet-wifi-watchdog.service \
            droplet-wifi-watchdog.timer; do
  src="$SRC_DIR/$unit"
  dst="$UNIT_DIR/$unit"
  if [[ ! -f "$src" ]]; then
    log "missing source: $src"
    exit 1
  fi
  # Substitute the @REPO_ROOT@ placeholder (droplet-device-bridge.service's
  # ExecStart) with this checkout's actual path; a harmless no-op for units
  # that contain no placeholder. Using sed > file (not `install`) so the
  # substitution lands; perms set explicitly after.
  sed "s|@REPO_ROOT@|$REPO_ROOT|g" "$src" > "$dst"
  chmod 0644 "$dst"
  log "installed $dst"
done

# --- 1b) Install the shutdown-screen host script ---
# droplet-shutdown-screen.service's ExecStop runs this on teardown to push
# the "Shutting down" frame to the front panel. It belongs on the host (not
# in a container) so it can reach the oled-display service on loopback while
# the stack is being stopped. Lives in /usr/local/sbin per the host-script
# convention; installed here (never hand-placed) so factory-reset can remove
# it cleanly.
SHUTDOWN_SCRIPT_SRC="$SRC_DIR/droplet-shutdown-screen.sh"
SHUTDOWN_SCRIPT_DST="/usr/local/sbin/droplet-shutdown-screen.sh"
if [[ ! -f "$SHUTDOWN_SCRIPT_SRC" ]]; then
  log "missing source: $SHUTDOWN_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$SHUTDOWN_SCRIPT_SRC" "$SHUTDOWN_SCRIPT_DST"
log "installed $SHUTDOWN_SCRIPT_DST"

# --- 1c) Install the storage-pool host script (BUG-3 / ADR-019) ---
# Runs mdadm/mkfs — the ONLY place those run. It lives on the host (root +
# real block devices, can't run from a container) per architecture-guard rule
# 20; installed here (never hand-placed) so factory-reset removes it cleanly.
# It is data-destroying and carries its own hard pre-flight (refuse mounted /
# has-data / OS-disk; require a typed double-confirm). Repo source is
# scripts/host/. NOTE (ADR-019 follow-up): the device-bridge's POST
# /pools/command does NOT exec this directly anymore — its sandbox can't grant
# the root this needs — it goes through the spool + root apply unit installed
# in 1c-bis below.
POOL_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-storage-pool.sh"
POOL_SCRIPT_DST="/usr/local/sbin/droplet-storage-pool.sh"
if [[ ! -f "$POOL_SCRIPT_SRC" ]]; then
  log "missing source: $POOL_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$POOL_SCRIPT_SRC" "$POOL_SCRIPT_DST"
log "installed $POOL_SCRIPT_DST"

# --- 1c-bis) Install the storage-pool ROOT executor (ADR-019 follow-up) ---
# The bridge sandbox (User=droplet + ProtectSystem=strict + NoNewPrivileges)
# cannot run mdadm/mkfs/mount, so the bridge spools the owner-confirmed pool
# request into its StateDirectory and polkit-starts
# droplet-storage-pool-apply.service (unit installed in step 1; polkit grant
# in 1d-bis), whose ExecStart is this script — it consumes the spooled request
# as root, runs droplet-storage-pool.sh, and writes the result back for the
# bridge to read. The unit is deliberately never enabled: on-demand only.
POOL_APPLY_SRC="$REPO_ROOT/scripts/host/droplet-storage-pool-apply.sh"
POOL_APPLY_DST="/usr/local/sbin/droplet-storage-pool-apply.sh"
if [[ ! -f "$POOL_APPLY_SRC" ]]; then
  log "missing source: $POOL_APPLY_SRC"
  exit 1
fi
install -m 0755 "$POOL_APPLY_SRC" "$POOL_APPLY_DST"
log "installed $POOL_APPLY_DST"

# --- 1d) Install the single-box hostapd Wi-Fi-write host script (WARP-808) ---
# The device-bridge's POST /openwrt/wifi/hostapd shells this to write the
# customer's Wi-Fi SSID/PSK on the single-box shape — it upserts
# DROPLET_AP_SSID/PSK in /etc/default/droplet-openwrt-attach and restarts
# droplet-openwrt-attach.service (which regenerates /etc/hostapd.conf + respawns
# hostapd). It lives on the host (writes a root-owned env file + runs systemctl,
# can't run from a container) per architecture-guard rule 20; installed here
# (never hand-placed) so factory-reset removes it cleanly. It validates
# SSID 1-32 / PSK 8-63 before writing and never logs the PSK. Repo source is
# scripts/host/.
HOSTAPD_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-set-hostapd.sh"
HOSTAPD_SCRIPT_DST="/usr/local/sbin/droplet-set-hostapd.sh"
if [[ ! -f "$HOSTAPD_SCRIPT_SRC" ]]; then
  log "missing source: $HOSTAPD_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$HOSTAPD_SCRIPT_SRC" "$HOSTAPD_SCRIPT_DST"
log "installed $HOSTAPD_SCRIPT_DST"

# --- 1d-quater) Install the guest Wi-Fi host writer ---
# Sibling of droplet-set-hostapd.sh: the device-bridge's POST/DELETE
# /openwrt/wifi/guest shells this to enable/disable the OPTIONAL second BSS on
# the single-box shape — it upserts DROPLET_GUEST_SSID/PSK/ENABLED in the SAME
# attach env file and restarts droplet-openwrt-attach.service (which stands up
# the guest BSS + 192.168.30.0/24 subnet + isolated firewall zone). Reuses the
# EXISTING polkit grant (it restarts the same one unit), so no new privilege.
# Validates SSID 1-32 / PSK 8-63 before writing and never logs the PSK.
GUEST_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-set-guest-wifi.sh"
GUEST_SCRIPT_DST="/usr/local/sbin/droplet-set-guest-wifi.sh"
if [[ ! -f "$GUEST_SCRIPT_SRC" ]]; then
  log "missing source: $GUEST_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$GUEST_SCRIPT_SRC" "$GUEST_SCRIPT_DST"
log "installed $GUEST_SCRIPT_DST"

# --- 1d-ter) Install the Wi-Fi PCI watchdog (WARP-869) ---
# Revives a silently-dead Wi-Fi PCI function (driver bound, phy/netdev gone)
# via remove + rescan, then re-runs droplet-openwrt-attach so hostapd rebinds
# the AP. Scheduled by droplet-wifi-watchdog.timer (unit installed in step 1).
WIFI_WD_SRC="$REPO_ROOT/scripts/host/usr-local-sbin/droplet-wifi-watchdog"
WIFI_WD_DST="/usr/local/sbin/droplet-wifi-watchdog"
if [[ ! -f "$WIFI_WD_SRC" ]]; then
  log "missing source: $WIFI_WD_SRC"
  exit 1
fi
install -m 0755 "$WIFI_WD_SRC" "$WIFI_WD_DST"
log "installed $WIFI_WD_DST"

# --- 1d-bis) Polkit rules for the sandboxed bridge writes ---
# The bridge unit runs as User=droplet inside ProtectSystem=strict +
# NoNewPrivileges — it CANNOT write /etc/default or sudo (the shipping box
# failed the wizard's Home Wi-Fi save with mktemp EROFS). The rules file
# carries TWO narrowly-scoped grants for the droplet user, both D-Bus asks to
# PID 1, no escalation:
#   - restart/start droplet-openwrt-attach.service (WARP-808 Wi-Fi write —
#     the env-file half targets the bridge's StateDirectory via
#     DROPLET_HOSTAPD_ENV_FILE; the attach service layers that file last);
#   - start droplet-storage-pool-apply.service (ADR-019 follow-up — the root
#     oneshot that consumes the spooled pool request; start verb only).
POLKIT_RULE_SRC="$SRC_DIR/50-droplet-device-bridge.rules"
POLKIT_RULE_DST="/etc/polkit-1/rules.d/50-droplet-device-bridge.rules"
if [[ ! -f "$POLKIT_RULE_SRC" ]]; then
  log "missing source: $POLKIT_RULE_SRC"
  exit 1
fi
install -m 0644 "$POLKIT_RULE_SRC" "$POLKIT_RULE_DST"
log "installed $POLKIT_RULE_DST"

# --- 1d) Factory-reset host executor (WARP-825) ---
# The host-side entry point for the dashboard's owner-confirmed factory reset.
# Spawned (detached) by the device-bridge's auth-gated POST /system/factory-reset
# after an owner session + the server-side type-to-confirm check. It is a thin
# wrapper that delegates to the canonical scripts/factory-reset.sh --yes; the
# bridge never runs `docker compose down -v` itself. Repo-tracked per
# architecture-guard rule 20; installed here (never hand-placed) so
# factory-reset.sh removes it cleanly on reset.
RESET_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-factory-reset.sh"
RESET_SCRIPT_DST="/usr/local/sbin/droplet-factory-reset.sh"
if [[ ! -f "$RESET_SCRIPT_SRC" ]]; then
  log "missing source: $RESET_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$RESET_SCRIPT_SRC" "$RESET_SCRIPT_DST"
log "installed $RESET_SCRIPT_DST"

# --- 1e) Install the diagnostics log collector host script (WARP-823) ---
# The device-bridge's GET /logs/bundle shells this to gather a BOUNDED,
# secret-REDACTED slice of each Droplet service's logs (docker logs / journalctl)
# for the Settings → "Download diagnostics" bundle. It reads host log streams
# the orchestrator container can't reach, so it lives on the host per
# architecture-guard rule 20; installed here (never hand-placed) so factory-reset
# removes it cleanly. Read-only — it never mutates the box. Redaction here is
# defense in depth; the orchestrator redacts again before zipping. Repo source is
# scripts/host/.
LOGS_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-collect-logs.sh"
LOGS_SCRIPT_DST="/usr/local/sbin/droplet-collect-logs.sh"
if [[ ! -f "$LOGS_SCRIPT_SRC" ]]; then
  log "missing source: $LOGS_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$LOGS_SCRIPT_SRC" "$LOGS_SCRIPT_DST"
log "installed $LOGS_SCRIPT_DST"

# ADR-023 (C2): gateway-nginx reload host executor. The orchestrator's
# tls-issuance cron POSTs /tls/reload to the bridge after writing a fresh LE
# fullchain; the bridge execs this wrapper, which delegates to the shared
# scripts/lib/tls-reload.sh::reload_gateway_nginx (the orchestrator has no docker
# socket). Repo-tracked (architecture-guard rule 20), installed here so
# factory-reset removes it cleanly. Repo source is scripts/host/.
TLS_RELOAD_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-tls-reload.sh"
TLS_RELOAD_SCRIPT_DST="/usr/local/sbin/droplet-tls-reload.sh"
if [[ ! -f "$TLS_RELOAD_SCRIPT_SRC" ]]; then
  log "missing source: $TLS_RELOAD_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$TLS_RELOAD_SCRIPT_SRC" "$TLS_RELOAD_SCRIPT_DST"
log "installed $TLS_RELOAD_SCRIPT_DST"

# ADR-023 PR-1: public-FQDN write-back host executor. The orchestrator's
# tls-issuance service POSTs /host/public-fqdn to the bridge once it has LEARNED
# the box's opaque per-device FQDN from HQ; the bridge execs this wrapper, which
# idempotently persists DROPLET_PUBLIC_FQDN into the repo .env and re-registers
# split-horizon DNS (the orchestrator can't write the host .env itself).
# Repo-tracked (architecture-guard rule 20), installed here so factory-reset
# removes it cleanly. Repo source is scripts/host/.
SET_FQDN_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-set-public-fqdn.sh"
SET_FQDN_SCRIPT_DST="/usr/local/sbin/droplet-set-public-fqdn.sh"
if [[ ! -f "$SET_FQDN_SCRIPT_SRC" ]]; then
  log "missing source: $SET_FQDN_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$SET_FQDN_SCRIPT_SRC" "$SET_FQDN_SCRIPT_DST"
log "installed $SET_FQDN_SCRIPT_DST"

# --- 2) Ensure the env file exists and contains the needed secrets ---
install -d -m 0755 "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 "$SRC_DIR/device-bridge.env.example" "$ENV_FILE"
  log "seeded $ENV_FILE from example template"
fi
# Always tighten perms — defensive in case someone hand-edited.
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"

# Helper: set KEY=VALUE in $ENV_FILE only if the KEY line is empty or missing.
# Won't clobber an operator-set value.
set_env_if_blank() {
  local key="$1"
  local value="$2"
  local current
  current=$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  if [[ -n "$current" ]]; then
    return 0
  fi
  if grep -qE "^#?\s*${key}=" "$ENV_FILE"; then
    # Replace an empty or commented line (GNU sed — the appliance is Ubuntu).
    sed -i -E "s|^#?\s*${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  log "set $key in $ENV_FILE"
}

# Pull secrets from the repo's top-level .env if present. setup.sh writes
# SERVICE_TOKEN_DISPLAY, DEVICE_SECRET_KEY, and OPENWRT_PASSWORD there;
# we mirror them into the bridge env file so the bridge + timer have the
# auth token and SSH password without operators double-entering them.
REPO_ENV="$REPO_ROOT/.env"
if [[ -f "$REPO_ENV" ]]; then
  # shellcheck disable=SC1090
  set -a; . "$REPO_ENV"; set +a

  # WARP-165: BRIDGE_AUTH_TOKEN moved from DEVICE_SECRET_KEY (the
  # FIPS-sealed AES-256 master encryption key) to a dedicated
  # SERVICE_TOKEN_DISPLAY. On a fresh install just write the new value;
  # on an existing install where the bridge env still has the old
  # DEVICE_SECRET_KEY value, rotate it in place so the orchestrator
  # (which now sends SERVICE_TOKEN_DISPLAY) and the bridge agree.
  if [[ -n "${SERVICE_TOKEN_DISPLAY:-}" ]]; then
    current_bridge_token=$(grep -E '^BRIDGE_AUTH_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
    if [[ -z "$current_bridge_token" ]]; then
      set_env_if_blank "BRIDGE_AUTH_TOKEN" "$SERVICE_TOKEN_DISPLAY"
    elif [[ -n "${DEVICE_SECRET_KEY:-}" ]] && [[ "$current_bridge_token" = "$DEVICE_SECRET_KEY" ]]; then
      # Stale: bridge still using the master key. Rotate to the new
      # dedicated token; operator doesn't need to do anything manual.
      sed -i -E "s|^BRIDGE_AUTH_TOKEN=.*|BRIDGE_AUTH_TOKEN=${SERVICE_TOKEN_DISPLAY}|" "$ENV_FILE"
      log "rotated BRIDGE_AUTH_TOKEN from DEVICE_SECRET_KEY to SERVICE_TOKEN_DISPLAY (WARP-165)"
    fi
    # Else: operator set a custom value; leave it alone.
  elif [[ -n "${DEVICE_SECRET_KEY:-}" ]]; then
    # Repo .env predates SERVICE_TOKEN_DISPLAY (no setup.sh run yet
    # against this build). Fall back to the old behavior so the bridge
    # is never fail-open; setup.sh's next migrate_env will populate the
    # new token and a subsequent install-device-bridge run will rotate.
    set_env_if_blank "BRIDGE_AUTH_TOKEN" "$DEVICE_SECRET_KEY"
  fi

  if [[ -n "${OPENWRT_PASSWORD:-}" ]]; then
    set_env_if_blank "OPENWRT_PASS" "$OPENWRT_PASSWORD"
  fi

  # Pairing-QR AP source (WARP-654). setup.sh --single-box records
  # DROPLET_AP_MODE=hostapd in the repo .env (scripts/lib/single-box.sh) because
  # the single-box host runs the Wi-Fi AP via hostapd, not a standalone UCI router.
  # Mirror it into the bridge env so device-bridge.py reads the hostapd creds
  # instead of an empty `uci show wireless`. set_env_if_blank never clobbers an
  # operator override; multi-box installs leave the key unset in .env, so the
  # bridge keeps its built-in `uci` default.
  if [[ -n "${DROPLET_AP_MODE:-}" ]]; then
    set_env_if_blank "DROPLET_AP_MODE" "$DROPLET_AP_MODE"
  fi
fi

# If still blank after mirroring, mint a random token so the bridge isn't
# fail-open in production. Operator can rotate it later via .env + re-run.
if ! grep -qE '^BRIDGE_AUTH_TOKEN=..+' "$ENV_FILE"; then
  token=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)
  set_env_if_blank "BRIDGE_AUTH_TOKEN" "$token"
  log "generated random BRIDGE_AUTH_TOKEN"
fi

# --- 2a2) Pre-seed the OpenWrt SSH host key (multi-box uci AP path only) ---
# device-bridge.py reaches the OpenWrt router over SSH ONLY on the multi-box
# (uci) shape — the single-box drives its AP via hostapd and never SSHes. The
# bridge now pins the router key (StrictHostKeyChecking=accept-new + a persistent
# known_hosts) instead of the old StrictHostKeyChecking=no + /dev/null, so a LAN
# MITM can't silently capture OPENWRT_PASS or inject UCI. Seed that pin HERE, on
# the trusted install network, so the trust-on-first-use happens deterministically
# at provisioning time rather than on whatever key answers the first live call.
# Best-effort: a missing / unreachable router must NOT abort the install — the
# bridge still falls back to accept-new on first contact.
bridge_ap_mode=$(grep -E '^DROPLET_AP_MODE=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
if [[ "$bridge_ap_mode" != "hostapd" ]]; then
  ow_host=$(grep -E '^OPENWRT_HOST=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  ow_host="${ow_host:-${OPENWRT_HOST:-192.168.50.1}}"
  ow_known=$(grep -E '^OPENWRT_KNOWN_HOSTS=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  ow_known="${ow_known:-${OPENWRT_KNOWN_HOSTS:-/var/lib/droplet-bridge/openwrt_known_hosts}}"
  install -d -m 0700 "$(dirname "$ow_known")"
  if scanned=$(ssh-keyscan -T 5 "$ow_host" 2>/dev/null) && [[ -n "$scanned" ]]; then
    # Drop any stale entries for this host, then append the freshly scanned keys.
    [[ -f "$ow_known" ]] && ssh-keygen -R "$ow_host" -f "$ow_known" >/dev/null 2>&1 || true
    printf '%s\n' "$scanned" >> "$ow_known"
    chmod 0600 "$ow_known"
    log "openwrt: pinned SSH host key for $ow_host in $ow_known"
  else
    log "openwrt: ssh-keyscan of $ow_host returned no key (router offline at"
    log "  install?) — the bridge will pin on first contact via accept-new."
  fi
fi

# --- 2b) Provision the host Python dep the pairing-QR render needs ---
# droplet-device-bridge.service runs the host's /usr/bin/python3 (see the unit's
# ExecStart) — NOT the oled-display container venv that gets requirements.txt.
# device-bridge.py lazily `import qrcode` inside the /openwrt/qr render path (the
# pairing QR the front panel paints) on BOTH the single-box (hostapd) and
# multi-box (uci) shapes. Without the module on the host, GET /openwrt/qr fails
# with "qr encode failed: No module named 'qrcode'" and a fresh box can't show a
# pairing code. Provision it from the distro: python3-qrcode lands in
# /usr/lib/python3/dist-packages, importable by /usr/bin/python3.
# Defensive — this must NOT abort the whole bridge install under `set -e` if the
# package index is briefly unreachable; the rest of the bridge works without the
# QR endpoint, so we warn and carry on.
BRIDGE_PY=/usr/bin/python3
if "$BRIDGE_PY" -c 'import qrcode' >/dev/null 2>&1; then
  log "qrcode: already importable by $BRIDGE_PY"
else
  log "qrcode: installing python3-qrcode for the pairing-QR render"
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y python3-qrcode; then
    # Stale index on a fresh box — refresh once, then retry.
    apt-get update -y >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3-qrcode || true
  fi
  if "$BRIDGE_PY" -c 'import qrcode' >/dev/null 2>&1; then
    log "qrcode: installed and importable"
  else
    log "WARNING: qrcode still not importable by $BRIDGE_PY — GET /openwrt/qr"
    log "  will fail until it is. Remediate on the host with:"
    log "    sudo apt-get install -y python3-qrcode"
  fi
fi

# --- 3) Activate ---
systemctl daemon-reload

# The bridge entrypoint (device-bridge.py) serves over
# http.server.ThreadingHTTPServer and needs no third-party deps to START — its
# only host dependency, qrcode, is imported lazily inside the /openwrt/qr path
# and is provisioned in step 2b above. So startup never gates on a dependency:
# enable the bridge unconditionally, and if qrcode is somehow still missing only
# the QR endpoint degrades, not the service. Guard the enable so that under
# `set -e` a transient start failure can't abort this script before the shutdown
# screen below is wired up. The front-panel shutdown screen needs no deps and is
# likewise always enabled.
if systemctl enable --now droplet-device-bridge.service; then
  log "device-bridge: enabled"
else
  log "device-bridge: enable failed — inspect 'systemctl status droplet-device-bridge.service'"
fi

# Shutdown-screen oneshot. enable so it's wired into multi-user.target; --now
# starts it (ExecStart=/usr/bin/true reaches "active" immediately and its
# ExecStop fires on the next shutdown). Idempotent. Independent of the bridge.
systemctl enable --now droplet-shutdown-screen.service

# WARP-869: Wi-Fi PCI watchdog — revives a silently-dead Wi-Fi function
# (driver bound, phy/netdev gone; seen live on the shipping box) via PCI
# remove + rescan, then re-runs droplet-openwrt-attach. Always on: the
# healthy-path cost is a read-only sysfs scan every 2 minutes.
systemctl enable --now droplet-wifi-watchdog.timer

# Wi-Fi key rotation: off by default so saved credentials on phones keep
# working after a restart. Enable only if the operator opts in via
# WIFI_KEY_ROTATION_ENABLED=true in the env file. A masked timer won't
# fire even if something tries to enable it by mistake.
if grep -qE '^WIFI_KEY_ROTATION_ENABLED=(true|1|yes|on)$' "$ENV_FILE"; then
  # If previously masked (rotation was off before), unmask first so
  # enable will succeed.
  systemctl unmask droplet-wifi-rotate.timer 2>/dev/null || true
  systemctl enable --now droplet-wifi-rotate.timer
  log "wifi rotation: ENABLED (24h cadence)"
else
  systemctl disable --now droplet-wifi-rotate.timer 2>/dev/null || true
  systemctl mask droplet-wifi-rotate.timer 2>/dev/null || true
  log "wifi rotation: disabled (static password). To enable, set "
  log "  WIFI_KEY_ROTATION_ENABLED=true in $ENV_FILE, run:"
  log "  sudo systemctl unmask --now droplet-wifi-rotate.timer"
fi

# Surface status so the installer doesn't silently "succeed" with a broken
# bridge — this is the line operators will check when provisioning.
sleep 2
systemctl --no-pager --lines 0 status droplet-device-bridge.service || true

log "done"
