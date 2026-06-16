#!/usr/bin/env bash
# preflight.sh — OS, architecture, disk, memory, and connectivity checks.
# Source this file; do not execute directly.

preflight_check() {
  log_info "Running preflight checks..."

  # --- macOS early return (no sudo, no Linux checks needed) ---
  if [ "$(uname)" = "Darwin" ]; then
    log_warn "OS: macOS detected — skipping Linux-specific checks"
    log_warn "Docker Desktop must be installed separately on macOS"
    # shellcheck disable=SC2034  # Read cross-file by scripts/lib/docker.sh (install_docker + ensure_docker_group) to short-circuit apt-get install; shellcheck can't trace the cross-source guard.
    SKIP_DOCKER_INSTALL=true
    return 0
  fi

  # --- Must not be root ---
  if [ "$EUID" -eq 0 ]; then
    log_error "Do not run this script as root."
    log_error "Run as a normal user with sudo access: ./scripts/setup.sh"
    return 1
  fi

  # --- sudo access ---
  # Only probe sudo when we actually need it (Docker install, usermod, apt).
  # Factory reset re-runs setup.sh with --skip-docker, which must work
  # unattended — prompting for a password there would hang the device.
  #
  # We use `sudo -n true` rather than `sudo -v` because on Ubuntu 24.04 with
  # the default `Defaults use_pty` sudoers setting, `sudo -v` does NOT honor
  # NOPASSWD entries and prompts for a password anyway — hanging
  # non-interactive deploys (nohup, ansible, systemd-run). `sudo -n true`
  # is the correct primitive for "can this user sudo without prompting":
  # it actually runs a command non-interactively and respects NOPASSWD.
  #
  # The fallback drops `-n` ON PURPOSE: on a provisioned box the firstboot
  # NOPASSWD drop-in is gone (it is removed when provisioning succeeds), so
  # an operator re-running setup.sh must get a real password prompt. With a
  # TTY sudo prompts; without one it errors out immediately — never hangs.
  if [ "${SKIP_DOCKER:-false}" != "true" ]; then
    if ! sudo -n true 2>/dev/null; then
      log_info "sudo access required. Please enter your password."
      if ! sudo true; then
        log_error "Could not obtain sudo access."
        return 1
      fi
    fi
    log_success "sudo access confirmed"
  else
    log_info "sudo check skipped (--skip-docker, unattended path)"
  fi

  # --- OS detection ---
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "$ID" in
      debian|raspbian)
        log_success "OS: $PRETTY_NAME"
        ;;
      ubuntu)
        log_warn "OS: $PRETTY_NAME (Ubuntu — supported but not primary target)"
        ;;
      *)
        if echo "$ID_LIKE" | grep -q "debian"; then
          log_warn "OS: $PRETTY_NAME (Debian-derivative — should work)"
        else
          log_error "Unsupported OS: $PRETTY_NAME"
          log_error "This script requires Debian, Raspbian, or Ubuntu."
          return 1
        fi
        ;;
    esac
  else
    log_error "Cannot detect OS. /etc/os-release not found."
    return 1
  fi

  # --- Architecture ---
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64)
      log_success "Architecture: $arch (ARM64)"
      ;;
    x86_64)
      log_success "Architecture: $arch"
      ;;
    armv7l|armv6l)
      log_error "Architecture: $arch (32-bit ARM is not supported)"
      log_error "PostgreSQL 16 Alpine and Node.js 20 require 64-bit ARM (aarch64)."
      return 1
      ;;
    *)
      log_warn "Architecture: $arch (untested — proceed with caution)"
      ;;
  esac

  # --- Disk space ---
  # Appliance-image ordering dependency (M2.8 SD-card image): on a freshly
  # flashed appliance image, the rootfs partition is small (~the baked image
  # size) until it auto-expands. The image's first boot MUST run the rootfs
  # auto-expand (raspi-config `do_expand_rootfs` / pi-gen's default
  # init=.../resize2fs_once) BEFORE droplet-firstboot.service invokes
  # setup.sh, or this >=8 GB free gate fails on an otherwise-large SD card.
  # The baked Pi OS first-boot resize runs in early boot (before
  # multi-user.target), and droplet-firstboot.service is ordered
  # After=network-online.target docker.service (well after the resize), so the
  # ordering holds by construction. If you bake a custom image that disables
  # the auto-expand, size the rootfs partition >= 12 GB so this check passes.
  local avail_kb avail_gb
  avail_kb=$(df --output=avail "$REPO_ROOT" 2>/dev/null | tail -1 | tr -d ' ')
  if [ -n "$avail_kb" ]; then
    avail_gb=$((avail_kb / 1048576))
    if [ "$avail_gb" -lt 8 ]; then
      log_error "Disk: ${avail_gb} GB free — need at least 8 GB"
      log_error "Docker images require ~4-5 GB plus build cache."
      return 1
    elif [ "$avail_gb" -lt 12 ]; then
      log_warn "Disk: ${avail_gb} GB free (tight — 12+ GB recommended)"
    else
      log_success "Disk: ${avail_gb} GB free"
    fi
  else
    log_warn "Could not determine disk space (skipping check)"
  fi

  # --- Memory ---
  if [ -f /proc/meminfo ]; then
    local mem_kb mem_gb
    mem_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    mem_gb=$((mem_kb / 1048576))
    if [ "$mem_gb" -lt 2 ]; then
      log_error "Memory: ${mem_gb} GB — need at least 2 GB"
      return 1
    elif [ "$mem_gb" -lt 4 ]; then
      log_warn "Memory: ${mem_gb} GB (4+ GB recommended for building images)"
    else
      log_success "Memory: ${mem_gb} GB"
    fi
  else
    log_warn "Could not read /proc/meminfo (skipping memory check)"
  fi

  # --- Internet connectivity ---
  if command -v curl >/dev/null 2>&1; then
    if curl -sf --max-time 10 https://get.docker.com > /dev/null 2>&1; then
      log_success "Internet: connected"
    else
      log_error "Internet: cannot reach https://get.docker.com"
      log_error "Setup requires internet access to install Docker and pull images."
      return 1
    fi
  else
    log_warn "curl not installed — will install during Docker setup"
  fi

  log_divider
}
