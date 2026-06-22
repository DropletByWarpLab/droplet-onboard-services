#!/usr/bin/env bash
# =============================================================================
# WARP-869 — unit tests for scripts/host/usr-local-sbin/droplet-wifi-watchdog
#
# Field failure: the Wi-Fi card's PCI function dies silently mid-uptime — the
# device stays BOUND to iwlwifi but its phy + netdev vanish (Bluetooth half
# keeps working, so nothing looks wrong) until a manual PCI remove + rescan.
# The watchdog automates that recovery. These tests drive it against a FAKE
# sysfs tree + a stub systemctl, so no root, PCI hardware, or systemd needed.
# Mirrors tests/openwrt-attach-iface-detect.test.sh's harness conventions.
#
# Runtime: < 15 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
WATCHDOG="$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-wifi-watchdog"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-869 — droplet-wifi-watchdog"
echo "  ================================================"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Fake PCI device factory: class file + optional driver symlink + optional
# netdev/phy presence, mirroring the real sysfs layout the watchdog reads.
mk_dev() { # <name> <class> [bound] [alive]
  local d="$WORK/pci/$1"
  mkdir -p "$d"
  printf '%s\n' "$2" > "$d/class"
  [ "${3:-}" = "bound" ] && ln -s /dev/null "$d/driver"
  if [ "${4:-}" = "netdev" ]; then mkdir -p "$d/net/wlan0"; fi
  if [ "${4:-}" = "phy" ]; then mkdir -p "$d/ieee80211/phy0"; fi
  return 0
}

# systemctl stub — logs invocations; `cat` always finds the unit.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/systemctl" <<EOF
#!/bin/sh
printf 'systemctl %s\n' "\$*" >> "$WORK/systemctl.log"
exit 0
EOF
chmod +x "$WORK/bin/systemctl"

run_watchdog() { # extra env via leading VAR=val args
  env PATH="$WORK/bin:$PATH" \
      DROPLET_WIFI_SYS_PCI="$WORK/pci" \
      DROPLET_WIFI_RESCAN="$WORK/rescan" \
      DROPLET_WIFI_SETTLE_S=0 \
      DROPLET_WIFI_WAIT_S=0 \
      DROPLET_WIFI_AP_IN_CONTAINER=0 \
      "$@" \
      bash "$WATCHDOG" 2>&1
}

# --- 1. healthy Wi-Fi device (netdev present) → untouched -------------------
rm -rf "$WORK/pci" "$WORK/rescan" "$WORK/systemctl.log"
mk_dev "0000:0e:00.0" "0x028000" bound netdev
out="$(run_watchdog)"
if [ ! -e "$WORK/pci/0000:0e:00.0/remove" ] && [ ! -e "$WORK/rescan" ]; then
  pass "healthy device is left alone (no remove, no rescan)"
else
  fail "healthy device was touched: $out"
fi

# --- 2. phy-only device (no netdev yet) → still considered alive ------------
rm -rf "$WORK/pci" "$WORK/rescan"
mk_dev "0000:0e:00.0" "0x028000" bound phy
run_watchdog >/dev/null
if [ ! -e "$WORK/pci/0000:0e:00.0/remove" ]; then
  pass "phy-without-netdev device is treated as alive"
else
  fail "phy-only device was wrongly revived"
fi

# --- 3. wedged device (bound, no phy/netdev) → remove + rescan --------------
rm -rf "$WORK/pci" "$WORK/rescan" "$WORK/systemctl.log"
mk_dev "0000:0e:00.0" "0x028000" bound
out="$(run_watchdog)"
if [ "$(cat "$WORK/pci/0000:0e:00.0/remove" 2>/dev/null)" = "1" ] \
   && [ "$(cat "$WORK/rescan" 2>/dev/null)" = "1" ]; then
  pass "wedged device gets PCI remove + rescan"
else
  fail "wedged device not revived: $out"
fi
if ! grep -q "restart" "$WORK/systemctl.log" 2>/dev/null; then
  pass "attach NOT restarted when the device never came back"
else
  fail "attach restarted despite failed revival"
fi

