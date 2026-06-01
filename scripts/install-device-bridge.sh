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
# Populates BRIDGE_AUTH_TOKEN and OPENWRT_PASS from the repo .env if they
# aren't already set in the target env file. Idempotent — safe to re-run
# after a git pull.
#
# Usage:
#   sudo ./scripts/install-device-bridge.sh
#
# Run from the Jetson host, not inside any container.
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
            droplet-shutdown-screen.service; do
  src="$SRC_DIR/$unit"
  dst="$UNIT_DIR/$unit"
  if [[ ! -f "$src" ]]; then
    log "missing source: $src"
    exit 1
  fi
  install -m 0644 "$src" "$dst"
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
    # Replace an empty or commented line (GNU sed — Jetson is Ubuntu).
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
fi

# If still blank after mirroring, mint a random token so the bridge isn't
# fail-open in production. Operator can rotate it later via .env + re-run.
if ! grep -qE '^BRIDGE_AUTH_TOKEN=..+' "$ENV_FILE"; then
  token=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)
  set_env_if_blank "BRIDGE_AUTH_TOKEN" "$token"
  log "generated random BRIDGE_AUTH_TOKEN"
fi

# --- 3) Activate ---
systemctl daemon-reload
systemctl enable --now droplet-device-bridge.service

# Shutdown-screen oneshot. enable so it's wired into multi-user.target; --now
# starts it (ExecStart=/usr/bin/true reaches "active" immediately and its
# ExecStop fires on the next shutdown). Idempotent.
systemctl enable --now droplet-shutdown-screen.service

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
