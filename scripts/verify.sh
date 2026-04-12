#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — Post-Install Verification
# =============================================================================
#
# Runs health checks against all services in the running stack.
# Can be used standalone or called from setup.sh.
#
# Usage:
#   ./scripts/verify.sh
#
# Exit code 0 = all checks passed, 1 = one or more failed.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
COMPOSE_ENV_FILE="$REPO_ROOT/.env"

# --- Colors ---
if [ -t 1 ]; then
  _GREEN='\033[0;32m'; _RED='\033[0;31m'; _YELLOW='\033[0;33m'
  _BOLD='\033[1m'; _DIM='\033[2m'; _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _YELLOW=''; _BOLD=''; _DIM=''; _RESET=''
fi

# --- Load .env if present ---
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

# --- Docker wrapper ---
# Share the run_docker / run_docker_compose wrappers with setup.sh so the
# sudo-detection logic lives in one place. The old inline wrappers here had
# the same bug as scripts/lib/docker.sh: they fell back to `sudo docker …`
# whenever the wrapped command returned non-zero, causing a hidden password
# prompt on /dev/tty during polling checks.
# shellcheck source=lib/logging.sh
source "$SCRIPT_DIR/lib/logging.sh"
# shellcheck source=lib/docker.sh
source "$SCRIPT_DIR/lib/docker.sh"

_docker() { run_docker "$@"; }
_docker_compose() { run_docker_compose "$@"; }

# --- Check runner ---
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

check() {
  local name="$1"
  shift
  local result

  printf "  %-30s " "$name"

  if result=$("$@" 2>&1); then
    printf "${_GREEN}PASS${_RESET}\n"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    printf "${_RED}FAIL${_RESET}\n"
    if [ -n "$result" ]; then
      printf "${_DIM}    %s${_RESET}\n" "$(echo "$result" | head -3)"
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

check_warn() {
  local name="$1"
  shift

  printf "  %-30s " "$name"

  if "$@" >/dev/null 2>&1; then
    printf "${_GREEN}PASS${_RESET}\n"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf "${_YELLOW}WARN${_RESET}\n"
    WARN_COUNT=$((WARN_COUNT + 1))
  fi
}

# --- Retry helper ---
wait_for() {
  local name="$1" timeout="$2"
  shift 2
  local elapsed=0

  while [ $elapsed -lt "$timeout" ]; do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

# =============================================================================
# Checks
# =============================================================================
printf "\n${_BOLD}  Droplet Edge Platform — Verification${_RESET}\n\n"

# --- Containers ---
check "Containers running" \
  bash -c '
    running=$(docker compose -f "'"$COMPOSE_FILE"'" --env-file "'"$COMPOSE_ENV_FILE"'" ps --status running -q 2>/dev/null | wc -l)
    [ "$running" -ge 7 ]
  ' || true

# --- PostgreSQL ---
check "PostgreSQL" \
  _docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T db \
    pg_isready -U "${POSTGRES_USER:-droplet}" || true

# --- Nextcloud database ---
check "Nextcloud database" \
  _docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T db \
    psql -U "${POSTGRES_USER:-droplet}" -d nextcloud -c "SELECT 1" -t || true

# --- Redis ---
check "Redis" \
  _docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T cache \
    redis-cli -a "${REDIS_PASSWORD:-redis-dev-password}" --no-auth-warning ping || true

# --- MQTT broker ---
check_warn "MQTT broker" \
  _docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T broker \
    mosquitto_pub -h localhost \
    ${MQTT_USER:+-u "$MQTT_USER"} \
    ${MQTT_PASSWORD:+-P "$MQTT_PASSWORD"} \
    -t "droplet/test" -m "verify" -q 0

# --- Nginx reverse proxy (single entry point — services are not exposed to host) ---
check "Nginx → Orchestrator API" \
  curl -sf --max-time 10 http://localhost/api/health || true

check "Nginx → Web Dashboard" \
  curl -sf --max-time 10 -o /dev/null http://localhost/ || true

check "Nginx → AI Gateway" \
  curl -sf --max-time 10 http://localhost/ai/health || true

# --- .env file ---
check ".env exists (chmod 600)" \
  bash -c '
    [ -f "'"$REPO_ROOT/.env"'" ] && \
    perms=$(stat -c "%a" "'"$REPO_ROOT/.env"'" 2>/dev/null || stat -f "%Lp" "'"$REPO_ROOT/.env"'" 2>/dev/null) && \
    [ "$perms" = "600" ]
  ' || true

# =============================================================================
# Summary
# =============================================================================
printf "\n"
printf "  ──────────────────────────────────\n"
printf "  ${_GREEN}Passed: %d${_RESET}" "$PASS_COUNT"
if [ $FAIL_COUNT -gt 0 ]; then
  printf "  ${_RED}Failed: %d${_RESET}" "$FAIL_COUNT"
fi
if [ $WARN_COUNT -gt 0 ]; then
  printf "  ${_YELLOW}Warnings: %d${_RESET}" "$WARN_COUNT"
fi
printf "\n"
printf "  ──────────────────────────────────\n\n"

if [ $FAIL_COUNT -gt 0 ]; then
  printf "  ${_YELLOW}Troubleshooting:${_RESET}\n"
  printf "    Logs:    docker compose -f docker/docker-compose.yml logs\n"
  printf "    Status:  docker compose -f docker/docker-compose.yml ps\n"
  printf "    Restart: docker compose -f docker/docker-compose.yml restart\n\n"
  exit 1
fi

exit 0
