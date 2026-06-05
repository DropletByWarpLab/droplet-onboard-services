#!/usr/bin/env bash
# =============================================================================
# Droplet Router Firmware Upgrade
# =============================================================================
#
# Upgrades a running OpenWrt instance on the Pi 5 without re-flashing the SD
# card. Uses OpenWrt's sysupgrade mechanism which preserves UCI configuration
# files (/etc/config/*) across upgrades.
#
# Run this from the Jetson (or any machine on the LAN), NOT on the router.
#
# Usage:
#   ./scripts/upgrade-router.sh <firmware-image>
#   ./scripts/upgrade-router.sh output/openwrt-*-sysupgrade.img.gz
#
# Options:
#   --host <ip>         Router IP (default: from OPENWRT_HOST env or 192.168.50.1)
#   --user <user>       SSH user (default: root)
#   --no-preserve       Don't preserve config (clean flash with new defaults)
#   --force             Skip compatibility check
#   --dry-run           Upload image but don't flash
#   --apply-defaults    After upgrade, re-run uci-defaults scripts (e.g. camera VLAN)
#   -h, --help          Show this help
#
# What gets preserved:
#   - /etc/config/* (all UCI configs: network, firewall, wireless, dhcp)
#   - /etc/droplet/* (device credentials)
#   - /etc/passwd, /etc/shadow (user accounts)
#   - Custom files listed in /etc/sysupgrade.conf
#
# What gets updated:
#   - Kernel + kernel modules
#   - Packages (opkg, luci, drivers, etc.)
#   - /etc/uci-defaults/* scripts run on first boot after upgrade
#
# After upgrade:
#   - Router reboots automatically (~60-90 seconds)
#   - Existing cameras, VLAN config, firewall rules are preserved
#   - New features from /etc/uci-defaults/ are applied on boot
# =============================================================================
set -euo pipefail

# --- Defaults ---
# WARP-815: single documented OPENWRT_HOST default — the multi-box Pi-5 router
# (matches docker/docker-compose.yml + services/routing/main.py + docs).
ROUTER_HOST="${OPENWRT_HOST:-192.168.50.1}"
ROUTER_USER="root"
PRESERVE_CONFIG=true
FORCE=false
DRY_RUN=false
APPLY_DEFAULTS=false
FIRMWARE_FILE=""

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${CYAN}info${RESET}  %s\n" "$*"; }
ok()    { printf "${GREEN}ok${RESET}    %s\n" "$*"; }
warn()  { printf "${YELLOW}warn${RESET}  %s\n" "$*"; }
err()   { printf "${RED}error${RESET} %s\n" "$*" >&2; }

# --- Parse arguments ---
while [ $# -gt 0 ]; do
    case "$1" in
        --host)           ROUTER_HOST="$2"; shift 2 ;;
        --user)           ROUTER_USER="$2"; shift 2 ;;
        --no-preserve)    PRESERVE_CONFIG=false; shift ;;
        --force)          FORCE=true; shift ;;
        --dry-run)        DRY_RUN=true; shift ;;
        --apply-defaults) APPLY_DEFAULTS=true; shift ;;
        -h|--help)
            sed -n '2,/^# =====/{ /^#/s/^# \?//p }' "$0"
            exit 0
            ;;
        -*)
            err "Unknown option: $1"
            exit 1
            ;;
        *)
            FIRMWARE_FILE="$1"
            shift
            ;;
    esac
done

if [ -z "$FIRMWARE_FILE" ]; then
    err "Usage: $0 <firmware-image> [options]"
    err "  e.g.: $0 output/openwrt-24.10.0-bcm27xx-bcm2712-rpi-5-droplet-squashfs-sysupgrade.img.gz"
    exit 1
fi

if [ ! -f "$FIRMWARE_FILE" ]; then
    err "Firmware file not found: $FIRMWARE_FILE"
    exit 1
fi

