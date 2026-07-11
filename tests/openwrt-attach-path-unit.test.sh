#!/usr/bin/env bash
# =============================================================================
# Regression guard — WARP-843 sandboxed hostapd env-file write + path-unit
# re-apply wiring
# =============================================================================
#
# The setup wizard's single-box "Home Wi-Fi" save failed 422: the device-bridge
# sandbox (User=droplet + ProtectSystem=strict + NoNewPrivileges) could neither
# write root-owned /etc/default/droplet-openwrt-attach (mktemp EROFS) nor rely
# on the polkit JS-rule restart route. The WARP-843 fix keeps the bridge fully
# sandboxed:
#
#   1. /etc/default/droplet-openwrt-attach is provisioned droplet:droplet 0600
#      (scripts/lib/single-box.sh + scripts/install-device-bridge.sh).
#   2. droplet-device-bridge.service adds ONLY ReadWritePaths=/etc/default and
#      keeps ProtectSystem=strict / NoNewPrivileges / RestrictSUIDSGID.
#   3. droplet-set-hostapd.sh / droplet-set-guest-wifi.sh skip the privileged
#      systemctl restart when unprivileged (EUID != 0 or *_NO_RESTART=1).
#   4. Root-owned droplet-openwrt-attach.path watches the env file and starts
#      the droplet-openwrt-attach-reapply.service relay (a plain oneshot — the
#      attach service itself is RemainAfterExit=yes, so a path-triggered START
#      of it would be a no-op), which restarts the attach service.
#
# This test statically pins every piece of that wiring so no single part can
# regress silently (the pieces live in five different files). Runtime: < 1s,
# no root/systemd/docker needed — pure static scan.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PATH_UNIT="$REPO_ROOT/scripts/host/etc-systemd-system/droplet-openwrt-attach.path"
REAPPLY_UNIT="$REPO_ROOT/scripts/host/etc-systemd-system/droplet-openwrt-attach-reapply.service"
BRIDGE_UNIT="$REPO_ROOT/services/oled-display/droplet-device-bridge.service"
SINGLE_BOX="$REPO_ROOT/scripts/lib/single-box.sh"
BRIDGE_INSTALL="$REPO_ROOT/scripts/install-device-bridge.sh"
HOSTAPD_SCRIPT="$REPO_ROOT/scripts/host/droplet-set-hostapd.sh"
GUEST_SCRIPT="$REPO_ROOT/scripts/host/droplet-set-guest-wifi.sh"
POLKIT_RULES="$REPO_ROOT/services/oled-display/50-droplet-device-bridge.rules"
FACTORY_RESET="$REPO_ROOT/scripts/factory-reset.sh"

TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

check() { # check <description> <file> <grep-E pattern>
  local desc="$1" file="$2" pattern="$3"
  if [ -f "$file" ] && grep -qE "$pattern" "$file"; then
    pass "$desc"
  else
    fail "$desc"
  fi
}

check_absent() { # check_absent <description> <file> <grep-E pattern>
  local desc="$1" file="$2" pattern="$3"
  if [ -f "$file" ] && ! grep -qE "$pattern" "$file"; then
    pass "$desc"
  else
    fail "$desc"
  fi
}

echo ""
echo "  ================================================"
echo "  WARP-843 — hostapd env-file write + path-unit re-apply"
echo "  ================================================"
echo ""

# --- 1) The path unit ---------------------------------------------------------
if [ -f "$PATH_UNIT" ]; then
  pass "droplet-openwrt-attach.path is repo-tracked"
else
  fail "droplet-openwrt-attach.path missing from scripts/host/etc-systemd-system/"
fi
check "path unit watches /etc/default/droplet-openwrt-attach (PathModified)" \
  "$PATH_UNIT" '^PathModified=/etc/default/droplet-openwrt-attach$'
check "path unit triggers the reapply relay (NOT the RemainAfterExit oneshot directly)" \
  "$PATH_UNIT" '^Unit=droplet-openwrt-attach-reapply\.service$'
check "path unit is boot-enabled (WantedBy=multi-user.target)" \
  "$PATH_UNIT" '^WantedBy=multi-user\.target$'

# --- 2) The reapply relay -------------------------------------------------------
if [ -f "$REAPPLY_UNIT" ]; then
  pass "droplet-openwrt-attach-reapply.service is repo-tracked"
else
  fail "droplet-openwrt-attach-reapply.service missing from scripts/host/etc-systemd-system/"
fi
check "relay is a plain oneshot (re-runs on every trigger)" \
  "$REAPPLY_UNIT" '^Type=oneshot$'
check_absent "relay keeps NO RemainAfterExit (it must go inactive between triggers)" \
  "$REAPPLY_UNIT" '^RemainAfterExit='
