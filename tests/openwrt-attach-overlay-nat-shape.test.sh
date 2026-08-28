#!/usr/bin/env bash
# =============================================================================
# WARP-2183 — the host WG overlay NAT must NOT be installed on the edge-router
# shape, and a stale table from a previous container-shape attach must be torn
# down when the box moves behind a real router.
#
# WHY (this failure is silent and it steals a working tunnel):
#   Every rule in the overlay_wg_host_nat block exists to compensate for wg0
#   living inside droplet-openwrt behind docker-proxy. When WireGuard terminates
#   on the RB5009 instead, rule (a) — "DNAT inbound udp/51820 on the uplink to
#   the container" — hijacks punch traffic on the box's uplink and redirects it
#   into a container whose wg0 holds no peers. Nothing errors: the DNAT consumes
#   the packet, so the client does not even get an ICMP port-unreachable.
#
# THE SHAPE SIGNAL is the one WARP-1980 established: a NON-loopback OPENWRT_HOST
# means an operator pointed this box at a real external router. This test also
# pins the case list against scripts/lib/single-box.sh so the two cannot drift.
#
# Static + behavioral; needs no docker, no root, no network.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTACH="$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-openwrt-attach"
SINGLE_BOX_LIB="$REPO_ROOT_REAL/scripts/lib/single-box.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-2183 — overlay NAT is container-shape only"
echo "  ================================================"
echo ""

[ -f "$ATTACH" ] || { printf 'FATAL: attach script missing at %s\n' "$ATTACH"; exit 1; }

# --- Phase 1: static structure ----------------------------------------------
echo "--- Phase 1: gate is present and sentinel-delimited ---"

START_MARK="# >>> overlay_wg_host_nat (WARP-1385)"
END_MARK="# <<< overlay_wg_host_nat (WARP-1385)"

if grep -qF "$START_MARK" "$ATTACH" && grep -qF "$END_MARK" "$ATTACH"; then
  pass "overlay_wg_host_nat block still sentinel-delimited"
else
  fail "sentinels missing — the block moved or was renamed"
fi

if grep -q 'overlay_wg_host_nat_applies()' "$ATTACH"; then
  pass "shape gate function present"
else
  fail "overlay_wg_host_nat_applies() missing — the NAT installs unconditionally again"
fi

# The gate must run BEFORE any nft rule is added, or it gates nothing.
gate_line=$(grep -n 'if ! overlay_wg_host_nat_applies; then' "$ATTACH" | head -1 | cut -d: -f1)
first_rule_line=$(grep -n 'nft add table ip droplet_overlay_nat' "$ATTACH" | head -1 | cut -d: -f1)
if [ -n "$gate_line" ] && [ -n "$first_rule_line" ] && [ "$gate_line" -lt "$first_rule_line" ]; then
  pass "gate is evaluated before the first nft rule (line $gate_line < $first_rule_line)"
else
  fail "gate does not precede rule installation (gate='$gate_line' rule='$first_rule_line')"
fi

# --- Phase 2: the case list may not drift from the WARP-1980 guard -----------
echo ""
echo "--- Phase 2: shape signal stays in step with single-box.sh ---"

if [ -f "$SINGLE_BOX_LIB" ]; then
  # Both must treat exactly ''|127.0.0.1|localhost|::1 as "bundled container".
  attach_case=$(grep -A2 'overlay_wg_host_nat_applies()' -A12 "$ATTACH" \
    | grep -oE "''\|127\.0\.0\.1\|localhost\|::1" | head -1)
  lib_case=$(grep -oE "''\|127\.0\.0\.1\|localhost\|::1" "$SINGLE_BOX_LIB" | head -1)
  if [ -n "$attach_case" ] && [ "$attach_case" = "$lib_case" ]; then
    pass "loopback case list matches configure_single_box_env() exactly"
  else
    fail "case lists drifted — attach='$attach_case' single-box.sh='$lib_case'"
  fi
else
  fail "scripts/lib/single-box.sh not found — cannot pin the shape signal"
fi

# --- Phase 3: behavioral ------------------------------------------------------
echo ""
echo "--- Phase 3: the gate decides correctly ---"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extract just the function so we can call it without running the whole script.
sed -n '/^overlay_wg_host_nat_applies() {$/,/^}$/p' "$ATTACH" > "$WORK/gate.sh"
if [ ! -s "$WORK/gate.sh" ]; then
  fail "could not extract overlay_wg_host_nat_applies() — test cannot run"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS passed"; exit 1
fi

# `applies` = the box terminates wg0 itself (container shape) = install the NAT.
check() {
  local desc="$1" want="$2" host="$3" envfile="${4:-/nonexistent}"
  local got
  (
    set +u
    OPENWRT_HOST="$host"
    REPO_ENV_FILE="$envfile"
    DROPLET_OVERLAY_NAT_ENV_FILE="$envfile"
    OVERLAY_NAT_ENV_FILE="${DROPLET_OVERLAY_NAT_ENV_FILE:-${REPO_ENV_FILE:-/home/droplet/edge-platform/.env}}"
    . "$WORK/gate.sh"
    if overlay_wg_host_nat_applies; then exit 0; else exit 1; fi
  )
  got=$?
  if [ "$got" -eq "$want" ]; then
    pass "$desc"
  else
    fail "$desc (wanted rc=$want, got rc=$got)"
  fi
}

check "unset OPENWRT_HOST -> container shape, install NAT"        0 ""
check "127.0.0.1 -> container shape, install NAT"                 0 "127.0.0.1"
check "localhost -> container shape, install NAT"                 0 "localhost"
check "::1 -> container shape, install NAT"                       0 "::1"
check "192.168.9.1 (RB5009) -> edge shape, SKIP NAT"              1 "192.168.9.1"
check "a hostname -> edge shape, SKIP NAT"                        1 "droplet-edge.lan"
check "192.168.50.1 (legacy external router) -> edge shape, SKIP" 1 "192.168.50.1"

# .env fallback: OPENWRT_HOST unset in the environment must still be read from
# the repo .env, the same way resolve_public_fqdn does it.
printf 'DROPLET_PUBLIC_FQDN=x.droplet-us.com\nOPENWRT_HOST=192.168.9.1\n' > "$WORK/.env"
check "unset env but .env names the router -> edge shape, SKIP"   1 "" "$WORK/.env"
printf 'OPENWRT_HOST=127.0.0.1\n' > "$WORK/.env.loop"
check "unset env but .env says loopback -> container shape"       0 "" "$WORK/.env.loop"

# A CRLF .env (Windows-authored) must not defeat the match.
printf 'OPENWRT_HOST=192.168.9.1\r\n' > "$WORK/.env.crlf"
check "CRLF .env still detected as the edge shape"                1 "" "$WORK/.env.crlf"

echo ""
echo "  $((TESTS - FAILURES))/$TESTS passed"
[ "$FAILURES" -eq 0 ] || exit 1
