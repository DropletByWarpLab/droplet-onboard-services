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
# WARP-2064 extends the same re-apply pipeline with a container-lifecycle
# watcher: droplet-openwrt-watch consumes the docker events stream and fires
# the SAME reapply relay whenever the droplet-openwrt container starts (a
# no-wipe deploy that recreated the container used to strand the WG overlay
# DNAT on a dead container IP — inbound udp/51820 silently blackholed).
# Sections 8-11 pin the watcher unit, its relay wiring, its installer
# ordering in single-box.sh, and the nft heal-syntax agreement between
# droplet-openwrt-watch and droplet-openwrt-attach.
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
WATCH_UNIT="$REPO_ROOT/scripts/host/etc-systemd-system/droplet-openwrt-watch.service"
WATCH_SCRIPT="$REPO_ROOT/scripts/host/usr-local-sbin/droplet-openwrt-watch"
ATTACH_SCRIPT="$REPO_ROOT/scripts/host/usr-local-sbin/droplet-openwrt-attach"

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
echo "  WARP-843/2064 — attach re-apply wiring (path unit + container watch)"
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

# =============================================================================
# WARP-2064 — container-lifecycle watcher (droplet-openwrt-watch)
#
# The attach unit is a boot-time oneshot; a no-wipe deploy that recreates
# droplet-openwrt (`docker compose up -d` onto a new main) used to leave the
# WG overlay DNAT/masquerade/DOCKER-USER rules naming the OLD container IP —
# inbound udp/51820 silently blackholed (the WARP-1980 shape, armed by a
# routine deploy). The watcher consumes the docker events stream and fires
# the WARP-843 reapply relay on every container start; on its own (re)start
# it first heals a DNAT stranded by any event it missed while down.
# =============================================================================

# --- 8) The watcher unit --------------------------------------------------------
if [ -f "$WATCH_UNIT" ]; then
  pass "droplet-openwrt-watch.service is repo-tracked"
else
  fail "droplet-openwrt-watch.service missing from scripts/host/etc-systemd-system/"
fi
check "watch unit is a long-running events consumer (Type=simple, not a oneshot)" \
  "$WATCH_UNIT" '^Type=simple$'
check "watch unit execs the repo-tracked watcher script" \
  "$WATCH_UNIT" '^ExecStart=/usr/local/sbin/droplet-openwrt-watch$'
check "watch unit restarts always (the docker events stream dies with dockerd)" \
  "$WATCH_UNIT" '^Restart=always$'
check "watch unit hardening: families pinned to AF_UNIX (docker/systemd sockets) + AF_NETLINK (nft heal)" \
  "$WATCH_UNIT" '^RestrictAddressFamilies=AF_UNIX AF_NETLINK$'
# CORRECTNESS: PrivateNetwork must stay OFF — the overlay NAT rules live in
# the HOST netns; a private netns would make the startup-heal `nft list` read
# an empty table and the heal would be blind. The value is pinned explicitly,
# and `true` is rejected separately because systemd is last-assignment-wins:
# a hardening sweep APPENDING PrivateNetwork=true would flip the unit even
# with the false line still present above it.
check "watch unit pins PrivateNetwork=false explicitly (the heal reads the HOST netns)" \
  "$WATCH_UNIT" '^PrivateNetwork=false$'
check_absent "watch unit never sets PrivateNetwork=true (last-assignment-wins would blind the heal)" \
  "$WATCH_UNIT" '^PrivateNetwork=true$'
check "watch unit is boot-enabled (WantedBy=multi-user.target)" \
  "$WATCH_UNIT" '^WantedBy=multi-user\.target$'

# --- 9) The watcher fires the WARP-843 relay (never the attach unit directly) ---
# Same invariant the path unit is held to (section 1): the relay is the single
# serialization point, and the RemainAfterExit attach unit needs a RESTART,
# which the relay performs. A watcher that restarted the attach service itself
# would race the path-unit trigger.
check "watcher targets the WARP-843 reapply relay" \
  "$WATCH_SCRIPT" '^REAPPLY_UNIT="droplet-openwrt-attach-reapply\.service"$'
