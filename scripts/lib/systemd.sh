#!/usr/bin/env bash
# systemd.sh — Optional systemd service for auto-starting the stack on boot.
# Source this file; do not execute directly.

# =============================================================================
# render_systemd_unit — pure helper; echoes the unit text to stdout.
#
# Arguments:
#   $1  repo_root    — absolute path to the repo root (where .env lives)
#   $2  compose_file — absolute path to the docker-compose.yml file
#
# COMPOSE_PROFILES is read from the environment at render time (setup.sh
# sources .env before calling install_systemd_service, so the value is
# already expanded). The rendered unit is a static snapshot: re-run
# `setup.sh --systemd` to regenerate after a profile change.
#
# When COMPOSE_PROFILES is empty (macOS dev, default-only stack), the
# --profile flag is omitted so Docker Compose uses its own default
# resolution — no empty-string --profile "" which is a bad CLI syntax.
# =============================================================================
render_systemd_unit() {
  local repo_root="$1"
  local compose_file="$2"
  local env_file="$repo_root/.env"
  # shellcheck disable=SC2153
  local profiles="${COMPOSE_PROFILES:-}"

  # Build the profile fragment only when profiles are actually set.
  local profile_flag=""
  if [ -n "$profiles" ]; then
    profile_flag=" --profile $profiles"
  fi

  cat <<UNIT
[Unit]
Description=Droplet Edge Platform
Documentation=https://github.com/Nahast/droplet
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$(dirname "$compose_file")
EnvironmentFile=$env_file
ExecStartPre=/usr/bin/docker compose --env-file $env_file -f $compose_file config -q
ExecStart=/usr/bin/docker compose --env-file $env_file -f $compose_file${profile_flag} up -d --remove-orphans
ExecStop=/usr/bin/docker compose --env-file $env_file -f $compose_file down
ExecReload=/usr/bin/docker compose --env-file $env_file -f $compose_file${profile_flag} up -d --remove-orphans --force-recreate
User=$USER
Group=docker
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
UNIT
}

install_systemd_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    log_warn "systemctl not found — skipping systemd service installation"
    return 0
  fi

  local service_name="droplet"
  local service_file="/etc/systemd/system/${service_name}.service"

  log_info "Installing systemd service: ${service_name}.service"

  render_systemd_unit "$REPO_ROOT" "$COMPOSE_FILE" \
    | sudo tee "$service_file" > /dev/null

  sudo systemctl daemon-reload
  sudo systemctl enable "$service_name" >/dev/null 2>&1

  log_success "Systemd service installed and enabled"
  log_info "  Start:   sudo systemctl start $service_name"
  log_info "  Stop:    sudo systemctl stop $service_name"
  log_info "  Status:  sudo systemctl status $service_name"
  log_info "  Logs:    sudo journalctl -u $service_name"
  log_info ""
  log_info "  The stack will start automatically on boot."
  log_info "  Re-run \`setup.sh --systemd\` after editing .env to refresh the unit."
}
