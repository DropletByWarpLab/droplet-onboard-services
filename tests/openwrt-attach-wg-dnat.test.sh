#!/usr/bin/env bash
# =============================================================================
# Unit tests for the WireGuard dashboard DNAT in
# scripts/host/usr-local-sbin/droplet-openwrt-attach.
#
# Live root cause on the .87 single-box (2026-06-10): a remote-access phone
# with a healthy tunnel could never reach the dashboard. The peer .conf
# (vpn.service.ts) advertises AllowedIPs = 192.168.20.0/24 + tunnel subnet and
# DNS = 192.168.20.1, so the client's only dashboard route is
# https://192.168.20.1 — but the attach script's DNAT rules were scoped to
# `iifname "$AP_IFACE"` (the Wi-Fi radio) only. VPN traffic enters on wg0, the
# DNAT never matched, and the request died inside the OpenWrt container.
#
# These are static assertions over the attach script (mirrors the grep-style
# checks in openwrt-attach-ap-bringup.test.sh) — no Docker, container, or
# Wi-Fi card needed.
#
# Runtime: < 1 second.
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
echo "  ================================================"
echo "  droplet-openwrt-attach — WireGuard dashboard DNAT"
echo "  ================================================"
echo ""

# --- 1. wg0 DNAT rules exist for both dashboard ports -----------------------
for port in 443 80; do
  if grep -E "nft add rule ip nat prerouting iifname \\\\\"wg0\\\\\" ip daddr 192\.168\.20\.1 tcp dport ${port}\s+dnat to \\\$\{GATEWAY_IP\}:${port}" "$ATTACH" >/dev/null; then
    pass "wg0 ingress DNATs 192.168.20.1:${port} to the gateway container"
  else
    fail "missing wg0 DNAT rule for port ${port} (VPN clients can't reach the dashboard)"
  fi
done

# --- 2. AP-iface rules are still present (no regression) --------------------
for port in 443 80; do
  if grep -E "nft add rule ip nat prerouting iifname \\\\\"\\\$AP_IFACE\\\\\" ip daddr 192\.168\.20\.1 tcp dport ${port}" "$ATTACH" >/dev/null; then
    pass "AP-iface DNAT rule for port ${port} still present"
  else
    fail "AP-iface DNAT rule for port ${port} went missing"
  fi
done

# --- 3. The daddr hijack guard applies to every DNAT rule -------------------
# Every dashboard DNAT must carry the `ip daddr 192.168.20.1` predicate, or
# clients browsing the open internet get hijacked to the dashboard (the
# captive-portal-lookalike bug the AP rules already guard against).
UNGUARDED=$(grep -cE "nft add rule ip nat prerouting iifname.*dnat to" "$ATTACH" || true)
GUARDED=$(grep -cE "nft add rule ip nat prerouting iifname.*ip daddr 192\.168\.20\.1.*dnat to" "$ATTACH" || true)
if [ "$UNGUARDED" -eq "$GUARDED" ] && [ "$GUARDED" -ge 4 ]; then
  pass "all ${GUARDED} dashboard DNAT rules carry the ip-daddr hijack guard"
else
  fail "found $((UNGUARDED - GUARDED)) DNAT rule(s) without the ip-daddr guard"
fi

# --- 4. wg0 rules sit after the flush loop, so re-attach re-adds them -------
FLUSH_LINE=$(grep -n "nft delete rule ip nat prerouting handle" "$ATTACH" | head -1 | cut -d: -f1)
WG_LINE=$(grep -n "iifname \\\\\"wg0\\\\\" ip daddr 192.168.20.1 tcp dport 443" "$ATTACH" | head -1 | cut -d: -f1)
if [ -n "$FLUSH_LINE" ] && [ -n "$WG_LINE" ] && [ "$WG_LINE" -gt "$FLUSH_LINE" ]; then
  pass "wg0 DNAT rules are added after the stale-rule flush (survive re-attach)"
else
  fail "wg0 DNAT rules must come after the prerouting flush loop"
fi

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "  ${FAILURES}/${TESTS} checks FAILED"
  exit 1
fi
echo "  All ${TESTS} checks passed."
exit 0