check "watcher starts the relay (systemd coalesces concurrent starts)" \
  "$WATCH_SCRIPT" 'systemctl start "\$REAPPLY_UNIT"'
check_absent "watcher does NOT restart/start the attach unit directly (that bypasses the relay)" \
  "$WATCH_SCRIPT" 'systemctl (restart|start) "?droplet-openwrt-attach\.service"?'

# --- 10) Installer wiring (WARP-2064) -------------------------------------------
check "single-box.sh installs the watcher script from the repo-tracked copy" \
  "$SINGLE_BOX" 'install -m 0755 "\$host_src/usr-local-sbin/droplet-openwrt-watch"'
check "single-box.sh installs the watcher unit from the repo-tracked copy" \
  "$SINGLE_BOX" 'etc-systemd-system/droplet-openwrt-watch\.service'
check "single-box.sh enables the watcher unit" \
  "$SINGLE_BOX" 'systemctl enable droplet-openwrt-watch\.service'
check "single-box.sh restarts the watcher (a setup.sh re-run replaces the script under a running watcher)" \
  "$SINGLE_BOX" 'systemctl restart droplet-openwrt-watch\.service'
# Ordering: the unit file must be installed BEFORE a daemon-reload, and the
# enable/restart must come AFTER that reload — enable/restart against a unit
# systemd has not (re)loaded acts on stale or missing state.
WATCH_UNIT_INSTALL_LINE=$(grep -nE 'etc-systemd-system/droplet-openwrt-watch\.service' "$SINGLE_BOX" | head -1 | cut -d: -f1 || true)
WATCH_ENABLE_LINE=$(grep -nE 'systemctl enable droplet-openwrt-watch\.service' "$SINGLE_BOX" | head -1 | cut -d: -f1 || true)
WATCH_RESTART_LINE=$(grep -nE 'systemctl restart droplet-openwrt-watch\.service' "$SINGLE_BOX" | head -1 | cut -d: -f1 || true)
# The first daemon-reload AFTER the unit install (a reload before the install
# cannot make the new unit visible to systemd).
WATCH_RELOAD_LINE=$(grep -nE 'systemctl daemon-reload' "$SINGLE_BOX" | cut -d: -f1 \
  | awk -v inst="${WATCH_UNIT_INSTALL_LINE:-0}" '$1 > inst + 0 { print; exit }' || true)
if [ -n "$WATCH_UNIT_INSTALL_LINE" ] && [ -n "$WATCH_RELOAD_LINE" ] \
   && [ -n "$WATCH_ENABLE_LINE" ] && [ -n "$WATCH_RESTART_LINE" ] \
   && [ "$WATCH_RELOAD_LINE" -lt "$WATCH_ENABLE_LINE" ] \
   && [ "$WATCH_RELOAD_LINE" -lt "$WATCH_RESTART_LINE" ]; then
  pass "single-box.sh orders: unit install -> daemon-reload -> enable/restart of the watcher"
else
  fail "watcher enable/restart must follow a daemon-reload that follows the unit install (install:${WATCH_UNIT_INSTALL_LINE:-none} reload:${WATCH_RELOAD_LINE:-none} enable:${WATCH_ENABLE_LINE:-none} restart:${WATCH_RESTART_LINE:-none})"
fi

