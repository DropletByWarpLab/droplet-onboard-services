#!/usr/bin/env bash
# =============================================================================
# WARP-1363 / WARP-1364 — droplet-openwrt-attach: AP SSID persistence for the
# matter-controller sidecar + bridged-AP structural invariants.
#
# WARP-1363: the sidecar's DROPLET_MATTER_WIFI_SSID env is written once at
# setup and goes stale on an AP rename (claim / wizard Wi-Fi save) — the
# commissionee is then told to ScanNetworks for a network that no longer
# broadcasts and answers NetworkNotFound (proven live on .87 2026-07-17).
# The attach script therefore persists the RESOLVED SSID to
# /etc/droplet/ap-ssid on every run; the sidecar re-reads it per commission.
#
# WARP-1364: bridged-AP mode (AP_BRIDGE=1, the default) trunks the main BSS
# into the host br-lan so the host-netns matter sidecar can hear Wi-Fi
# clients' operational mDNS (the ADR-022 premise the routed AP broke). These
# tests assert the load-bearing structure, not live networking.
#
# Same harness style as openwrt-attach-ap-psk.test.sh: sentinel-extract the
# persist function and run it with overridden paths — no Docker, no root.
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTACH="$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-openwrt-attach"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ======================================================="
echo "  WARP-1363/1364 — attach AP-SSID persist + bridged mode"
echo "  ======================================================="
echo ""

# --- Phase 1: sentinel structure --------------------------------------------
START_MARK="# >>> persist_ap_ssid (WARP-1363)"
END_MARK="# <<< persist_ap_ssid (WARP-1363)"

if grep -qF "$START_MARK" "$ATTACH" && grep -qF "$END_MARK" "$ATTACH"; then
  pass "persist_ap_ssid sentinel markers present"
else
  fail "persist_ap_ssid sentinel markers missing"
  echo "FAILURES=$FAILURES"; exit 1
fi

# --- Phase 2: behaviour (extracted function, overridden paths) ---------------
BLOCK="$(sed -n "/^${START_MARK}\$/,/^${END_MARK}\$/p" "$ATTACH")"
TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"' EXIT

run_persist() {
  # $1 = SSID, $2 = target file
  ( AP_SSID="$1" DROPLET_AP_SSID_FILE="$2" bash -c "$BLOCK" )
}

run_persist "WarpLab" "$TMPDIR_T/ap-ssid"
if [ "$(cat "$TMPDIR_T/ap-ssid" 2>/dev/null)" = "WarpLab" ]; then
  pass "persists the resolved SSID to the target file"
else
  fail "SSID file not written (got: '$(cat "$TMPDIR_T/ap-ssid" 2>/dev/null || echo MISSING)')"
fi

run_persist "Renamed-AP" "$TMPDIR_T/ap-ssid"
if [ "$(cat "$TMPDIR_T/ap-ssid" 2>/dev/null)" = "Renamed-AP" ]; then
  pass "overwrites on rename — every attach run refreshes the file"
else
  fail "SSID file not refreshed on rename"
fi

run_persist "Nested" "$TMPDIR_T/deep/dir/ap-ssid"
if [ "$(cat "$TMPDIR_T/deep/dir/ap-ssid" 2>/dev/null)" = "Nested" ]; then
  pass "creates the parent directory when absent (fresh box)"
else
  fail "parent directory not created"
fi

# --- Phase 3: bridged-AP structural invariants (WARP-1364) -------------------
if grep -qE '^AP_BRIDGE="\$\{DROPLET_AP_BRIDGE:-1\}"' "$ATTACH"; then
  pass "AP_BRIDGE knob present and defaults to bridged (1)"
else
  fail "AP_BRIDGE knob missing or default changed"
fi

if grep -qF 'AP_BRIDGE_CONF="bridge=br-ap"' "$ATTACH"; then
  pass "hostapd main BSS gains bridge=br-ap in bridged mode"
else
  fail "hostapd bridge=br-ap wiring missing"
fi

# The guest BSS stanza must NOT be bridged — guest isolation depends on the
# guest netdev staying routed in-container.
GUEST_BLOCK="$(sed -n '/# >>> droplet guest bss/,/HOSTAPDGUEST/p' "$ATTACH")"
if printf '%s' "$GUEST_BLOCK" | grep -q 'bridge='; then
  fail "guest BSS stanza must stay unbridged (isolation)"
else
  pass "guest BSS stanza stays unbridged (isolation intact)"
fi

# Fallback safety: every bridge-setup failure path demotes to routed mode
# rather than dying — count the demotions (br-lan missing, veth create fail,
# enslave fail).
DEMOTIONS="$(grep -c 'AP_BRIDGE=0' "$ATTACH")"
if [ "$DEMOTIONS" -ge 3 ]; then
  pass "bridge-setup failures demote to routed mode ($DEMOTIONS fallback sites)"
else
  fail "expected >=3 routed-mode fallback sites, found $DEMOTIONS"
fi

echo ""
echo "  $TESTS tests, $FAILURES failure(s)"
[ "$FAILURES" -eq 0 ]