FIRMWARE_SIZE=$(du -sh "$FIRMWARE_FILE" | cut -f1)
FIRMWARE_NAME=$(basename "$FIRMWARE_FILE")

# =============================================================================
printf "\n${BOLD}Droplet Router Firmware Upgrade${RESET}\n\n"
printf "  Router:    ${CYAN}%s@%s${RESET}\n" "$ROUTER_USER" "$ROUTER_HOST"
printf "  Firmware:  ${CYAN}%s${RESET} (%s)\n" "$FIRMWARE_NAME" "$FIRMWARE_SIZE"
printf "  Preserve:  %s\n" "$([ "$PRESERVE_CONFIG" = "true" ] && echo "yes (keep /etc/config)" || echo "NO — clean flash")"
printf "\n"

# --- Step 1: Check router is reachable ---
info "Checking router connectivity..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${ROUTER_USER}@${ROUTER_HOST}" 'echo ok' >/dev/null 2>&1; then
    err "Cannot SSH to ${ROUTER_USER}@${ROUTER_HOST}"
    err "Make sure:"
    err "  - Router is running and on the network"
    err "  - SSH key is configured (ssh-copy-id root@${ROUTER_HOST})"
    err "  - Or set --host to the correct IP"
    exit 1
fi
ok "Router reachable via SSH"

