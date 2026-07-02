#!/usr/bin/env bash
# backup.sh — WARP-254 restic backup host integration (install path).
# Source this file; do not execute directly.
#
# Installs the restic backup family onto the host:
#   /usr/local/sbin/droplet-backup.sh            daily/weekly restic backup
#   /usr/local/sbin/droplet-restore.sh           operator restore entry point
#   /usr/local/sbin/droplet-restore-drill.sh     monthly sandboxed restore drill
#   /usr/local/sbin/droplet-backup-lib.sh        shared derivation lib (sourced)
#   /etc/systemd/system/droplet-restic-backup.{service,timer}        daily
#   /etc/systemd/system/droplet-restic-backup-full.{service,timer}   weekly
#   /etc/systemd/system/droplet-restore-drill.{service,timer}        monthly
#
# The unit files carry the checkout path via an @REPO_ROOT@ placeholder that
# is sed-substituted at install time — the same pattern as
# install-device-bridge.sh. Idempotent: safe to re-run on every setup.sh
# (a moved checkout or updated script self-heals on the next run).
#
# Runs on EVERY Linux deployment shape (not just single-box) — every box has
# customer data worth backing up. Skipped silently on non-Linux dev hosts.

install_restic_backup() {
  if [ "$(uname)" != "Linux" ]; then
    log_info "restic backup host integration: skipping (not Linux)"
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    log_warn "restic backup host integration: systemctl not found — skipping"
    return 0
  fi

  local host_src="$REPO_ROOT/scripts/host"
  if [ ! -f "$host_src/droplet-backup.sh" ]; then
    log_warn "restic backup host integration: scripts/host/droplet-backup.sh missing — skipping"
    return 0
  fi

  log_info "Installing restic backup host integration (WARP-254)..."

  # --- restic itself ------------------------------------------------------
  # Best-effort provisioning from the distro (mirrors the python3-qrcode
  # pattern in install-device-bridge.sh): a transient apt failure must not
  # abort setup — the timers will surface a loud failed unit until restic
  # exists, and re-running setup.sh self-heals.
  if ! command -v restic >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      log_info "Installing restic from the distro..."
      if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y restic; then
        sudo apt-get update -y >/dev/null 2>&1 || true
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y restic || true
      fi
    fi
    if command -v restic >/dev/null 2>&1; then
      log_success "restic installed"
    else
      log_warn "restic still not installed — backups will fail until it is."
      log_warn "  Remediate: sudo apt-get install -y restic, then re-run ./scripts/setup.sh"
    fi
  fi

  # --- /usr/local/sbin/ scripts (host-script convention) -------------------
  sudo install -m 0755 "$host_src/droplet-backup.sh" /usr/local/sbin/droplet-backup.sh
  sudo install -m 0755 "$host_src/droplet-restore.sh" /usr/local/sbin/droplet-restore.sh
  sudo install -m 0755 "$host_src/droplet-restore-drill.sh" /usr/local/sbin/droplet-restore-drill.sh
  # The lib is sourced, never executed — 0644.
  sudo install -m 0644 "$host_src/droplet-backup-lib.sh" /usr/local/sbin/droplet-backup-lib.sh
  log_success "Installed /usr/local/sbin/droplet-{backup,restore,restore-drill}.sh + droplet-backup-lib.sh"

  # --- systemd units (@REPO_ROOT@ substituted to this checkout) ------------
  local unit
  for unit in droplet-restic-backup.service \
              droplet-restic-backup.timer \
              droplet-restic-backup-full.service \
              droplet-restic-backup-full.timer \
              droplet-restore-drill.service \
              droplet-restore-drill.timer; do
    if [ ! -f "$host_src/systemd/$unit" ]; then
      log_warn "restic backup host integration: missing unit source $unit — skipping install"
      return 0
    fi
    sed "s|@REPO_ROOT@|$REPO_ROOT|g" "$host_src/systemd/$unit" \
      | sudo tee "/etc/systemd/system/$unit" > /dev/null
    sudo chmod 0644 "/etc/systemd/system/$unit"
  done
  log_success "Installed 6 systemd units (daily + weekly-full + monthly drill)"

  # --- Activate -------------------------------------------------------------
  sudo systemctl daemon-reload
  sudo systemctl enable --now droplet-restic-backup.timer >/dev/null 2>&1
  sudo systemctl enable --now droplet-restic-backup-full.timer >/dev/null 2>&1
  sudo systemctl enable --now droplet-restore-drill.timer >/dev/null 2>&1

  log_success "restic backup host integration installed"
  log_info "  Repository:  \${DROPLET_BACKUP_TARGET:-/var/lib/droplet/restic-repo} (key derived from device identity)"
  log_info "  Cadence:     daily 03:15 / weekly-full Sun 04:15 / restore drill monthly 05:00"
  log_info "  Timers:      systemctl list-timers 'droplet-rest*'"
  log_info "  Drill state: /var/lib/droplet/backup/restore-drill-status.json (status: ok|failed)"
}
