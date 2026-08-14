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

# =============================================================================
# WARP-1385 — HOST-level WireGuard overlay NAT (the direct-punch NAT path).
#
# wg0 lives INSIDE droplet-openwrt. Before WARP-1385 the host published
# udp/51820 via docker-proxy (compose `51820:51820/udp`); docker-proxy owns the
# host port and rewrites container egress with an EPHEMERAL host source port, so
# the box's OUTBOUND wg mapping never matched the inbound path and hole-punching
# failed (verified live on .87, 2026-06-10). The compose publish is removed and
# replaced by two HOST nft rules: DNAT inbound udp/51820 -> the openwrt
# container, and a source-port-PRESERVING masquerade on egress.
#
# These rules live in a DEDICATED nft table (`droplet_overlay_nat`), NEVER
# Docker's `ip nat`, so they can't clobber Docker's NAT or the container-side
# dashboard DNAT above.
# =============================================================================

# --- 5a. Inbound DNAT: udp/51820 on the uplink -> the openwrt container ------
if grep -E "nft add rule ip droplet_overlay_nat prerouting .*udp dport 51820 dnat to" "$ATTACH" >/dev/null; then
  pass "host DNAT: inbound udp/51820 -> openwrt container (dedicated overlay table)"
else
  fail "missing host DNAT for inbound WireGuard udp/51820 (inbound punch dies)"
fi

# --- 5b. The host DNAT carries the ip-daddr hijack guard --------------------
# Same discipline as the wg0 dashboard DNAT (check 3): scope to the box's own
# uplink IP so a stray udp/51820 seen on another host iface can't be hijacked.
if grep -E "nft add rule ip droplet_overlay_nat prerouting .*ip daddr .*udp dport 51820 dnat to" "$ATTACH" >/dev/null; then
  pass "host DNAT carries an ip-daddr hijack guard"
else
  fail "host DNAT for udp/51820 lacks the ip-daddr hijack guard"
fi

# --- 5c. Egress: source-port-PRESERVING masquerade --------------------------
# This is the crux of the fix — container-sourced udp sport 51820 must egress
# with source port 51820 preserved so the upstream NAT mapping matches inbound.
if grep -E "nft add rule ip droplet_overlay_nat postrouting .*udp sport 51820 masquerade to :51820" "$ATTACH" >/dev/null; then
  pass "host egress masquerade PRESERVES source port 51820 (the hole-punch mapping)"
else
  fail "missing source-port-preserving SNAT/masquerade for udp sport 51820"
fi

# --- 5d. The overlay rules never touch Docker's `ip nat` table --------------
if ! grep -E "nft add rule ip nat (prerouting|postrouting) .*51820" "$ATTACH" >/dev/null; then
  pass "WG overlay rules stay out of Docker's ip nat table (no regression)"
else
  fail "a udp/51820 rule leaked into Docker's ip nat table"
fi

# --- 5e. The overlay table is rebuilt each attach (survives re-attach) -------
if grep -E "nft delete table ip droplet_overlay_nat" "$ATTACH" >/dev/null; then
  pass "overlay NAT table is flushed + rebuilt on each attach (idempotent, re-IP-safe)"
else
  fail "overlay NAT table is not rebuilt on attach — rules go stale on container re-IP"
fi

# --- 5f. Container IP resolved with the validated GATEWAY_IP idiom -----------
# The DNAT target must reject empty/0.0.0.0/multi-net-concat container IPs the
# same way the GATEWAY_IP DNAT resolution does (a garbage target makes the whole
# nft add fail). Assert the overlay container IP is only committed inside the
# validated branch (`OVERLAY_OPENWRT_IP="$_owip"` guarded by the octet regex +
# 0.0.0.0 reject).
if grep -E 'OVERLAY_OPENWRT_IP="\$_owip"' "$ATTACH" >/dev/null && \
   grep -E '"\$_owip" != "0\.0\.0\.0"' "$ATTACH" >/dev/null; then
  pass "overlay container IP is committed only through the validated GATEWAY_IP idiom"
else
  fail "overlay container IP not validated with the GATEWAY_IP idiom"
fi

# =============================================================================
# WARP-1980 — the FILTER half of the overlay NAT.
#
# Live on 192.168.9.250 (2026-08-13): with the WARP-1385 rules above installed
# and correct, inbound udp/51820 STILL never reached wg0. A DNAT only rewrites
# the destination; the packet then has to survive the filter FORWARD path, and
# Docker runs `-P FORWARD DROP` with its DOCKER chain ending in
#   -A DOCKER ! -i br-<id> -o br-<id> -j DROP
# whose only ACCEPTs are per-PUBLISHED-port. droplet-openwrt publishes 80/tcp
# alone, so the DNATed udp/51820 was silently dropped — no REJECT, no log line.
# Packet capture: the probe drew no ICMP port-unreachable (the DNAT consumed
# it), yet 0 packets arrived on the docker bridge. One DOCKER-USER accept and
# all 6 probes landed on the container.
#
# `docker port` publishing writes BOTH halves; doing it by hand writes only one.
#
# ⚠ This CANNOT be fixed with another nft table. In nftables a verdict is
# per-chain: an `accept` in our own base chain does not stop Docker's chain at
# the same hook from being evaluated, and only `drop` is final. The accept must
# live inside the traversal that contains the DROP — i.e. DOCKER-USER, which
# Docker documents as the user hook evaluated before its own rules.
#
# Checks 5a-5f above all pass on the broken code — full coverage on paper, a
# structurally dead feature in practice. These are the assertions that bite.
# =============================================================================

