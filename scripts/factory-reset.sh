#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — Factory Reset
# =============================================================================
#
# Wipes ALL user data, credentials, and configuration — returning the device
# to a fresh out-of-the-box state. After reset, run setup.sh to re-provision.
#
# Usage:
#   ./scripts/factory-reset.sh [OPTIONS]
#
# Before wiping, it emits a final full-device backup (WARP-570) so a mis-run
# reset stays recoverable. Pass --no-backup to skip that safety net.
#
# Options:
#   --yes            Skip interactive confirmation (for automation)
#   --reinstall      After wiping, automatically run setup.sh to re-provision
#   --purge-images   Also remove built Docker images + dangling images/networks
#   --no-backup      Skip the pre-reset safety backup (WARP-570)
#   -h, --help       Show this help message
#
# Every reset reclaims the Docker build cache (the largest rebuildable disk
# consumer; `down --rmi all` leaves it behind) so the box returns to a clean
# out-of-box disk footprint. --purge-images additionally reclaims dangling
# images + unused networks (scoped — never a daemon-wide prune, so sibling
# project images such as Ollama survive). Trade-off: the next setup.sh rebuild
# is a cold build.
#
# =============================================================================
set -euo pipefail

# --- Resolve paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT

# --- Parse arguments ---
SKIP_CONFIRM=false
REINSTALL=false
PURGE_IMAGES=false
FORCE_REMOVE=false
NO_BACKUP=false

usage() {
  cat << 'USAGE'
Usage: ./scripts/factory-reset.sh [OPTIONS]

Wipes ALL user data, credentials, and configuration.
The device will be returned to a fresh out-of-the-box state.

Options:
  --yes            Skip interactive confirmation (for automation)
  --reinstall      After wiping, automatically run setup.sh to re-provision
  --purge-images   Also remove built Docker images + dangling images/networks
  --force          Restart Docker if volumes cannot be removed (stuck references)
  --no-backup      Skip the pre-reset full-device safety backup (WARP-570)
  -h, --help       Show this help message

What gets deleted:
  - All Docker volumes (database, files, AI keys, Matter fabric state)
  - The Docker build cache (always reclaimed — largest rebuildable consumer)
  - Generated secrets (.env)
  - TLS certificates
  - MQTT credentials
  - Setup logs

What is preserved:
  - Source code and git history
  - Docker images (unless --purge-images)
  - Docker engine and system packages

Note: reclaiming the build cache means the next setup.sh is a cold (slower)
rebuild. This is intentional — it stops the OS drive from filling over time.
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes)            SKIP_CONFIRM=true; shift ;;
    --reinstall)      REINSTALL=true; shift ;;
    --purge-images)   PURGE_IMAGES=true; shift ;;
    --force)          FORCE_REMOVE=true; shift ;;
    --no-backup)      NO_BACKUP=true; shift ;;
    -h|--help)        usage ;;
    *)                echo "Unknown option: $1"; usage ;;
  esac
done

# --- Source logging library ---
source "$SCRIPT_DIR/lib/logging.sh"

# --- Sanity check ---
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
  log_error "docker-compose.yml not found at $COMPOSE_FILE"
  log_error "Are you running this from the correct repository?"
  exit 1
fi

# --- Detect docker compose command ---
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  log_error "Docker Compose not found. Is Docker installed?"
  exit 1
fi

# =============================================================================
# Warning & Confirmation
# =============================================================================

log_divider
printf "\n"
printf "  ${_RED}${_BOLD}Droplet Edge Platform — Factory Reset${_RESET}\n"
printf "\n"
printf "  ${_YELLOW}WARNING: This will permanently delete ALL data:${_RESET}\n"
printf "\n"
printf "    ${_RED}•${_RESET} User accounts and credentials\n"
printf "    ${_RED}•${_RESET} Chat sessions and message history\n"
printf "    ${_RED}•${_RESET} All uploaded files\n"
printf "    ${_RED}•${_RESET} LLM provider API keys\n"
printf "    ${_RED}•${_RESET} Smart home configuration and history\n"
printf "    ${_RED}•${_RESET} Sync targets and file metadata\n"
printf "    ${_RED}•${_RESET} TLS certificates and device secrets\n"
printf "\n"
printf "  ${_DIM}This action cannot be undone.${_RESET}\n"
printf "\n"
log_divider

if [ "$SKIP_CONFIRM" != "true" ]; then
  printf "\n"
  printf "  Type ${_BOLD}RESET${_RESET} to confirm: "
  read -r confirmation
  printf "\n"

  if [ "$confirmation" != "RESET" ]; then
    log_info "Factory reset cancelled."
    exit 0
  fi
