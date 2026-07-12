#!/usr/bin/env bash
# =============================================================================
# Regression guard — WARP-843 sandboxed hostapd env-file write + path-unit
# re-apply wiring
# =============================================================================
#
# The setup wizard's single-box "Home Wi-Fi" save failed 422: the device-bridge
# sandbox (User=droplet + ProtectSystem=strict + NoNewPrivileges) could not
# write root-owned /etc/default/droplet-openwrt-attach (mktemp EROFS), and the
# PR #551 polkit JS-rule restart route never fired (no polkitd JS-rules on the
# box). The WARP-843 fix keeps the bridge fully sandboxed AND restores the
# PR #551 security split (customer creds never enter a root EnvironmentFile):
#
#   1. The bridge writes the customer SSID/PSK into its OWN StateDirectory
#      (/var/lib/droplet-bridge/openwrt-attach.env, droplet-owned) — no
#      root-owned /etc write, so no EROFS and no /etc carve-out is needed.
#   2. /etc/default/droplet-openwrt-attach stays ROOT-owned operator/hardware
#      config and is the attach service's EnvironmentFile; the droplet-writable
#      creds file is DELIBERATELY NOT an EnvironmentFile (a droplet-writable
#      file must never inject arbitrary env into a root unit — see
#      tests/openwrt-attach-env-invariant.test.sh). Root consumes the creds via
#      the validated customer_ap_creds / customer_guest_creds whitelist parse.
#   3. droplet-set-hostapd.sh / droplet-set-guest-wifi.sh skip the privileged
#      systemctl restart when unprivileged (EUID != 0 or *_NO_RESTART=1).
#   4. Root-owned droplet-openwrt-attach.path watches THAT creds file and starts
#      the droplet-openwrt-attach-reapply.service relay (a plain oneshot — the
#      attach service itself is RemainAfterExit=yes, so a path-triggered START
#      of it would be a no-op), which restarts the attach service.
#
# This test statically pins every piece of that wiring so no single part can
# regress silently (the pieces live in several files). Runtime: < 1s,
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
check "path unit watches the droplet-writable StateDirectory creds file (PathModified)" \
  "$PATH_UNIT" '^PathModified=/var/lib/droplet-bridge/openwrt-attach\.env$'
check_absent "path unit does NOT watch root-owned /etc/default (creds live in StateDirectory)" \
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
# SECURITY: the bridge must NOT carve root-owned /etc/default (customer creds
# stay in its own StateDirectory, which systemd already makes writable), and it
# must NOT point customer writes at the file the ROOT attach service loads as
# its EnvironmentFile.
check_absent "bridge unit does NOT carve /etc/default (no droplet write into root-owned /etc)" \
  "$BRIDGE_UNIT" '^ReadWritePaths=/etc/default$'
check "bridge unit pins the write target to its own droplet-writable StateDirectory" \
  "$BRIDGE_UNIT" '^Environment=DROPLET_HOSTAPD_ENV_FILE=/var/lib/droplet-bridge/openwrt-attach\.env$'
check_absent "bridge unit does NOT point customer writes at root-owned /etc/default" \
  "$BRIDGE_UNIT" '^Environment=DROPLET_HOSTAPD_ENV_FILE=/etc/default/droplet-openwrt-attach$'

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
# SECURITY (WARP-843): /etc/default/droplet-openwrt-attach stays ROOT-owned — the
# provisioning must NOT chown it to the droplet user. It is a root
# EnvironmentFile, and a droplet-writable EnvironmentFile is an LPE vector; the
# customer creds live in the bridge StateDirectory instead.
check_absent "single-box.sh does NOT chown the attach env file to droplet (stays root-owned)" \
  "$SINGLE_BOX" 'chown[[:space:]]+droplet:droplet[[:space:]]+/etc/default/droplet-openwrt-attach'
check_absent "install-device-bridge.sh does NOT chown the attach env file to droplet" \
  "$BRIDGE_INSTALL" 'chown[[:space:]]+droplet:droplet[[:space:]]+"?\$ATTACH_ENV_FILE"?'
check_absent "install-device-bridge.sh does NOT delete/migrate the StateDirectory creds file" \
  "$BRIDGE_INSTALL" 'rm -f "\$STALE_ATTACH_ENV"'
check "install-device-bridge.sh restarts the bridge so unit/env changes apply" \
  "$BRIDGE_INSTALL" 'systemctl restart droplet-device-bridge\.service'

# --- 6) Polkit surface shrinks (no droplet restart grant left) ------------------
# Match the actual lookup line of a grant, not a mere comment mention.
check_absent "polkit rules no longer grant droplet a restart on the attach unit" \
  "$POLKIT_RULES" 'lookup\("unit"\) === "droplet-openwrt-attach\.service"'
check "polkit rules keep the storage-pool apply grant (unrelated to WARP-843)" \
  "$POLKIT_RULES" 'lookup\("unit"\) === "droplet-storage-pool-apply\.service"'

# --- 7) Factory reset returns the AP to out-of-box ------------------------------
# Customer creds live in the StateDirectory; wiping it (NOT rewriting root-owned
# /etc/default) returns the AP to the provisioning SSID + a fresh per-box PSK.
check "factory-reset wipes the StateDirectory holding the customer creds file" \
  "$FACTORY_RESET" 'rm -rf /var/lib/droplet-bridge'
check "factory-reset removes the persisted per-box AP PSK (fresh PSK next attach)" \
  "$FACTORY_RESET" 'rm -f /etc/droplet/ap-psk'
check "factory-reset stops the path unit before the StateDirectory wipe" \
  "$FACTORY_RESET" 'systemctl stop droplet-openwrt-attach\.path'
check_absent "factory-reset does NOT rewrite the root-owned /etc/default attach env in place" \
  "$FACTORY_RESET" 'sed -i.*/etc/default/droplet-openwrt-attach'

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "  $FAILURES of $TESTS checks FAILED"
  exit 1
fi
echo "  All $TESTS checks passed"
exit 0