# --- 5g. A filter ACCEPT is INSERTED for the DNATed udp/51820 ---------------
# ⚠ Match the INSERT specifically (-I/-A). An earlier draft of this check
# accepted any `iptables … --dport 51820 -j ACCEPT`, which the delete-before-
# insert line (`-D DOCKER-USER … -j ACCEPT`) satisfies all on its own — so
# deleting the actual insert left the check green. Mutation testing caught it.
if grep -E "iptables -[IA] DOCKER-USER .*--dport 51820 -j ACCEPT" "$ATTACH" >/dev/null; then
  pass "filter half: an ACCEPT is inserted to admit the DNATed udp/51820"
else
  fail "no inserted filter ACCEPT for udp/51820 — Docker's FORWARD DROP eats the DNATed packet"
fi

# --- 5h. The mechanism is DOCKER-USER, never an nft forward chain -----------
# In nftables a verdict is per-chain: an `accept` in our own base chain does not
# stop Docker's chain at the same hook, and only `drop` is final. So "fixing"
# this by adding a forward hook to droplet_overlay_nat is a plausible-looking
# no-op. Assert the working mechanism AND the absence of the broken one.
if grep -E "iptables -[IA] DOCKER-USER .*--dport 51820 -j ACCEPT" "$ATTACH" >/dev/null \
   && ! grep -E "nft add (chain|rule) ip droplet_overlay_nat forward" "$ATTACH" >/dev/null; then
  pass "filter ACCEPT uses DOCKER-USER, not an nft forward chain that cannot override a DROP"
else
  fail "the udp/51820 ACCEPT must go in DOCKER-USER — an nft forward chain cannot override Docker's DROP"
fi

# --- 5i. The inserted ACCEPT is scoped, not a blanket hole ------------------
# Must pin BOTH the container as destination and the uplink as ingress, so this
# is no broader than the published port it replaces. Anchored on `-I` so the
# delete line cannot satisfy it.
if grep -E "iptables -I DOCKER-USER -i \"?\\\$OVERLAY_UPLINK_IFACE\"? -d \"?\\\$OVERLAY_OPENWRT_IP\"? -p udp --dport 51820 -j ACCEPT" "$ATTACH" >/dev/null; then
  pass "filter ACCEPT is scoped to the uplink iface AND the container IP"
else
  fail "filter ACCEPT must pin -i \$OVERLAY_UPLINK_IFACE and -d \$OVERLAY_OPENWRT_IP (no blanket hole)"
fi

# --- 5j. The ACCEPT is idempotent across re-attaches ------------------------
# The nft table is torn down + rebuilt each attach; DOCKER-USER is NOT ours to
# flush, so the rule must be deleted-if-present before insert or copies pile up
# on every container restart.
if grep -E "iptables .*-D DOCKER-USER .*51820" "$ATTACH" >/dev/null; then
  pass "prior DOCKER-USER accept is removed before re-insert (no duplicate pile-up)"
else
  fail "re-attach would stack duplicate DOCKER-USER accepts — delete before insert"
fi

# =============================================================================
# WARP-1980 — the DNAT must answer on EVERY uplink address, not just route-src.
#
# `ip route get 1.1.1.1` yields ONE src. The box holds 192.168.9.250 (static)
# AND 192.168.9.195 (DHCP lease) on the same NIC; the rule bound only .195, so
# a client dialling the static .250 got ICMP port-unreachable (captured live).
# The advertised endpoint and the answering address were different addresses.
# Keep the anti-hijack scoping — widen it to the interface's own addresses.
# =============================================================================

# --- 5k. DNAT daddr covers all uplink addresses ------------------------------
if grep -E 'nft add rule ip droplet_overlay_nat prerouting .*ip daddr \{ ?\$\{?OVERLAY_UPLINK_ADDRS' "$ATTACH" >/dev/null; then
  pass "DNAT matches every IPv4 address on the uplink iface (static + lease)"
else
  fail "DNAT still bound to the single route-src IP — the static address 503s/unreachables"
fi

# --- 5l. The address set is still a real hijack guard -----------------------
# Widening must not become `ip daddr any`: the set is built from the uplink
# interface's OWN addresses, so a stray udp/51820 on br-lan/docker0 still can't
# be hijacked into the container.
if grep -E 'OVERLAY_UPLINK_ADDRS=' "$ATTACH" >/dev/null && \
   grep -E 'ip -o -4 addr show dev "\$OVERLAY_UPLINK_IFACE"' "$ATTACH" >/dev/null; then
  pass "uplink address set is derived from the uplink iface's own addresses"
else
  fail "uplink address set must come from the uplink iface, not a wildcard"
fi

# =============================================================================
# WARP-1385 — the compose port publish is REMOVED (docker-proxy must not own
# host:51820, or the host nft rules above never see the packets and the
# ephemeral-source-port masquerade returns).
# =============================================================================
for f in "docker/docker-compose.yml" "scripts/host/docker-compose.poc.yml"; do
  if grep -E '^[[:space:]]*-[[:space:]]*"[^"]*51820/udp"' "$REPO_ROOT_REAL/$f" >/dev/null 2>&1; then
    fail "$f still publishes udp/51820 via docker-proxy (breaks the punch)"
  else
    pass "$f no longer publishes udp/51820 via docker-proxy"
  fi
done

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "  ${FAILURES}/${TESTS} checks FAILED"
  exit 1
fi
echo "  All ${TESTS} checks passed."
exit 0