# --- Step 2: Get current firmware info ---
info "Reading current firmware version..."
CURRENT_VERSION=$(ssh "${ROUTER_USER}@${ROUTER_HOST}" 'cat /etc/openwrt_release 2>/dev/null | grep DISTRIB_RELEASE | cut -d= -f2 | tr -d "'"'"'"' || echo "unknown"')
CURRENT_BOARD=$(ssh "${ROUTER_USER}@${ROUTER_HOST}" 'ubus call system board 2>/dev/null | grep -o "\"model\":\"[^\"]*\"" | head -1 || echo "unknown"')
FLASH_FREE=$(ssh "${ROUTER_USER}@${ROUTER_HOST}" 'df -h /tmp 2>/dev/null | tail -1 | awk "{print \$4}"' || echo "?")

printf "  Current version: %s\n" "$CURRENT_VERSION"
printf "  Board: %s\n" "$CURRENT_BOARD"
printf "  /tmp free: %s\n" "$FLASH_FREE"

# --- Step 3: Compatibility check ---
if [ "$FORCE" != "true" ]; then
    # Check the firmware filename contains the right target
    if ! echo "$FIRMWARE_NAME" | grep -qi "bcm27xx\|bcm2712\|rpi-5\|rpi5"; then
        warn "Firmware file doesn't appear to be for bcm2712/rpi-5"
        warn "File: $FIRMWARE_NAME"
        printf "  Continue anyway? [y/N] "
        read -r answer
        [ "$answer" = "y" ] || [ "$answer" = "Y" ] || exit 1
    fi
fi

# --- Step 4: Upload firmware ---
info "Uploading firmware to router (/tmp/)..."
scp -o ConnectTimeout=10 "$FIRMWARE_FILE" "${ROUTER_USER}@${ROUTER_HOST}:/tmp/${FIRMWARE_NAME}"
ok "Firmware uploaded (${FIRMWARE_SIZE})"

# --- Step 5: Verify upload ---
info "Verifying uploaded image..."
REMOTE_MD5=$(ssh "${ROUTER_USER}@${ROUTER_HOST}" "md5sum /tmp/${FIRMWARE_NAME} | cut -d' ' -f1")
LOCAL_MD5=$(md5sum "$FIRMWARE_FILE" | cut -d' ' -f1)
if [ "$REMOTE_MD5" != "$LOCAL_MD5" ]; then
    err "MD5 mismatch — upload corrupted"
    err "  Local:  $LOCAL_MD5"
    err "  Remote: $REMOTE_MD5"
    ssh "${ROUTER_USER}@${ROUTER_HOST}" "rm -f /tmp/${FIRMWARE_NAME}"
    exit 1
fi
ok "MD5 verified: $LOCAL_MD5"

# --- Step 6: Flash ---
if [ "$DRY_RUN" = "true" ]; then
    warn "Dry run — skipping flash. Firmware is at /tmp/${FIRMWARE_NAME} on the router."
    warn "To flash manually: ssh ${ROUTER_USER}@${ROUTER_HOST} 'sysupgrade -v /tmp/${FIRMWARE_NAME}'"
    exit 0
fi

SYSUPGRADE_OPTS="-v"
if [ "$PRESERVE_CONFIG" != "true" ]; then
    SYSUPGRADE_OPTS="-v -n"  # -n = don't preserve config
fi

printf "\n"
warn "Starting sysupgrade — router will reboot in ~10 seconds."
warn "Connection will drop. This is normal."
printf "\n"
printf "  Continue? [y/N] "
read -r answer
if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    info "Aborted. Firmware left at /tmp/${FIRMWARE_NAME}"
    exit 0
fi

# Run sysupgrade (will kill the SSH connection as the router reboots)
ssh "${ROUTER_USER}@${ROUTER_HOST}" "sysupgrade ${SYSUPGRADE_OPTS} /tmp/${FIRMWARE_NAME}" 2>/dev/null || true

# --- Step 7: Wait for reboot ---
printf "\n"
info "Router is upgrading and rebooting..."
info "Waiting for router to come back online (up to 3 minutes)..."

TIMEOUT=180
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    if ssh -o ConnectTimeout=3 -o BatchMode=yes "${ROUTER_USER}@${ROUTER_HOST}" 'echo ok' >/dev/null 2>&1; then
        ok "Router is back online after ${ELAPSED}s"
        break
    fi
    printf "."
done
printf "\n"

if [ $ELAPSED -ge $TIMEOUT ]; then
    err "Router did not come back within ${TIMEOUT}s"
    err "This may be normal for first boot after upgrade."
    err "Check manually: ssh ${ROUTER_USER}@${ROUTER_HOST}"
    exit 1
fi

# --- Step 8: Verify upgrade ---
NEW_VERSION=$(ssh "${ROUTER_USER}@${ROUTER_HOST}" 'cat /etc/openwrt_release 2>/dev/null | grep DISTRIB_RELEASE | cut -d= -f2 | tr -d "'"'"'"' || echo "unknown"')
info "New version: ${NEW_VERSION}"

# --- Step 9: Apply defaults (optional) ---
if [ "$APPLY_DEFAULTS" = "true" ]; then
    info "Applying uci-defaults scripts..."
    # Copy the camera subnet setup script and run it
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    if [ -f "${SCRIPT_DIR}/setup-camera-subnet.sh" ]; then
        scp "${SCRIPT_DIR}/setup-camera-subnet.sh" "${ROUTER_USER}@${ROUTER_HOST}:/tmp/"
        ssh "${ROUTER_USER}@${ROUTER_HOST}" 'sh /tmp/setup-camera-subnet.sh'
        ok "Camera subnet configuration applied"
    fi
fi

# --- Done ---
printf "\n"
printf "${BOLD}${GREEN}Upgrade complete!${RESET}\n"
printf "\n"
printf "  Previous: %s\n" "$CURRENT_VERSION"
printf "  Current:  %s\n" "$NEW_VERSION"
printf "  Config:   %s\n" "$([ "$PRESERVE_CONFIG" = "true" ] && echo "preserved" || echo "clean")"
printf "\n"
if [ "$PRESERVE_CONFIG" = "true" ]; then
    printf "  UCI configs were preserved. Camera VLAN, firewall rules,\n"
    printf "  WiFi settings, and DHCP are unchanged.\n"
else
    printf "  Clean flash — run setup-camera-subnet.sh to reconfigure\n"
    printf "  the camera VLAN if needed.\n"
fi
printf "\n"
