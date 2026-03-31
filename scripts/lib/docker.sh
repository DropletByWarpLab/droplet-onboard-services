#!/usr/bin/env bash
# docker.sh — Docker Engine installation and group management.
# Source this file; do not execute directly.

# Flag set if user was just added to docker group (needs re-login)
DOCKER_GROUP_ADDED=false

# Wrapper: tries docker directly, falls back to sudo docker.
# Handles the case where user was just added to docker group but hasn't re-logged.
run_docker() {
  if docker "$@" 2>/dev/null; then
    return 0
  fi
  sudo docker "$@"
}

run_docker_compose() {
  if docker compose "$@" 2>/dev/null; then
    return 0
  fi
  sudo docker compose "$@"
}

install_docker() {
  if [ "${SKIP_DOCKER_INSTALL:-false}" = "true" ]; then
    log_info "Skipping Docker installation (macOS or --skip-docker)"
    return 0
  fi

  # --- Check if Docker is already installed ---
  if command -v docker >/dev/null 2>&1; then
    local docker_version
    docker_version=$(docker --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1 || echo "0")
    local major_version
    major_version=$(echo "$docker_version" | cut -d. -f1)

    if [ "$major_version" -ge 25 ] 2>/dev/null; then
      log_success "Docker $docker_version already installed"
    else
      log_warn "Docker $docker_version found but version 25+ recommended"
      log_info "Upgrading Docker..."
      _do_install_docker
    fi
  else
    log_info "Docker not found — installing..."
    _do_install_docker
  fi

  # --- Check Docker Compose v2 ---
  if ! docker compose version >/dev/null 2>&1 && ! sudo docker compose version >/dev/null 2>&1; then
    log_warn "Docker Compose plugin not included — installing separately..."
    sudo apt-get update -qq >/dev/null 2>&1
    sudo apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1
  fi

  if docker compose version >/dev/null 2>&1 || sudo docker compose version >/dev/null 2>&1; then
    local compose_version
    compose_version=$(docker compose version 2>/dev/null | grep -oP '\d+\.\d+' | head -1 || \
                      sudo docker compose version 2>/dev/null | grep -oP '\d+\.\d+' | head -1 || echo "?")
    log_success "Docker Compose v$compose_version available"
  else
    log_error "Docker Compose v2 not found after installation"
    log_error "Try: sudo apt-get install docker-compose-plugin"
    return 1
  fi

  # --- Ensure supplementary tools ---
  run_with_spinner "Installing supplementary packages" \
    sudo apt-get install -y -qq git curl openssl >/dev/null 2>&1 || true

  # --- Enable Docker service ---
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable docker >/dev/null 2>&1 || true
    sudo systemctl start docker >/dev/null 2>&1 || true
  fi

  log_divider
}

_do_install_docker() {
  # Ensure curl is available (preflight may have flagged it missing)
  if ! command -v curl >/dev/null 2>&1; then
    log_info "Installing curl (required for Docker install)..."
    sudo apt-get update -qq >/dev/null 2>&1
    sudo apt-get install -y -qq curl >/dev/null 2>&1
  fi

  local attempts=0
  local max_attempts=3

  while [ $attempts -lt $max_attempts ]; do
    attempts=$((attempts + 1))
    log_info "Docker install attempt $attempts/$max_attempts..."

    if run_with_spinner "Installing Docker Engine" \
      bash -c 'curl -fsSL https://get.docker.com | sudo sh'; then
      log_success "Docker installed successfully"
      return 0
    fi

    if [ $attempts -lt $max_attempts ]; then
      log_warn "Install failed — retrying in 5 seconds..."
      sleep 5
    fi
  done

  log_error "Docker installation failed after $max_attempts attempts"
  log_error "Check the log file: $LOG_FILE"
  return 1
}

setup_docker_group() {
  if [ "${SKIP_DOCKER_INSTALL:-false}" = "true" ]; then
    return 0
  fi

  # Check if user is already in docker group
  if id -nG "$USER" 2>/dev/null | grep -qw docker; then
    log_success "User '$USER' is already in the docker group"
    return 0
  fi

  # Add user to docker group
  log_info "Adding user '$USER' to the docker group..."
  if sudo usermod -aG docker "$USER"; then
    DOCKER_GROUP_ADDED=true
    log_success "Added '$USER' to docker group"
    log_warn "Group change takes effect after re-login — using sudo for Docker in this session"
  else
    log_error "Failed to add user to docker group"
    return 1
  fi
}
