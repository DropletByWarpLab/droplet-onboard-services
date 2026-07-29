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
# Populates BRIDGE_AUTH_TOKEN, OPENWRT_PASS, ROUTING_SERVICE_TOKEN, and
# (single-box) DROPLET_AP_MODE from the repo .env if they aren't already set in
# the target env file, and ensures the host python3 can import qrcode for the
# pairing-QR render.
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
# (droplet-wifi-watchdog.service/.timer are gone: WARP-1002's unified
# droplet-watchdog.timer schedules the Wi-Fi wedge helper now — see the
# migration in step 4b below and scripts/host/droplet-watchdog.sh.)
for unit in droplet-device-bridge.service \
            droplet-wifi-rotate.service \
            droplet-wifi-rotate.timer \
            droplet-shutdown-screen.service \
            droplet-storage-pool-apply.service \
            droplet-panel-claim.service \
            droplet-panel-console.service \
            droplet-panel-deadman.service \
            droplet-panel-deadman.timer; do
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

# --- 1b-bis) Install the rack-panel console host scripts (WARP-1639) ---------
# droplet-panel-console.sh is the ONLY place framebuffer ownership is switched
# between fbcon (a login prompt) and the display service (the status screen).
# droplet-panel-deadman.sh is the safety net that hands the console back on its
# own when the display service stops answering — without it, claiming the panel
# would remove the operator's physical way in with no automatic recovery.
# Both run as root from their units; /usr/local/sbin per the host-script
# convention, installed here (never hand-placed) so factory-reset removes them.
for panel_script in droplet-panel-console.sh droplet-panel-deadman.sh; do
  panel_src="$REPO_ROOT/scripts/host/$panel_script"
  if [[ ! -f "$panel_src" ]]; then
    log "missing source: $panel_src"
    exit 1
  fi
  install -m 0755 "$panel_src" "/usr/local/sbin/$panel_script"
  log "installed /usr/local/sbin/$panel_script"
done

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
# customer's Wi-Fi SSID/PSK on the single-box shape — the sandboxed bridge
# upserts DROPLET_AP_SSID/PSK into its OWN StateDirectory creds file
# (/var/lib/droplet-bridge/openwrt-attach.env, droplet-owned — WARP-843, so no
# root-owned /etc write is needed); the root droplet-openwrt-attach.path unit
# then re-applies (root reads the creds via a validated whitelist parse,
# regenerates /etc/hostapd.conf + respawns hostapd). A root/operator invocation
# writes /etc/default directly and restarts the service. It lives on the host
# (not a container) per
# architecture-guard rule 20; installed here (never hand-placed) so
# factory-reset removes it cleanly. It validates SSID 1-32 / PSK 8-63 before
# writing and never logs the PSK. Repo source is scripts/host/.
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
# bridge StateDirectory creds file the home-AP write uses; the
# droplet-openwrt-attach.path unit re-applies (stands up the guest BSS +
# 192.168.30.0/24 subnet + isolated firewall zone). Same WARP-843 privilege
# model as the home-AP writer: zero grants to the bridge.
# Validates SSID 1-32 / PSK 8-63 before writing and never logs the PSK.
GUEST_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-set-guest-wifi.sh"
GUEST_SCRIPT_DST="/usr/local/sbin/droplet-set-guest-wifi.sh"
if [[ ! -f "$GUEST_SCRIPT_SRC" ]]; then
  log "missing source: $GUEST_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$GUEST_SCRIPT_SRC" "$GUEST_SCRIPT_DST"
log "installed $GUEST_SCRIPT_DST"

# --- 1d-ter) Install the Wi-Fi PCI watchdog helper (WARP-869) ---
# Revives a silently-dead Wi-Fi PCI function (driver bound, phy/netdev gone)
# via remove + rescan, then re-runs droplet-openwrt-attach so hostapd rebinds
# the AP. Since WARP-1002 it is invoked by the unified droplet-watchdog.timer
# (installed by setup.sh via scripts/lib/single-box.sh), not a timer of its own.
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
# NoNewPrivileges. The rules file carries ONE narrowly-scoped grant for the
# droplet user (a D-Bus ask to PID 1, no escalation):
#   - start droplet-storage-pool-apply.service (ADR-019 follow-up — the root
#     oneshot that consumes the spooled pool request; start verb only).
# The former droplet-openwrt-attach.service restart grant (WARP-808 / PR #551)
# is GONE: since WARP-843 the Wi-Fi write scripts never call systemctl when
# unprivileged — the root droplet-openwrt-attach.path unit re-applies the
# env-file change, so the bridge needs no restart privilege at all.
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