fi

# =============================================================================
# Phase 0: Safety backup (WARP-570)
# =============================================================================
# Emit a final full-device backup BEFORE any destructive step. The `down -v`
# in Phase 1 already removes volumes, so this gate MUST run before it — not
# just before the explicit `docker volume rm` loop. Opt out with --no-backup.
# If the backup fails we ABORT (fail-safe: never wipe data we couldn't
# protect) unless the operator explicitly passed --no-backup.

BACKUP_SCRIPT="$SCRIPT_DIR/host/device-backup.sh"
if [ "$NO_BACKUP" = "true" ]; then
  log_warn "--no-backup: skipping the pre-reset safety backup"
elif [ ! -f "$BACKUP_SCRIPT" ]; then
  log_warn "device-backup.sh not found — skipping safety backup"
elif ! command -v docker >/dev/null 2>&1; then
  log_warn "docker not available — skipping safety backup (nothing running to back up)"
else
  log_step 0 4 "Emitting a final safety backup before wipe"
  if "$BACKUP_SCRIPT"; then
    log_success "Safety backup complete (default dir: /var/lib/droplet/backups)"
    # Be explicit about what the wipe destroys that the backup does NOT
    # capture (caches / rebuildable state). The backup manifest's `excluded`
    # array is the machine-readable source of truth; this is the operator-
    # facing heads-up so nobody assumes "backup taken" == "everything saved".
    log_warn "NOT in the safety backup (rebuilt on reinstall): redis-pm cache,"
    log_warn "  frigate-config, rag-eval output, whisper/piper/ollama model"
    log_warn "  caches, openwrt config/overlay. See manifest 'excluded' for the list."
  else
    log_error "Safety backup FAILED — aborting factory reset."
    log_error "Re-run with --no-backup to reset anyway (DATA WILL BE LOST)."
    exit 1
  fi
  log_divider
fi

# =============================================================================
# Phase 1: Stop the stack
# =============================================================================

log_step 1 4 "Stopping all services"

# Use "down -v" to atomically stop containers AND remove named volumes.
# This is critical — "down" without "-v" leaves volumes intact, which causes
# credential mismatches on re-setup (new .env passwords vs old volume data).
#
# The compose file has no ${VAR:?error} patterns, so this always works
# regardless of .env state. Pass --env-file only when .env exists.
env_flag=""
if [ -f "$REPO_ROOT/.env" ]; then
  env_flag="--env-file $REPO_ROOT/.env"
fi

if [ "$PURGE_IMAGES" = "true" ]; then
  run_with_spinner "Stopping stack, removing volumes and images" \
    $DC -f "$COMPOSE_FILE" $env_flag down -v --rmi all --remove-orphans 2>/dev/null || true
else
  run_with_spinner "Stopping stack and removing volumes" \
    $DC -f "$COMPOSE_FILE" $env_flag down -v --remove-orphans 2>/dev/null || true
fi
log_success "All services stopped"

# --- Reclaim the Docker build cache (disk hygiene) ---
# The build cache is the largest rebuildable disk consumer and the one thing
# `docker compose down --rmi all` does NOT remove. It grows unbounded across
# rebuilds (observed: 57 GB of ACTIVE=0 cache on a long-lived single-box,
# enough to fill the OS NVMe) yet is pure build-accelerator state — never user
# data. A factory reset returns the box to a clean out-of-box *disk footprint*,
# so it must reclaim the cache. Done on EVERY reset — NOT gated behind
# --purge-images — because the dashboard Danger Zone reset runs without that
# flag, and an appliance reset that leaves tens of GB behind isn't "clean".
# Trade-off: the next setup.sh rebuild is a cold build (a few minutes slower);
# acceptable for an infrequent reset, and it stops the drive from silently
# filling. --purge-images extends the reclaim to dangling (untagged) images +
# unused networks too — but it is deliberately SCOPED, not a daemon-wide
# `docker system prune -af`: the `-a` there removes every image without a
# running container, which at reset time (all containers just stopped) would
# sweep the sibling droplet-local-LLM / Ollama images that deploy alongside
# this project on the single-box inference host, leaving AI inference broken
# until they are re-pulled. This project's own built images are already gone
# via `down --rmi all` above. Named volumes are Phase 2's job, so no --volumes.
if [ "$PURGE_IMAGES" = "true" ]; then
  # Scoped on purpose (see block comment above): build cache + dangling
  # (untagged) images + unused networks. NOT `docker system prune -af` — the
  # `-a` would also delete tagged sibling-project images (e.g. Ollama).
  run_with_spinner "Reclaiming build cache, dangling images, and networks" \
    sh -c 'docker builder prune -af; docker image prune -f; docker network prune -f' \
    2>/dev/null || true
