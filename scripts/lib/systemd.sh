#!/usr/bin/env bash
# systemd.sh — Optional systemd service for auto-starting the stack on boot.
# Source this file; do not execute directly.

install_systemd_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    log_warn "systemctl not found — skipping systemd service installation"
    return 0
  fi

  local service_name="droplet"
  local service_file="/etc/systemd/system/${service_name}.service"
  local compose_dir="$REPO_ROOT/docker"
  local compose_file="$COMPOSE_FILE"

  log_info "Installing systemd service: ${service_name}.service"

  sudo tee "$service_file" > /dev/null << EOF
[Unit]
Description=Droplet Edge Platform
Documentation=https://github.com/Nahast/droplet
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$compose_dir
EnvironmentFile=$REPO_ROOT/.env
ExecStart=/usr/bin/docker compose -f $compose_file up -d
ExecStop=/usr/bin/docker compose -f $compose_file down
ExecReload=/usr/bin/docker compose -f $compose_file restart
User=$USER
Group=docker
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable "$service_name" >/dev/null 2>&1

  log_success "Systemd service installed and enabled"
  log_info "  Start:   sudo systemctl start $service_name"
  log_info "  Stop:    sudo systemctl stop $service_name"
  log_info "  Status:  sudo systemctl status $service_name"
  log_info "  Logs:    sudo journalctl -u $service_name"
  log_info ""
  log_info "  The stack will start automatically on boot."
}
