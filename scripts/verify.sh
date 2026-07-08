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
# WARP-234: the cache runs TLS-only (redis-server --port 0 --tls-port 6380),
# so the plaintext 6379 ping false-fails on a healthy listener. Ping over TLS
# against 6380 using the internal-CA `cache` bundle the container stages to
# /tmp/redis.{key,crt} + /tmp/redis-ca.crt (see docker/docker-compose.yml
# cache service). REDIS_PASSWORD is the ping-only `default` ACL user, which
# carries +ping, so a bare `ping` is sufficient.
check "Redis" \
  _docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T cache \
    redis-cli -p 6380 --tls \
      --cert /tmp/redis.crt --key /tmp/redis.key --cacert /tmp/redis-ca.crt \
      -a "${REDIS_PASSWORD:-redis-dev-password}" --no-auth-warning ping || true

# --- MQTT broker (WARP-235: mTLS listener — identity = client cert CN) ---
# Probes with the broker's own bundle: a successful CONNECT proves the :8883
# TLS listener is up and accepting CA-signed client certs. Liveness only —
# the "broker" CN has no topic grants, so the QoS-0 publish is ACL-dropped.
check_warn "MQTT broker (mTLS)" \
  _docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T broker \
    mosquitto_pub -h localhost -p 8883 \
    --cafile /mosquitto/config/tls/ca.pem \
    --cert /mosquitto/config/tls/cert.pem \
    --key /mosquitto/config/tls/key.pem \
    -t "droplet/verify" -m "verify" -q 0

# --- Nginx reverse proxy (single entry point — services are not exposed to host) ---
check "Nginx → Orchestrator API" \
  curl -sf --max-time 10 http://localhost/api/health || true

check "Nginx → Web Dashboard" \
  curl -sf --max-time 10 -o /dev/null http://localhost/ || true

check "Nginx → AI Gateway" \
  curl -sf --max-time 10 http://localhost/ai/health || true

# --- Voice orchestrator (WARP-154) ---
# Internal-only (port 8086 not host-exposed) so the check runs via
# docker exec. Skipped when the linux compose profile isn't active
# (e.g. macOS Docker Desktop has no /dev/snd, the service isn't up).
# `check_warn` rather than `check` because a missing mic is operator-
# configurable (plug one in later), not a verify.sh failure.
if _docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'voice-io-1$'; then
  check_warn "Voice orchestrator /health" \
    _docker exec droplet-voice-io-1 \
      curl -sf -o /dev/null --max-time 5 http://localhost:8086/health
  check_warn "Voice orchestrator /audio/devices" \
    _docker exec droplet-voice-io-1 \
      curl -sf -o /dev/null --max-time 5 http://localhost:8086/audio/devices
fi

# --- Status display service (oled-display) ---
# Runs with `network_mode: host` listening on :8082. Service auto-falls
# back to "simulated" backend (PNG file) when no /dev/ttyACM* device is
# found, so /health stays green even with the status display unplugged —
# the operator distinguishes by hitting /display/status for the backend
# (pyportal | simulated). `check_warn` rather than `check` because the
# screen is opt-in hardware: the appliance ships without one on installs
# that don't need a local display.
if _docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'oled-display-1$'; then
  check_warn "status display /health" \
    curl -sf -o /dev/null --max-time 5 http://localhost:8082/health
fi

# --- .env file ---
check ".env exists (chmod 600)" \
  bash -c '
    [ -f "'"$REPO_ROOT/.env"'" ] && \
    perms=$(stat -c "%a" "'"$REPO_ROOT/.env"'" 2>/dev/null || stat -f "%Lp" "'"$REPO_ROOT/.env"'" 2>/dev/null) && \
    [ "$perms" = "600" ]
  ' || true

# --- Required setup artifacts (Docker bind-mount sources) ---
# These are materialized by setup.sh's materialize_artifacts(). If any are
# missing on a started stack, the corresponding container failed to start
# (Compose errors with "bind source path does not exist"). Re-run:
#   ./scripts/setup.sh --sync-secrets
check "Docker secret: openwrt_password" \
  bash -c '[ -f "'"$REPO_ROOT/docker/secrets/openwrt_password"'" ]' || true

check "TLS certificate" \
  bash -c '[ -f "'"$REPO_ROOT/docker/certs/droplet.crt"'" ] && [ -f "'"$REPO_ROOT/docker/certs/droplet.key"'" ]' || true

# WARP-235: the MQTT password file is retired — the broker mounts its TLS
# bundle (issued by the WARP-236 internal CA) and the per-CN topic ACL file.
check "MQTT broker TLS bundle" \
  bash -c '[ -f "'"$REPO_ROOT/data/secrets/service-tls/broker/cert.pem"'" ] && [ -f "'"$REPO_ROOT/data/secrets/service-tls/broker/key.pem"'" ]' || true

check "MQTT topic ACL file" \
  bash -c '[ -f "'"$REPO_ROOT/docker/mosquitto.acl"'" ]' || true

# --- Stale .env drift (WARP-36, WARP-44) ---
# Older installs predate ROUTING_SERVICE_TOKEN — if missing, routing-service
# auth is disabled (services/routing/main.py:113 falls through to "dev mode").
# migrate_env() backfills these on every setup; warn if still absent.
check_warn "ROUTING_SERVICE_TOKEN set" \
  bash -c '[ -n "${ROUTING_SERVICE_TOKEN:-}" ]'

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