# WARP-988: box-name write-back host executor. The orchestrator POSTs
# /host/box-name to the bridge once the owner has chosen a name in the wizard's
# "name your box" step (WARP-979); the bridge execs this wrapper, which
# idempotently persists DROPLET_BOX_NAME into the repo .env (no DNS legs — HQ
# owns the name's DNS; the orchestrator can't write the host .env itself).
# Repo-tracked (architecture-guard rule 20), installed here so factory-reset
# removes it cleanly. Repo source is scripts/host/.
SET_BOX_NAME_SCRIPT_SRC="$REPO_ROOT/scripts/host/droplet-set-box-name.sh"
SET_BOX_NAME_SCRIPT_DST="/usr/local/sbin/droplet-set-box-name.sh"
if [[ ! -f "$SET_BOX_NAME_SCRIPT_SRC" ]]; then
  log "missing source: $SET_BOX_NAME_SCRIPT_SRC"
  exit 1
fi
install -m 0755 "$SET_BOX_NAME_SCRIPT_SRC" "$SET_BOX_NAME_SCRIPT_DST"
log "installed $SET_BOX_NAME_SCRIPT_DST"

# --- 2) Ensure the env file exists and contains the needed secrets ---
install -d -m 0755 "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 "$SRC_DIR/device-bridge.env.example" "$ENV_FILE"
  log "seeded $ENV_FILE from example template"
fi
# Always tighten perms — defensive in case someone hand-edited.
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"

# Replace (in place) the first line matching ^#?\s*KEY= with KEY=VALUE.
# Uses awk + ENVIRON so VALUE is treated as a literal: operator passwords /
# tokens containing | & or \ can't corrupt the rewrite the way they would if
# interpolated into a `sed s|...|...|` replacement.
_set_env_kv() {  # _set_env_kv FILE KEY VALUE
  local file="$1" k="$2" v="$3" tmp
  tmp=$(mktemp) || return 1
  if K="$k" V="$v" awk '
        BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
        !done && $0 ~ ("^#?[[:space:]]*" k "=") { print k "=" v; done = 1; next }
        { print }
      ' "$file" > "$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"; return 1
  fi
}

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
    # Replace an empty or commented line with the literal value.
    _set_env_kv "$ENV_FILE" "$key" "$value"
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
      _set_env_kv "$ENV_FILE" "BRIDGE_AUTH_TOKEN" "$SERVICE_TOKEN_DISPLAY"
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

  # WARP-985: the public-FQDN write-back (droplet-set-public-fqdn.sh, exec'd
  # by the bridge's POST /host/public-fqdn) registers split-horizon DNS via the
  # routing service (POST /dhcp/hostnames in scripts/lib/local-dns.sh), which
  # authenticates with ROUTING_SERVICE_TOKEN. The host script inherits the
  # bridge's environment, so mirror the token here — without it the .env upsert
  # succeeds but the routing-DNS leg 401s. setup.sh writes the token to the
  # repo .env; set_env_if_blank never clobbers an operator override.
  if [[ -n "${ROUTING_SERVICE_TOKEN:-}" ]]; then
    set_env_if_blank "ROUTING_SERVICE_TOKEN" "$ROUTING_SERVICE_TOKEN"
  fi

  # WARP-1061 — internal mTLS. Mirror the knob UNCONDITIONALLY (not
  # set_env_if_blank): a flag flip in the repo .env must propagate to the
  # bridge on the next installer run or its orchestrator /api/health read
  # silently breaks (scheme mismatch). The DROPLET_TLS_* paths point at the
  # host-issued `device-bridge` bundle in the repo data/secrets tree; those
  # use set_env_if_blank so an operator relocating certs keeps their paths.
  if grep -qE '^#?[[:space:]]*DROPLET_INTERNAL_TLS=' "$ENV_FILE"; then
    _set_env_kv "$ENV_FILE" "DROPLET_INTERNAL_TLS" "${DROPLET_INTERNAL_TLS:-0}"
  else
    printf '%s=%s\n' "DROPLET_INTERNAL_TLS" "${DROPLET_INTERNAL_TLS:-0}" >> "$ENV_FILE"
  fi
  log "set DROPLET_INTERNAL_TLS=${DROPLET_INTERNAL_TLS:-0} in $ENV_FILE"
  set_env_if_blank "DROPLET_TLS_CERT" "$REPO_ROOT/data/secrets/service-tls/device-bridge/cert.pem"
  set_env_if_blank "DROPLET_TLS_KEY"  "$REPO_ROOT/data/secrets/service-tls/device-bridge/key.pem"
  set_env_if_blank "DROPLET_TLS_CA"   "$REPO_ROOT/data/secrets/service-tls/device-bridge/ca.pem"

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

