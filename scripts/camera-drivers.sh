#!/usr/bin/env bash
# =============================================================================
# Droplet Camera Driver Tool
# =============================================================================
#
# Checks, installs, and diagnoses camera driver support on the Droplet device.
#
# Usage:
#   ./scripts/camera-drivers.sh [COMMAND]
#
# Commands:
#   check      Show current driver status (default)
#   install    Install missing drivers and configure system
#   scan       Detect connected cameras (USB + V4L2)
#   fix        Auto-detect and fix common driver issues
#
# Examples:
#   ./scripts/camera-drivers.sh                # Same as 'check'
#   ./scripts/camera-drivers.sh install        # Install everything
#   ./scripts/camera-drivers.sh scan           # Find cameras
#   ./scripts/camera-drivers.sh fix            # Auto-fix issues
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT

# Source libraries
source "$SCRIPT_DIR/lib/logging.sh"
source "$SCRIPT_DIR/lib/camera-drivers.sh"

COMMAND="${1:-check}"

case "$COMMAND" in
  check|status)
    check_camera_drivers
    ;;

  install|setup)
    log_divider
    printf "\n  ${_BOLD}Droplet Camera Driver Setup${_RESET}\n\n"
    log_divider
    install_camera_drivers
    printf "\n"
    log_divider
    printf "\n  ${_BOLD}Post-Install Status:${_RESET}\n"
    check_camera_drivers
    ;;

  scan|detect)
    printf "\n${_BOLD}Scanning for cameras...${_RESET}\n\n"

    printf "${_CYAN}USB Camera Detection:${_RESET}\n"
    camera_count=$(detect_usb_cameras)
    if [ "$camera_count" -gt 0 ]; then
      log_success "Found $camera_count USB camera device(s)"
    else
      log_info "No USB cameras detected"
    fi

    printf "\n${_CYAN}V4L2 Devices:${_RESET}\n"
    detect_v4l2_devices

    printf "\n${_CYAN}/dev/video Devices:${_RESET}\n"
    if ls /dev/video* &>/dev/null; then
      ls -la /dev/video* 2>/dev/null
    else
      printf "  ${_DIM}(none found)${_RESET}\n"
    fi

    # Check if any RTSP cameras are on the network
    printf "\n${_CYAN}Network Cameras (RTSP on port 554):${_RESET}\n"
    if command -v nmap &>/dev/null; then
      # Quick scan of local subnet for port 554
      local_subnet=$(ip route show default 2>/dev/null | awk '{print $3}' | head -1 | sed 's/\.[0-9]*$/.0\/24/')
      if [ -n "$local_subnet" ]; then
        log_info "Scanning $local_subnet for RTSP cameras..."
        nmap -p 554 --open -T4 "$local_subnet" 2>/dev/null | grep -E "Nmap scan|554/tcp" || log_info "  No RTSP cameras found on network"
      fi
    else
      log_info "  Install nmap for network camera scanning: sudo apt install nmap"
    fi
    printf "\n"
    ;;

  fix|repair)
    printf "\n${_BOLD}Auto-fixing camera driver issues...${_RESET}\n\n"

    # 1. Check if modules exist but aren't loaded
    for module in "${CAMERA_KERNEL_MODULES[@]}"; do
      status=$(check_kernel_module "$module")
      if [ "$status" = "available" ]; then
        log_info "Loading unloaded module: $module"
        sudo modprobe "$module" 2>/dev/null && log_success "  Loaded $module" || log_warn "  Failed to load $module"
      fi
    done

    # 2. Fix permissions on /dev/video*
    if ls /dev/video* &>/dev/null; then
      log_info "Fixing permissions on video devices..."
      sudo chmod 660 /dev/video* 2>/dev/null || true
      sudo chgrp video /dev/video* 2>/dev/null || true
      log_success "Permissions fixed"
    fi

    # 3. Ensure user is in video group
    if ! groups "$USER" 2>/dev/null | grep -q "video"; then
      log_info "Adding $USER to video group..."
      sudo usermod -aG video "$USER"
      log_success "Added to video group (re-login needed)"
    fi

    # 4. Reload udev rules
    if [ -f "/etc/udev/rules.d/99-droplet-cameras.rules" ]; then
      log_info "Reloading udev rules..."
      sudo udevadm control --reload-rules 2>/dev/null || true
      sudo udevadm trigger 2>/dev/null || true
      log_success "Udev rules reloaded"
    fi

    # 5. Check if Frigate can see the devices
    if command -v docker &>/dev/null; then
      if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "frigate"; then
        log_info "Restarting Frigate to pick up device changes..."
        docker restart frigate 2>/dev/null && log_success "Frigate restarted" || log_warn "Failed to restart Frigate"
      fi
    fi

    printf "\n${_BOLD}Fix complete. Current status:${_RESET}\n"
    check_camera_drivers
    ;;

  -h|--help|help)
    cat << 'USAGE'
Usage: ./scripts/camera-drivers.sh [COMMAND]

Commands:
  check      Show current driver status (default)
  install    Install missing drivers and configure system
  scan       Detect connected cameras (USB + V4L2 + network)
  fix        Auto-detect and fix common driver issues

USAGE
    ;;

  *)
    log_error "Unknown command: $COMMAND"
    log_info "Run './scripts/camera-drivers.sh --help' for usage"
    exit 1
    ;;
esac
