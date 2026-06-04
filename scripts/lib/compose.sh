#!/usr/bin/env bash
# compose.sh — Pull images, build containers, start the stack, wait for health.
# Source this file; do not execute directly.

COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
COMPOSE_ENV_FILE="$REPO_ROOT/.env"

# =============================================================================
# Env validation — single source of truth for required secrets
# =============================================================================
# Update this list when adding a new secret to the .env heredoc in secrets.sh.
REQUIRED_ENV_VARS=(
  POSTGRES_PASSWORD
  REDIS_PASSWORD
  MQTT_PASSWORD
  NEXTCLOUD_ADMIN_PASSWORD
  DEVICE_SECRET
  DEVICE_SECRET_KEY
  # WARP-501: embedded Plane PM stack. Fail-closed contract for the
  # three Plane-required secrets enforced HERE (per Romain's PR #242
  # prescription: keep compose `:-` so the file always parses, move
  # secret validation to this layer). DROPLET_PM_WEB_URL is included
  # because the Plane API container refuses to start without a valid
  # public URL — empty is a misconfiguration, not a sensible default.
  DROPLET_PM_DB_PASSWORD
  DROPLET_PM_SECRET_KEY
  DROPLET_PM_WEB_URL
)

_validate_env() {
  local env_file="$COMPOSE_ENV_FILE"

  if [ ! -f "$env_file" ]; then
    log_error ".env not found at $env_file"
    log_error "Run ./scripts/setup.sh to generate device secrets."
    return 1
  fi

  local missing=()
  local var val

  for var in "${REQUIRED_ENV_VARS[@]}"; do
    # `|| true`: a missing var makes grep exit 1, which under `set -euo
    # pipefail` would abort here instead of recording it in missing[] (the
    # whole point of this loop). Empty val → flagged as missing below.
    val=$(grep -E "^${var}=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2- || true)
    if [ -z "$val" ] || [ "$val" = "change-me" ]; then
      missing+=("$var")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing or placeholder secrets in .env:"
    for var in "${missing[@]}"; do
      log_error "  - $var"
    done
    log_error ""
    log_error "Run: ./scripts/setup.sh --regenerate-env"
    return 1
  fi

  return 0
}

# =============================================================================
# Build
# =============================================================================
prepare_and_build() {
  # Validate all required secrets before touching Docker
  _validate_env || return 1

  # --- Always start from clean state ---
  # Stop any running containers so builds don't conflict with stale state.
  # Compose file has no :? patterns, so this always works even with partial .env.
  log_info "Stopping any existing containers..."
  run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    down --remove-orphans 2>/dev/null || true

  # --- Ensure init scripts are executable ---
  chmod +x "$REPO_ROOT/docker/init-nextcloud-db.sh" 2>/dev/null || true

  # --- Ensure mosquitto passwd dir exists for compose mount ---
  mkdir -p "$REPO_ROOT/docker/mosquitto_passwd_dir"

  # --- Make `.env` discoverable to bare `docker compose -f docker/…` calls ---
  # Compose resolves `.env` relative to the compose file's directory, not the
  # repo root. Without this symlink, invocations that don't pass
  # `--env-file .env` (e.g. ad-hoc `docker compose -f docker/docker-compose.yml
  # logs`) silently default secrets to empty strings and break auth services.
  ln -sfn ../.env "$REPO_ROOT/docker/.env"

  # --- Pull base images (sequential for slow Pi connections) ---
  log_info "Pulling base container images..."
  local images=(
    "postgres:16-alpine"
    "redis:7-alpine"
    "eclipse-mosquitto:2"
    "nginx:alpine"
    "nextcloud:29-apache"
    "node:20-alpine"
    "python:3.12-slim"
  )
  # Frigate is gated to the `linux` compose profile (see docker-compose.yml);
  # skip the ~2GB pull on macOS where it can never run.
  if [ "$(uname)" = "Linux" ]; then
    images+=("ghcr.io/blakeblackshear/frigate:stable")
  fi

  local failed=0
  for img in "${images[@]}"; do
    local attempts=0
    while [ $attempts -lt 3 ]; do
      attempts=$((attempts + 1))
      if run_with_spinner "Pulling $img" run_docker pull "$img"; then
        break
      fi
      if [ $attempts -lt 3 ]; then
        log_warn "  Retry $attempts/3 for $img..."
        sleep 3
      else
        log_warn "  Failed to pull $img — will retry during build"
        failed=$((failed + 1))
      fi
    done
  done

  if [ $failed -gt 0 ]; then
    log_warn "$failed image(s) failed to pull — build may re-download them"
  fi

  # --- Build application images ---
  # Every service with a `build:` section in docker-compose.yml needs to
  # land here, including profile-gated ones. Previously this listed only
  # orchestrator / web-dashboard / ai-gateway, so a fresh install where
  # the user later did `COMPOSE_PROFILES=full docker compose up -d` hit
  #   "No such image: docker-file-indexer:latest"
  # because file-indexer / switch / camera-discovery / routing were
  # never built. `--profile full` makes profile-gated services visible
  # to compose; routing is default-profile but was also missing.
  #
  # Keep this list in sync with the `build:` sections in
  # docker/docker-compose.yml. If you add a new buildable service,
  # add it here too. (Frigate ships as a pulled image, not a local
  # build — don't list it.)
  log_info "Building application containers..."
  local build_services=(
    # default profile
    orchestrator
    web-dashboard
    ai-gateway
    routing
    # full profile (hardware-facing services)
    file-indexer
    switch
    camera-discovery
    oled-display
    # linux profile (audio-facing services; the OS-specific gate keeps
    # macOS Docker Desktop from trying to mount /dev/snd which doesn't exist)
    voice-io
  )

  # pm profile: the Plane PM stack runs upstream pre-built images (makeplane/*)
  # which `up -d` pulls, EXCEPT pm-health, the Droplet-side /health sidecar
  # built from services/pm/Dockerfile. pm-health is `["pm"]`-profiled, so when
  # `pm` is in the active set `up -d` tries to start it; `up` does not build on
  # demand, so without a pre-build the start fails with "No such image:
  # docker-pm-health". Build it ONLY when PM is enabled for this deployment —
  # the same opt-OUT gate scripts/lib/single-box.sh uses (DROPLET_PM_ENABLED,
  # default ON). A disabled-PM single-box (DROPLET_PM_ENABLED=0) never appends
  # `pm` to COMPOSE_PROFILES, so it must NOT pull/build the Plane sidecar either.
  #
  # Gate token check inlined (kept in sync with _droplet_pm_enabled in
  # scripts/lib/single-box.sh): enabled unless the value is 0/false/no.
  local build_pm_health=1
  local pm_enabled_val
  # `|| true`: DROPLET_PM_ENABLED is opt-out/default-on, so a fresh .env has no
  # such line; grep exits 1 and (the `2>/dev/null` only hides stderr, not the
  # exit code) under `set -euo pipefail` aborts build_images() silently — this
  # is the bug that killed the reflash at "Building application containers".
  pm_enabled_val=$(grep -E '^DROPLET_PM_ENABLED=' "$COMPOSE_ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr '[:upper:]' '[:lower:]' || true)
  case "$pm_enabled_val" in
    0|false|no) build_pm_health=0 ;;
  esac
  if [ "$build_pm_health" -eq 1 ]; then
    build_services+=(pm-health)
  else
    log_info "Plane PM disabled (DROPLET_PM_ENABLED=$pm_enabled_val) — skipping pm-health build"
  fi

  # All profiles that carry a buildable service in the list above must be active
  # so compose can see every one. Without --profile linux, `build voice-io`
  # errors out because the service is invisible to compose's view of the
  # project; without --profile pm the same is true for pm-health. (pm-health is
  # only in build_services when PM is enabled, so --profile pm is harmless
  # otherwise.) Default-profile services are visible regardless of --profile.
  for svc in "${build_services[@]}"; do
    if ! run_with_spinner "Building $svc" \
      run_docker_compose --profile full --profile linux --profile pm --env-file "$COMPOSE_ENV_FILE" \
        -f "$COMPOSE_FILE" \
        build "$svc"; then
      log_error "Failed to build $svc"
      _suggest_build_fix
      return 1
    fi
  done

  log_success "All images built"
  log_divider
}

# =============================================================================
# Start
# =============================================================================
start_stack() {
  log_info "Starting the Droplet stack..."

  # Validate all required secrets before starting
  _validate_env || return 1

  # --- Source .env for variable substitution ---
  if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
  fi

  # --- Ensure mosquitto password directory exists for compose mount ---
  mkdir -p "$REPO_ROOT/docker/mosquitto_passwd_dir"

  # --- Start infrastructure first ---
  run_with_spinner "Starting database, cache, and broker" \
    run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" up -d db cache broker

  # --- Wait for Postgres to be healthy ---
  log_info "Waiting for PostgreSQL to be ready..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T db pg_isready -U "${POSTGRES_USER:-droplet}" >/dev/null 2>&1; then
      log_success "PostgreSQL is ready"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done
  if [ $retries -eq 0 ]; then
    log_error "PostgreSQL did not become ready within 60 seconds"
    log_error "Check logs: docker compose -f docker/docker-compose.yml logs db"
    return 1
  fi

  # --- Ensure Nextcloud database exists (init script only runs on fresh volumes) ---
  log_info "Ensuring Nextcloud database exists..."
  run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" db \
    psql -U "${POSTGRES_USER:-droplet}" -w -tc \
    "SELECT 1 FROM pg_database WHERE datname = 'nextcloud'" 2>/dev/null | grep -q 1 || \
  run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" db \
    psql -U "${POSTGRES_USER:-droplet}" -w -c \
    "CREATE DATABASE nextcloud OWNER ${POSTGRES_USER:-droplet}" 2>/dev/null
  log_success "Nextcloud database ready"

  # --- Start all remaining services (Nextcloud needs to be up for install check) ---
  run_with_spinner "Starting all services" \
    run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" up -d

  # --- Wait for services to stabilize ---
  log_info "Waiting for services to start..."
  local wait_retries=60
  while [ $wait_retries -gt 0 ]; do
    local running
    running=$(run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" ps --status running --format json 2>/dev/null | wc -l || echo 0)
    # Expect at least 7 services: db, cache, broker, gateway, orchestrator, web-dashboard, ai-gateway
    if [ "$running" -ge 7 ] 2>/dev/null; then
      break
    fi
    wait_retries=$((wait_retries - 1))
    sleep 5
  done
  if [ $wait_retries -eq 0 ]; then
    log_warn "Some services may still be starting — continuing with verification"
  fi

  # --- Wait for Nextcloud initial setup to complete ---
  # Nextcloud auto-installs on first boot (empty nextcloud-data volume).
  # The OCS API and setup wizard won't work until this finishes.
  log_info "Waiting for Nextcloud to complete initial setup..."
  local nc_retries=60  # 5 minutes (60 * 5s)
  while [ $nc_retries -gt 0 ]; do
    local nc_status
    nc_status=$(curl -sf http://localhost:8080/status.php 2>/dev/null \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('installed',False))" 2>/dev/null \
      || echo "false")
    if [ "$nc_status" = "True" ]; then
      log_success "Nextcloud is installed and ready"
      break
    fi
    nc_retries=$((nc_retries - 1))
    sleep 5
  done
  if [ $nc_retries -eq 0 ]; then
    log_warn "Nextcloud setup may still be in progress — check: docker compose logs nextcloud"
  fi

  # --- Wait for orchestrator health (via Nginx on port 80) ---
  log_info "Waiting for services to be healthy..."
  local health_retries=30
  while [ $health_retries -gt 0 ]; do
    if curl -sf http://localhost/api/health >/dev/null 2>&1; then
      log_success "Stack is healthy (Nginx → Orchestrator responding)"
      break
    fi
    health_retries=$((health_retries - 1))
    sleep 2
  done
  if [ $health_retries -eq 0 ]; then
    log_warn "Health check timed out — services may still be starting"
    log_info "Check logs: docker compose -f docker/docker-compose.yml logs"
  fi

  log_success "Stack is running"
  log_divider
}

_suggest_build_fix() {
  log_info ""
  log_info "Build troubleshooting:"
  log_info "  - Low memory: try closing other apps or increasing swap"
  log_info "  - Disk full:  run 'docker system prune -a' to reclaim space"
  log_info "  - Re-run:     ./scripts/setup.sh --skip-docker"
}