# --- 2a1) WARP-843 (security): attach env file stays ROOT-owned --------------
# /etc/default/droplet-openwrt-attach is the ROOT droplet-openwrt-attach.service
# EnvironmentFile and carries operator/hardware config ONLY. It must NEVER be
# droplet-writable: an EnvironmentFile loads EVERY key, so a droplet-writable
# target lets a compromised (unprivileged) device-bridge inject arbitrary env
# into a root unit — e.g. AP_PSK_FILE=/root/.ssh/authorized_keys, which
# resolve_ap_psk() would then write AS ROOT (privilege escalation). The
# sandboxed wizard Wi-Fi writes therefore land in the bridge's OWN
# StateDirectory (/var/lib/droplet-bridge/openwrt-attach.env), which root reads
# back through the validated customer_ap_creds / customer_guest_creds whitelist
# parse in /usr/local/sbin/droplet-openwrt-attach — never as env. So this
# installer does NOT chown the file to droplet and does NOT migrate/delete the
# StateDirectory creds file; single-box.sh owns /etc/default provisioning.
ATTACH_ENV_FILE=/etc/default/droplet-openwrt-attach
if [[ -f "$ATTACH_ENV_FILE" ]]; then
  # Re-assert secrecy only; ownership stays root:root (never droplet).
  chmod 0600 "$ATTACH_ENV_FILE"
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
# enable --now alone is a no-op start on an ALREADY-running bridge, which
# would leave the old process serving with stale unit env (WARP-843 bit
# exactly that: the previous DROPLET_HOSTAPD_ENV_FILE pin survived upgrades
# until reboot). Restart explicitly so every install applies the current
# unit + env file.
if systemctl enable --now droplet-device-bridge.service \
   && systemctl restart droplet-device-bridge.service; then
  log "device-bridge: enabled + restarted (fresh unit env)"
else
  log "device-bridge: enable/restart failed — inspect 'systemctl status droplet-device-bridge.service'"
fi

# Shutdown-screen oneshot. enable so it's wired into multi-user.target; --now
# starts it (ExecStart=/usr/bin/true reaches "active" immediately and its
# ExecStop fires on the next shutdown). Idempotent. Independent of the bridge.
systemctl enable --now droplet-shutdown-screen.service

# --- 4a-bis) Rack-panel console ownership + deadman (WARP-1639) --------------
# Only wire these up on a box that actually HAS a framebuffer. A headless box
# (or a chassis with no front panel) must not gain a permanently-failing unit
# and a timer that probes a display service it will never have.
#
# The deadman timer is the reason claiming the panel is safe: it hands the
# console back automatically when the display service stops answering. Enable
# it BEFORE the claim unit so there is never a window where the panel has been
# taken away with no watchdog running.
#
# droplet-panel-console.service is deliberately NOT enabled — it is an
# on-demand recovery action, started by the panel's debug button (via the
# bridge's polkit grant) or by an operator over SSH.
if [[ -d /sys/class/vtconsole ]] && compgen -G "/dev/fb[0-9]*" >/dev/null 2>&1; then
  systemctl enable --now droplet-panel-deadman.timer
  # `|| true`: exit 3 means a live release hold (someone is mid-debug on the
  # panel), which is a deliberate refusal and must not fail the install.
  systemctl enable --now droplet-panel-claim.service || true
  log "rack panel: deadman timer + claim unit enabled"
else
  log "rack panel: no framebuffer on this box — panel units installed but not enabled"
fi

# --- 4b) WARP-1002 migration: standalone Wi-Fi watchdog timer superseded ---
# The WARP-869 helper is now scheduled by the unified droplet-watchdog.timer
# (installed + enabled by setup.sh via scripts/lib/single-box.sh). Two
# independent schedulers could race a PCI remove/rescan, so disable and remove
# the old units if this box still has them. The helper script itself stays
# (installed in step 1d-ter — it is the watchdog's wifi detect+heal engine).
systemctl disable --now droplet-wifi-watchdog.timer 2>/dev/null || true
if [[ -f "$UNIT_DIR/droplet-wifi-watchdog.service" || -f "$UNIT_DIR/droplet-wifi-watchdog.timer" ]]; then
  rm -f "$UNIT_DIR/droplet-wifi-watchdog.service" "$UNIT_DIR/droplet-wifi-watchdog.timer"
  systemctl daemon-reload
  log "removed superseded droplet-wifi-watchdog units (droplet-watchdog.timer owns the schedule)"
fi

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
