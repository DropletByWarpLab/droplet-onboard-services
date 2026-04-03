#!/usr/bin/env bash
# compose.sh — Pull images, build containers, start the stack, wait for health.
# Source this file; do not execute directly.

COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
COMPOSE_ENV_FILE="$REPO_ROOT/.env"

prepare_and_build() {
  # --- Ensure init scripts are executable ---
  chmod +x "$REPO_ROOT/docker/init-nextcloud-db.sh" 2>/dev/null || true

  # --- Ensure mosquitto passwd dir exists for compose mount ---
  mkdir -p "$REPO_ROOT/docker/mosquitto_passwd_dir"

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
  log_info "Building application containers..."
  if ! run_with_spinner "Building orchestrator" \
    run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" build orchestrator; then
    log_error "Failed to build orchestrator"
    _suggest_build_fix
    return 1
  fi

  if ! run_with_spinner "Building web-dashboard" \
    run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" build web-dashboard; then
    log_error "Failed to build web-dashboard"
    _suggest_build_fix
    return 1
  fi

  if ! run_with_spinner "Building ai-gateway" \
    run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" build ai-gateway; then
    log_error "Failed to build ai-gateway"
    _suggest_build_fix
    return 1
  fi

  log_success "All images built"
  log_divider
}

start_stack() {
  log_info "Starting the Droplet stack..."

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
  run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T db \
    psql -U "${POSTGRES_USER:-droplet}" -tc \
    "SELECT 1 FROM pg_database WHERE datname = 'nextcloud'" 2>/dev/null | grep -q 1 || \
  run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T db \
    psql -U "${POSTGRES_USER:-droplet}" -c \
    "CREATE DATABASE nextcloud OWNER ${POSTGRES_USER:-droplet}" 2>/dev/null
  log_success "Nextcloud database ready"

  # --- Start all remaining services ---
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