# --- 11) Heal-syntax drift guard: watcher grep vs attach nft rule ----------------
# The startup heal greps `nft list table ip droplet_overlay_nat` output for
# `dnat to <live-ip>:51820`; the attach script installs that rule as
# `nft add rule ip droplet_overlay_nat prerouting ... dnat to ${OVERLAY_OPENWRT_IP}:51820`.
# For family-ip nat, `dnat to A:P` lists back verbatim as `dnat to A:P`, so
# source-level agreement is the correct static proxy for runtime agreement.
# The two sides live in independently-maintained scripts: if the attach drifts
# (table renamed, port changed, dnat syntax reshaped) the heal goes blind or
# fires on every watcher start; same if the watcher drifts. Extract the
# syntax from BOTH and assert agreement — each extraction must be non-empty,
# so a refactor the extraction cannot follow FAILS here instead of passing
# vacuously.
ATTACH_DNAT_LINE=$(grep -E 'nft add rule ip [A-Za-z0-9_]+ prerouting .*dnat' "$ATTACH_SCRIPT" | grep 'OVERLAY_OPENWRT_IP' | head -1 || true)
ATTACH_OVERLAY_TABLE=$(printf '%s\n' "$ATTACH_DNAT_LINE" | sed -nE 's/.*nft add rule ip ([A-Za-z0-9_]+) prerouting.*/\1/p' || true)
ATTACH_DNAT_SYNTAX=$(printf '%s\n' "$ATTACH_DNAT_LINE" | grep -oE 'dnat to [^ ]+:[0-9]+' | head -1 || true)
WATCH_HEAL_TABLE=$(grep -oE 'nft list table ip [A-Za-z0-9_]+' "$WATCH_SCRIPT" | head -1 | awk '{print $5}' || true)
WATCH_HEAL_PATTERN=$(grep -E 'grep -q "dnat to ' "$WATCH_SCRIPT" | head -1 | sed -nE 's/.*grep -q "([^"]*)".*/\1/p' || true)
# Normalize the one legitimate difference — the shell variable holding the
# container IP (${OVERLAY_OPENWRT_IP} in the attach, ${live_ip} in the
# watcher) — plus source-level quoting, and require everything else to match
# byte-for-byte.
norm_dnat() { printf '%s\n' "$1" | sed -E 's/"//g; s/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/<container-ip>/'; }

if [ -n "$ATTACH_OVERLAY_TABLE" ] && [ -n "$ATTACH_DNAT_SYNTAX" ]; then
  pass "attach: overlay DNAT extracted (table ${ATTACH_OVERLAY_TABLE}, '${ATTACH_DNAT_SYNTAX}')"
else
  fail "could not extract the overlay DNAT rule from droplet-openwrt-attach — update this guard alongside the rule"
fi
if [ -n "$WATCH_HEAL_TABLE" ] && [ -n "$WATCH_HEAL_PATTERN" ]; then
  pass "watcher: startup-heal check extracted (table ${WATCH_HEAL_TABLE}, grep '${WATCH_HEAL_PATTERN}')"
else
  fail "could not extract the startup-heal nft grep from droplet-openwrt-watch — update this guard alongside the heal"
fi
if [ -n "$ATTACH_OVERLAY_TABLE" ] && [ "$ATTACH_OVERLAY_TABLE" = "$WATCH_HEAL_TABLE" ]; then
  pass "heal reads the same nft table the attach installs into (${ATTACH_OVERLAY_TABLE})"
else
  fail "table drift: attach installs into '${ATTACH_OVERLAY_TABLE:-<none>}' but the heal lists '${WATCH_HEAL_TABLE:-<none>}' — the heal is blind"
fi
if [ -n "$ATTACH_DNAT_SYNTAX" ] && [ -n "$WATCH_HEAL_PATTERN" ] \
   && [ "$(norm_dnat "$ATTACH_DNAT_SYNTAX")" = "$(norm_dnat "$WATCH_HEAL_PATTERN")" ]; then
  pass "heal grep matches the installed DNAT syntax ($(norm_dnat "$ATTACH_DNAT_SYNTAX"))"
else
  fail "DNAT syntax drift: attach installs '${ATTACH_DNAT_SYNTAX:-<none>}' but the heal greps '${WATCH_HEAL_PATTERN:-<none>}'"
fi

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "  $FAILURES of $TESTS checks FAILED"
  exit 1
fi
echo "  All $TESTS checks passed"
exit 0
