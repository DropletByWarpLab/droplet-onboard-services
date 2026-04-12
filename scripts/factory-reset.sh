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
# Options:
#   --yes            Skip interactive confirmation (for automation)
#   --reinstall      After wiping, automatically run setup.sh to re-provision
#   --purge-images   Also remove built Docker images (slower rebuild)
#   -h, --help       Show this help message
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

usage() {
  cat << 'USAGE'
Usage: ./scripts/factory-reset.sh [OPTIONS]

Wipes ALL user data, credentials, and configuration.
The device will be returned to a fresh out-of-the-box state.

Options:
  --yes            Skip interactive confirmation (for automation)
  --reinstall      After wiping, automatically run setup.sh to re-provision
  --purge-images   Also remove built Docker images (slower rebuild)
  --force          Restart Docker if volumes cannot be removed (stuck references)
  -h, --help       Show this help message

What gets deleted:
  - All Docker volumes (database, files, AI keys, Home Assistant config)
  - Generated secrets (.env)
  - TLS certificates
  - MQTT credentials
  - Setup logs

What is preserved:
  - Source code and git history
  - Docker images (unless --purge-images)
  - Docker engine and system packages
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes)            SKIP_CONFIRM=true; shift ;;
    --reinstall)      REINSTALL=true; shift ;;
    --purge-images)   PURGE_IMAGES=true; shift ;;
    --force)          FORCE_REMOVE=true; shift ;;
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
# Phase 1: Stop the stack
# =============================================================================

log_step 1 4 "Stopping all services"

# Use "down -v" to atomically stop containers AND remove named volumes.
# This is critical — "down" without "-v" leaves volumes intact, which causes
# credential mismatches on re-setup (new .env passwords vs old volume data).
#
# The compose file has no ${VAR:?error} patterns, so this always works
# regardless of .env state. Pass --env-file only when .env exists.
local env_flag=""
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
  "ha-config"
  "nvrdata"
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
      local docker_retries=30
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