else
  run_with_spinner "Reclaiming Docker build cache" \
    docker builder prune -af 2>/dev/null || true
fi
log_success "Docker build cache reclaimed"

log_divider

# =============================================================================
# Phase 2: Remove Docker volumes
# =============================================================================

log_step 2 4 "Removing Docker volumes"

COMPOSE_PROJECT=$(basename "$(dirname "$COMPOSE_FILE")")
VOLUMES=(
  "pgdata"
  "filedata"
  "nextcloud-data"
  "aikeys"
  "nvrdata"
  "matter-data"
  # WARP-573: pre-migration DB snapshots from the orchestrator's guarded boot
  # entrypoint. Wiped on reset so factory-reset truly returns to out-of-box.
  "migration-snapshots"
  "frigate-config"
  # WARP-501 — embedded Plane PM stack (ADR-010). Dedicated postgres + redis
  # per spec OQ1; both volumes wiped on factory reset so a re-install starts
  # with a clean Plane DB. Backup integration lands in WARP-514.
  "postgres-pm-data"
  "redis-pm-data"
  # single-box profile volumes (only present when COMPOSE_PROFILES=single-box
  # has been active at some point on this host). Listed unconditionally so a
  # reset works whether the profile is on or off — `docker volume rm` of a
  # nonexistent volume is a soft fail and the loop below handles it.
  "ollama-data"
  "openwrt-config"
  "openwrt-overlay"
)

removed=0
for vol in "${VOLUMES[@]}"; do
  # Docker Compose prefixes volume names with the project directory name
  full_name="${COMPOSE_PROJECT}_${vol}"
  if docker volume inspect "$full_name" >/dev/null 2>&1; then
    if docker volume rm "$full_name" >/dev/null 2>&1; then
      log_success "Removed volume: $full_name"
      removed=$((removed + 1))
    else
      log_warn "Failed to remove volume: $full_name (may be in use)"
    fi
  else
    # Try without project prefix (in case of custom naming)
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      if docker volume rm "$vol" >/dev/null 2>&1; then
        log_success "Removed volume: $vol"
        removed=$((removed + 1))
      else
        log_warn "Failed to remove volume: $vol (may be in use)"
      fi
    fi
  fi
done

if [ $removed -gt 0 ]; then
  log_success "$removed volume(s) removed"
else
  log_info "No volumes found to remove"
fi

# Final sweep for any orphaned anonymous volumes
docker volume prune -f >/dev/null 2>&1 || true

# --- Verify all target volumes are truly gone ---
remaining=0
for vol in "${VOLUMES[@]}"; do
  full_name="${COMPOSE_PROJECT}_${vol}"
  if docker volume inspect "$full_name" >/dev/null 2>&1 || \
     docker volume inspect "$vol" >/dev/null 2>&1; then
    log_warn "Volume still exists after removal: $vol"
    remaining=$((remaining + 1))
  fi
done

if [ $remaining -gt 0 ]; then
  if [ "$FORCE_REMOVE" = "true" ]; then
    log_warn "Force mode: restarting Docker to release stuck volume references..."
    if [[ "$(uname)" == "Darwin" ]]; then
      osascript -e 'quit app "Docker"' 2>/dev/null || true
      sleep 5
      open -a Docker
      # Top-level scope here (this block is at file scope, NOT inside a
      # function), so `local` would be a no-op and SC2168 fires at the
      # static-analysis layer. Plain assignment keeps the var visible to
      # the loop below — which is the only thing that reads it.
      docker_retries=30
      while [ $docker_retries -gt 0 ]; do
        docker info >/dev/null 2>&1 && break
        docker_retries=$((docker_retries - 1))
        sleep 2
      done
      if [ $docker_retries -eq 0 ]; then
        log_error "Docker did not restart in time"
        exit 1
      fi
    else
      sudo systemctl restart docker 2>/dev/null || true
      sleep 3
    fi
    # Retry volume removal after Docker restart
    for vol in "${VOLUMES[@]}"; do
      full_name="${COMPOSE_PROJECT}_${vol}"
      docker volume rm "$full_name" 2>/dev/null || docker volume rm "$vol" 2>/dev/null || true
    done
    log_success "Volumes force-removed after Docker restart"
  else
    log_error "$remaining volume(s) could not be removed."
    log_error "Try: ./scripts/factory-reset.sh --yes --force"
    log_error "Or manually: docker volume rm <name>"
    exit 1
  fi
fi

log_divider

# =============================================================================
# Phase 3: Delete generated files
# =============================================================================

