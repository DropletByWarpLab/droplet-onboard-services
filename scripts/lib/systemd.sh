#!/usr/bin/env bash
# systemd.sh — Optional systemd service for auto-starting the stack on boot.
# Source this file; do not execute directly.

# =============================================================================
# render_systemd_unit — pure helper; echoes the unit text to stdout.
#
# Arguments:
#   $1  repo_root    — absolute path to the repo root (where .env lives)
#   $2  compose_file — absolute path to the docker-compose.yml file
#   $3  run_user     — the OS user the stack should run as (required)
#
# COMPOSE_PROFILES is read from the environment at render time (setup.sh
# sources .env before calling install_systemd_service, so the value is
# already expanded). The rendered unit is a static snapshot: re-run
# `setup.sh --systemd` to regenerate after a profile change.
#
# COMPOSE_PROFILES is a comma-separated list (e.g. "linux,display"). The
# Compose CLI `--profile` flag takes ONE profile per occurrence and does
# NOT comma-split (only the COMPOSE_PROFILES env var does), so each profile
# is emitted as its own `--profile <name>` flag — mirroring the repeated-flag
# pattern in scripts/lib/compose.sh. A single `--profile linux,display` would
# be treated as one profile name matching nothing, leaving the linux/display
# services unstarted on boot.
#
# When COMPOSE_PROFILES is empty (macOS dev, default-only stack), no
# --profile flag is emitted so Docker Compose uses its own default
# resolution — no empty-string --profile "" which is a bad CLI syntax.
# =============================================================================
render_systemd_unit() {
  local repo_root="$1"
  local compose_file="$2"
  local run_user="${3:?render_systemd_unit: run_user (arg 3) is required}"
  local env_file="$repo_root/.env"
  # shellcheck disable=SC2153
  local profiles="${COMPOSE_PROFILES:-}"

  # Build the profile fragment: one --profile flag per comma-split profile.
  # The Compose CLI does not split a comma-joined value, so we must repeat
  # the flag (see scripts/lib/compose.sh for the same pattern).
  local profile_flag=""
  if [ -n "$profiles" ]; then
    local _prof
    IFS=',' read -ra _profs <<< "$profiles"
    for _prof in "${_profs[@]}"; do
      # Skip empty fields from stray/trailing commas.
      [ -n "$_prof" ] && profile_flag+=" --profile $_prof"
    done
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
User=$run_user
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

  # Resolve the OS user the stack should run as. setup.sh runs under sudo, so
  # $USER is frequently empty or "root" depending on PAM/env_reset — using it
  # would either make systemd reject the unit ("Failed to parse user") or run
  # the whole stack as root. Prefer the invoking user ($SUDO_USER), fall back
  # to the real uid's name, and refuse to render a root-owned unit.
  local run_user="${SUDO_USER:-$(id -un)}"
  if [ -z "$run_user" ] || [ "$run_user" = "root" ]; then
    log_error "Cannot resolve a non-root user for the systemd unit (got: '${run_user:-<empty>}')."
    log_error "Re-run setup.sh via 'sudo' as a normal user so \$SUDO_USER is set."
    return 1
  fi

  render_systemd_unit "$REPO_ROOT" "$COMPOSE_FILE" "$run_user" \
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
