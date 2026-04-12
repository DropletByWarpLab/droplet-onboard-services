#!/usr/bin/env bash
# docker.sh — Docker Engine installation and group management.
# Source this file; do not execute directly.

# Flag set if user was just added to docker group (needs re-login)
DOCKER_GROUP_ADDED=false

# Decide ONCE whether docker needs sudo, and cache the answer.
#
# The previous wrappers tried `docker …` first and fell back to `sudo docker …`
# on any non-zero exit code. That conflated two very different failures:
#   (a) docker daemon not reachable → sudo is the right escalation
#   (b) the command wrapped by `docker … exec` returned non-zero → sudo is wrong
# Polling loops (pg_isready, health probes) legitimately return non-zero until a
# service is ready; the old wrapper interpreted each attempt as (a) and invoked
# sudo, which prints a password prompt to /dev/tty that the caller's stderr
# redirection cannot suppress. That's the "Password:" prompt surfacing under
# "Waiting for PostgreSQL to be ready…".
#
# This version probes `docker info` exactly once and remembers the result, and
# NEVER prompts interactively. Interactive sudo, when it is actually needed
# (initial attended Linux install), is handled by preflight_check before we get
# here; by that point sudo credentials are cached and `sudo -n` succeeds.
# Cached detection: "", "false", "true"
_DOCKER_SUDO=""

detect_docker_sudo() {
  [ -n "$_DOCKER_SUDO" ] && return 0

  # macOS Docker Desktop never needs sudo.
  if [ "$(uname)" = "Darwin" ]; then
    _DOCKER_SUDO=false
    return 0
  fi

  # Reachable as the current user? Typical unattended factory-reset path.
  if docker info >/dev/null 2>&1; then
    _DOCKER_SUDO=false
    return 0
  fi

  # Sudo cached from preflight (initial attended install)?
  if sudo -n docker info >/dev/null 2>&1; then
    _DOCKER_SUDO=true
    return 0
  fi

  # Never prompt here — the callers run inside spinners and polling loops
  # where a hidden password prompt is a footgun. Fail loudly instead.
  log_error "Docker daemon is not reachable as '$USER'."
  log_error "  - On the device: user must be in the 'docker' group."
  log_error "  - Check with:    id -nG \"\$USER\" | grep -qw docker"
  log_error "  - On initial install, preflight_check should have warmed sudo credentials."
  return 1
}

run_docker() {
  detect_docker_sudo || return 1
  if [ "$_DOCKER_SUDO" = "true" ]; then
    sudo -n docker "$@"
  else
    docker "$@"
  fi
}

run_docker_compose() {
  detect_docker_sudo || return 1
  if [ "$_DOCKER_SUDO" = "true" ]; then
    sudo -n docker compose "$@"
  else
    docker compose "$@"
  fi
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