log_step 3 4 "Cleaning generated files"

# .env (device secrets)
if [ -f "$REPO_ROOT/.env" ]; then
  rm -f "$REPO_ROOT/.env"
  log_success "Removed .env (device secrets)"
fi

# .env backups
for f in "$REPO_ROOT"/.env.bak.*; do
  [ -f "$f" ] && rm -f "$f" && log_success "Removed $(basename "$f")"
done

# TLS certificates
if [ -d "$REPO_ROOT/docker/certs" ]; then
  rm -rf "$REPO_ROOT/docker/certs"
  log_success "Removed docker/certs/ (TLS certificates)"
fi

# Docker secret files (WARP-37)
if [ -d "$REPO_ROOT/docker/secrets" ]; then
  rm -rf "$REPO_ROOT/docker/secrets"
  log_success "Removed docker/secrets/ (Docker secret mounts)"
fi

# Audit signing key (WARP-456)
# WARP-456 audit chain treats factory-reset as an era boundary — new key,
# new genesis row. Preserving the old key against an empty ActivityRow
# table would silently fork the chain: two distinct genesis rows signed
# by the same key, with no verifier capable of distinguishing the two
# eras. The orchestrator's sync_audit_signing_key (scripts/lib/secrets.sh)
# re-generates the file on next setup.sh run; the empty ActivityRow table
# then writes its first row as the new chain's genesis.
if [ -d "$REPO_ROOT/data/secrets" ]; then
  rm -rf "$REPO_ROOT/data/secrets"
  log_success "Removed data/secrets/ (audit signing key — era boundary)"
fi

# MQTT password file
if [ -d "$REPO_ROOT/docker/mosquitto_passwd_dir" ]; then
  rm -rf "$REPO_ROOT/docker/mosquitto_passwd_dir"
  log_success "Removed docker/mosquitto_passwd_dir/ (MQTT credentials)"
fi

# Generated mosquitto.conf (not git-tracked; may be a directory if Docker
# created the bind-mount target before the file existed)
if [ -f "$REPO_ROOT/docker/mosquitto.conf" ] || [ -d "$REPO_ROOT/docker/mosquitto.conf" ]; then
  rm -rf "$REPO_ROOT/docker/mosquitto.conf"
  log_success "Removed docker/mosquitto.conf"
fi

# Setup logs and lock files
if [ -d "$REPO_ROOT/.data" ]; then
  rm -rf "$REPO_ROOT/.data"
  log_success "Removed .data/ (logs and lock files)"
fi

# Shutdown-screen oneshot unit + host script (WARP-624). Disable + remove so
# a factory reset truly returns to out-of-box; install-device-bridge.sh
# reinstalls them on re-provision. Silent if not installed.
if [ -f /etc/systemd/system/droplet-shutdown-screen.service ] || \
   [ -f /usr/local/sbin/droplet-shutdown-screen.sh ]; then
  sudo systemctl disable --now droplet-shutdown-screen.service 2>/dev/null || true
  sudo rm -f /etc/systemd/system/droplet-shutdown-screen.service 2>/dev/null || true
  sudo rm -f /usr/local/sbin/droplet-shutdown-screen.sh 2>/dev/null || true
  sudo systemctl daemon-reload 2>/dev/null || true
  log_success "Removed shutdown-screen unit and host script"
fi