# --- 3b. wedge signature BUT AP radio is in the container → NOT revived ------
# On the single-box the AP phy is moved into the droplet-openwrt netns, so the
# host PCI device looks exactly wedged (driver bound, no phy/netdev). The netns
# guard must leave it alone — a PCI reset would rip the radio out of the
# container and tear the live AP down (the regression this fix prevents).
rm -rf "$WORK/pci" "$WORK/rescan" "$WORK/systemctl.log"
mk_dev "0000:0e:00.0" "0x028000" bound
out="$(run_watchdog DROPLET_WIFI_AP_IN_CONTAINER=1)"
if [ ! -e "$WORK/pci/0000:0e:00.0/remove" ] && [ ! -e "$WORK/rescan" ]; then
  pass "phy-in-container radio is NOT revived (no remove, no rescan)"
else
  fail "container-resident AP radio was wrongly revived: $out"
fi
if [ ! -s "$WORK/systemctl.log" ]; then
  pass "attach NOT restarted for a container-resident radio"
else
  fail "attach restarted for a container-resident radio: $(cat "$WORK/systemctl.log" 2>/dev/null)"
fi

# --- 4. unbound device → untouched (operator may have unbound it) -----------
rm -rf "$WORK/pci" "$WORK/rescan"
mk_dev "0000:0e:00.0" "0x028000"
run_watchdog >/dev/null
if [ ! -e "$WORK/pci/0000:0e:00.0/remove" ]; then
  pass "unbound device is left alone"
else
  fail "unbound device was wrongly revived"
fi

# --- 5. wired NIC (class 0x020000) → never matches ---------------------------
rm -rf "$WORK/pci" "$WORK/rescan"
mk_dev "0000:09:00.0" "0x020000" bound
run_watchdog >/dev/null
if [ ! -e "$WORK/pci/0000:09:00.0/remove" ]; then
  pass "ethernet-class device is ignored"
else
  fail "ethernet NIC was wrongly revived"
fi

# --- 6. successful revival → attach unit restarted ---------------------------
# The netdev "reappears" mid-wait: run with a wait window and create the
# netdev from a racing background helper after the remove write lands.
rm -rf "$WORK/pci" "$WORK/rescan" "$WORK/systemctl.log"
mk_dev "0000:0e:00.0" "0x028000" bound
(
  # Wait for the remove write, then simulate the rescan bringing it back.
  for _ in $(seq 1 50); do
    [ -e "$WORK/pci/0000:0e:00.0/remove" ] && break
    sleep 0.1
  done
  sleep 0.5
  mkdir -p "$WORK/pci/0000:0e:00.0/net/wlp14s0"
) &
helper=$!
out="$(run_watchdog DROPLET_WIFI_WAIT_S=10)"
wait "$helper" || true
if printf '%s' "$out" | grep -q "revived"; then
  pass "revival is detected when the netdev returns"
else
  fail "revival not detected: $out"
fi
if grep -q "restart droplet-openwrt-attach.service" "$WORK/systemctl.log" 2>/dev/null; then
  pass "attach unit restarted after a successful revival"
else
  fail "attach unit was not restarted after revival: $(cat "$WORK/systemctl.log" 2>/dev/null)"
fi

# --- 7. DROPLET_WIFI_ATTACH_UNIT="" disables the restart ---------------------
rm -rf "$WORK/pci" "$WORK/rescan" "$WORK/systemctl.log"
mk_dev "0000:0e:00.0" "0x028000" bound
(
  for _ in $(seq 1 50); do
    [ -e "$WORK/pci/0000:0e:00.0/remove" ] && break
    sleep 0.1
  done
  mkdir -p "$WORK/pci/0000:0e:00.0/net/wlp14s0"
) &
helper=$!
run_watchdog DROPLET_WIFI_WAIT_S=10 DROPLET_WIFI_ATTACH_UNIT= >/dev/null
wait "$helper" || true
if [ ! -s "$WORK/systemctl.log" ]; then
  pass "empty DROPLET_WIFI_ATTACH_UNIT suppresses the attach restart"
else
  fail "attach restart ran despite empty unit override"
fi

echo ""
echo "  ------------------------------------------------"
if [ "$FAILURES" -gt 0 ]; then
  echo "  $FAILURES of $TESTS tests FAILED"
  exit 1
fi
echo "  All $TESTS tests passed"
exit 0