check "relay restarts droplet-openwrt-attach.service" \
  "$REAPPLY_UNIT" '^ExecStart=.*systemctl restart droplet-openwrt-attach\.service$'
check_absent "relay has no [Install] section (on-demand only, never enabled)" \
  "$REAPPLY_UNIT" '^\[Install\]$'

# --- 3) The bridge unit sandbox (WARP-843 AC2) ---------------------------------
check "bridge unit keeps ProtectSystem=strict" \
  "$BRIDGE_UNIT" '^ProtectSystem=strict$'
check "bridge unit keeps NoNewPrivileges=true" \
  "$BRIDGE_UNIT" '^NoNewPrivileges=true$'
check "bridge unit keeps RestrictSUIDSGID=true" \
  "$BRIDGE_UNIT" '^RestrictSUIDSGID=true$'
check "bridge unit adds the /etc/default carve-out (ReadWritePaths=/etc/default)" \
  "$BRIDGE_UNIT" '^ReadWritePaths=/etc/default$'
check "bridge unit pins the write target to the canonical env file" \
  "$BRIDGE_UNIT" '^Environment=DROPLET_HOSTAPD_ENV_FILE=/etc/default/droplet-openwrt-attach$'
check_absent "bridge unit no longer points writes at the StateDirectory shadow copy" \
  "$BRIDGE_UNIT" '^Environment=DROPLET_HOSTAPD_ENV_FILE=/var/lib/droplet-bridge'

# --- 4) Host scripts defer the restart when unprivileged -----------------------
check "droplet-set-hostapd.sh honors DROPLET_HOSTAPD_NO_RESTART" \
  "$HOSTAPD_SCRIPT" 'DROPLET_HOSTAPD_NO_RESTART'
check "droplet-set-hostapd.sh keys the skip on EUID" \
  "$HOSTAPD_SCRIPT" 'EUID'
check "droplet-set-guest-wifi.sh honors DROPLET_GUEST_NO_RESTART" \
  "$GUEST_SCRIPT" 'DROPLET_GUEST_NO_RESTART'
check "droplet-set-guest-wifi.sh keys the skip on EUID" \
  "$GUEST_SCRIPT" 'EUID'

# --- 5) Installer wiring --------------------------------------------------------
check "single-box.sh installs the path unit" \
  "$SINGLE_BOX" 'droplet-openwrt-attach\.path'
check "single-box.sh installs the reapply relay" \
  "$SINGLE_BOX" 'droplet-openwrt-attach-reapply\.service'
check "single-box.sh enables the path unit" \
  "$SINGLE_BOX" 'systemctl enable --now droplet-openwrt-attach\.path'
check "single-box.sh hands the env file to the bridge user (chown droplet:droplet)" \
  "$SINGLE_BOX" 'chown droplet:droplet /etc/default/droplet-openwrt-attach'
check "install-device-bridge.sh migrates the StateDirectory shadow copy (WARP-843)" \
  "$BRIDGE_INSTALL" '/var/lib/droplet-bridge/openwrt-attach\.env'
check "install-device-bridge.sh targets the canonical attach env file" \
  "$BRIDGE_INSTALL" '^ATTACH_ENV_FILE=/etc/default/droplet-openwrt-attach$'
check "install-device-bridge.sh re-asserts droplet ownership of the env file" \
  "$BRIDGE_INSTALL" 'chown droplet:droplet "\$ATTACH_ENV_FILE"'
check "install-device-bridge.sh restarts the bridge so unit/env changes apply" \
  "$BRIDGE_INSTALL" 'systemctl restart droplet-device-bridge\.service'

# --- 6) Polkit surface shrinks (no droplet restart grant left) ------------------
# Match the actual lookup line of a grant, not a mere comment mention.
check_absent "polkit rules no longer grant droplet a restart on the attach unit" \
  "$POLKIT_RULES" 'lookup\("unit"\) === "droplet-openwrt-attach\.service"'
check "polkit rules keep the storage-pool apply grant (unrelated to WARP-843)" \
  "$POLKIT_RULES" 'lookup\("unit"\) === "droplet-storage-pool-apply\.service"'

# --- 7) Factory reset returns the AP to out-of-box ------------------------------
check "factory-reset resets the customer SSID back to Droplet" \
  "$FACTORY_RESET" 'DROPLET_AP_SSID=Droplet'
check "factory-reset resets the customer PSK back to the placeholder" \
  "$FACTORY_RESET" 'DROPLET_AP_PSK=CHANGE_ME_VIA_SETUP_WIZARD'
check "factory-reset stops the path unit before touching the env file" \
  "$FACTORY_RESET" 'systemctl stop droplet-openwrt-attach\.path'

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "  $FAILURES of $TESTS checks FAILED"
  exit 1
fi
echo "  All $TESTS checks passed"
exit 0