# Storage-pool host script (BUG-3 / ADR-019). Remove so a factory reset truly
# returns to out-of-box; install-device-bridge.sh reinstalls it on
# re-provision. NOTE: this removes the executor only — it never touches any
# array/disk; data on a pool is the owner's, not factory state.
if [ -f /usr/local/sbin/droplet-storage-pool.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-storage-pool.sh 2>/dev/null || true
  log_success "Removed storage-pool host script"
fi

# Storage-pool ROOT executor + apply unit + the bridge polkit rules (ADR-019
# follow-up). Remove so a reset truly returns to out-of-box;
# install-device-bridge.sh reinstalls all three on re-provision. The spooled
# request/result files live in /var/lib/droplet-bridge, wiped below.
if [ -f /usr/local/sbin/droplet-storage-pool-apply.sh ] || \
   [ -f /etc/systemd/system/droplet-storage-pool-apply.service ] || \
   [ -f /etc/polkit-1/rules.d/50-droplet-device-bridge.rules ]; then
  sudo rm -f /usr/local/sbin/droplet-storage-pool-apply.sh 2>/dev/null || true
  sudo rm -f /etc/systemd/system/droplet-storage-pool-apply.service 2>/dev/null || true
  sudo rm -f /etc/polkit-1/rules.d/50-droplet-device-bridge.rules 2>/dev/null || true
  sudo systemctl daemon-reload 2>/dev/null || true
  log_success "Removed storage-pool apply unit, root executor, and bridge polkit rules"
fi

# Single-box hostapd Wi-Fi-write host script (WARP-808). Remove so a factory
# reset truly returns to out-of-box; install-device-bridge.sh reinstalls it on
# re-provision. The customer's SSID/PSK lives in the attach env file, which the
# .env wipe + setup wizard re-seed handles separately; this removes the executor
# only.
if [ -f /usr/local/sbin/droplet-set-hostapd.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-set-hostapd.sh 2>/dev/null || true
  log_success "Removed hostapd Wi-Fi-write host script"
fi

# Factory-reset host executor (WARP-825). Remove so a reset truly returns to
# out-of-box; install-device-bridge.sh reinstalls it on re-provision. This is
# the executor the dashboard Danger Zone reaches via the device-bridge — it is
# the script invoking us right now (we run via `exec`- less delegation, so by
# the time this line runs the wrapper has already handed control to this
# canonical script). Removing it is safe and self-cleaning; it reinstalls on
# the next setup.sh.
if [ -f /usr/local/sbin/droplet-factory-reset.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-factory-reset.sh 2>/dev/null || true
  log_success "Removed factory-reset host executor"
fi

# TLS-reload host executor (ADR-023 C2). Remove so a reset truly returns to
# out-of-box; install-device-bridge.sh reinstalls it on re-provision. It only
# triggers `nginx -s reload` — removing it touches no certs or data.
if [ -f /usr/local/sbin/droplet-tls-reload.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-tls-reload.sh 2>/dev/null || true
  log_success "Removed TLS-reload host executor"
fi

# Device-bridge state + logs (needs sudo because systemd StateDirectory
# runs as root). Silent if not installed — dev machines won't have this.
if [ -d /var/lib/droplet-bridge ] || [ -f /etc/droplet/device-bridge.env ]; then
  # Stop the bridge + rotation timer before wiping state so they don't
  # race us writing back.
  sudo systemctl stop droplet-wifi-rotate.timer 2>/dev/null || true
  sudo systemctl stop droplet-device-bridge.service 2>/dev/null || true
  # /var/lib/droplet-bridge holds the rotation timestamp + key digest.
  # systemd will recreate it on next start via StateDirectory=.
  sudo rm -rf /var/lib/droplet-bridge 2>/dev/null || true
  # The env file carries the auth token + OpenWrt password — regenerate
  # from the repo example on re-setup. We only remove the populated
  # copy, not the example template in the repo.
  sudo rm -f /etc/droplet/device-bridge.env 2>/dev/null || true
  # The persisted per-box AP PSK (WARP-819). A customer Wi-Fi password set
  # via the wizard gets persisted here too (resolve_ap_psk in
  # droplet-openwrt-attach), so a factory reset must remove it — the next
  # attach run then generates a FRESH per-box PSK, i.e. true factory state
  # (PR #551 review). The wizard-written StateDirectory creds file is
  # already covered by the /var/lib/droplet-bridge wipe above.
  sudo rm -f /etc/droplet/ap-psk 2>/dev/null || true
  # Log files. These grow over time and can contain the current wifi
  # key's sha256 digest on "rotated" lines; nothing sensitive but
  # no reason to keep logs that pre-date the reset.
  sudo rm -f /var/log/droplet-device-bridge.log \
             /var/log/droplet-wifi-rotate.log 2>/dev/null || true
  log_success "Removed device-bridge state, env, and logs"
fi

log_divider

# =============================================================================
# Phase 4: Done
# =============================================================================

log_step 4 4 "Factory reset complete"

log_divider
printf "\n"
printf "  ${_GREEN}${_BOLD}Factory reset complete.${_RESET}\n"
printf "\n"
printf "  All user data, credentials, and configuration have been erased.\n"
printf "  The device is now in a clean, out-of-the-box state.\n"
printf "\n"

if [ "$REINSTALL" = "true" ]; then
  printf "  ${_CYAN}Running setup to re-provision...${_RESET}\n"
  printf "\n"
  log_divider
  printf "\n"
  exec "$SCRIPT_DIR/setup.sh" --skip-docker
fi

printf "  To re-provision the device, run:\n"
printf "\n"
printf "    ${_BOLD}./scripts/setup.sh --skip-docker${_RESET}\n"
printf "\n"
printf "  This will generate new secrets, rebuild, and start the stack.\n"
printf "  The first visit will redirect to the setup wizard.\n"
printf "\n"
log_divider
printf "\n"
