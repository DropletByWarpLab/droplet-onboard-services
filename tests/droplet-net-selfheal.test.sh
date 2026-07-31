#!/usr/bin/env bash
# =============================================================================
# WARP-1680 — unit tests for scripts/host/usr-local-sbin/droplet-net-selfheal
#
# The boot-time backstop that recovers the box when a NIC rename (or a dead
# uplink) leaves netplan configuring a device that does not exist and the box
# with NO IPv4 on any interface — the failure that twice required a physical
# console trip.
#
# These tests drive the script against a FAKE /sys/class/net tree and stub
# `ip` / `logger` / `dhcpcd` binaries on PATH, so they need no root, no
# hardware, and never touch the host's real network. Mirrors
# tests/droplet-watchdog.test.sh's harness conventions.
#
# Runtime: < 15 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
SELFHEAL="$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-net-selfheal"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-1680 — droplet-net-selfheal"
echo "  ================================================"
echo ""

if [ ! -f "$SELFHEAL" ]; then
  fail "scripts/host/usr-local-sbin/droplet-net-selfheal does not exist"
  echo ""
  echo "  1 of 1 tests FAILED"
  exit 1
fi

# --- Harness ----------------------------------------------------------------
# Each case builds a fake sysfs + a stub `ip` whose behaviour is driven by
# files in $STATE, so we can assert exactly which commands the script issued.

setup_case() {
  CASE_DIR="$(mktemp -d)"
  SYSNET="$CASE_DIR/sys/class/net"
  STATE="$CASE_DIR/state"
  BIN="$CASE_DIR/bin"
  mkdir -p "$SYSNET" "$STATE" "$BIN"
  : > "$STATE/ip-calls"
  : > "$STATE/global-ipv4"   # non-empty => `ip addr show scope global` yields a line

  # Stub `ip`: records every invocation, answers the two queries the script
  # makes, and lets a case flip "has a global IPv4" partway through.
  cat > "$BIN/ip" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STATE/ip-calls"
# `ip -4 -o addr show dev X scope global`
if [[ "$*" == *"-o addr show"* && "$*" == *"scope global"* ]]; then
  if [ -s "$STATE/global-ipv4" ]; then
    dev="${*##*show dev }"; dev="${dev%% *}"
    echo "1: $dev    inet 192.168.9.195/24 scope global $dev"
  fi
  exit 0
fi
# `ip addr add ... dev X` — record success and mark the box addressed.
if [[ "$*" == *"addr add"* ]]; then
  echo present > "$STATE/global-ipv4"
  exit 0
fi
exit 0
STUB

  cat > "$BIN/logger" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  chmod +x "$BIN/ip" "$BIN/logger"
  export STATE
}

teardown_case() { rm -rf "$CASE_DIR"; }

# Create a fake NIC. kind=wired|wireless|virtual, carrier=0|1
make_nic() {
  local name="$1" kind="$2" carrier="${3:-1}"
  mkdir -p "$SYSNET/$name"
  [ "$kind" = "virtual" ] || mkdir -p "$SYSNET/$name/device"
  [ "$kind" = "wireless" ] && mkdir -p "$SYSNET/$name/wireless"
  echo "$carrier" > "$SYSNET/$name/carrier"
}

run_selfheal() {
  # The script hardcodes /sys/class/net, so run it through a rewritten copy
  # pointed at the fake tree. Everything else (logic, ordering) is verbatim.
  sed "s#/sys/class/net#$SYSNET#g" "$SELFHEAL" > "$CASE_DIR/selfheal.sh"
  chmod +x "$CASE_DIR/selfheal.sh"
  # `|| echo $?` is mandatory: this file runs under `set -e`, and the
  # dead-link case EXPECTS a non-zero exit — without the guard the harness
  # would abort before it could assert on it.
  PATH="$BIN:$PATH" STATE="$STATE" bash "$CASE_DIR/selfheal.sh" > "$CASE_DIR/out" 2>&1 \
    && echo 0 > "$CASE_DIR/rc" || echo $? > "$CASE_DIR/rc"
  return 0
}

rc() { cat "$CASE_DIR/rc"; }
out() { cat "$CASE_DIR/out"; }
ip_calls() { cat "$STATE/ip-calls"; }

# --- Case 1: healthy box is a no-op ----------------------------------------
setup_case
make_nic enp8s0 wired 1
echo present > "$STATE/global-ipv4"
run_selfheal
if [ "$(rc)" = "0" ] && out | grep -q "healthy"; then
  pass "healthy box: exits 0 and reports nothing to do"
else
  fail "healthy box: expected a clean no-op, got rc=$(rc) / $(out | head -1)"
fi
if ! ip_calls | grep -q "link set"; then
  pass "healthy box: never touches link state"
else
  fail "healthy box: MUTATED link state on a working box"
fi
teardown_case

# --- Case 2: renamed NIC with carrier, no address -> recovers --------------
setup_case
make_nic enp8s0 wired 1      # the post-rename NIC netplan does not know about
run_selfheal
if [ "$(rc)" = "0" ]; then
  pass "renamed NIC: recovers (exit 0)"
else
  fail "renamed NIC: expected recovery, got rc=$(rc) / $(out | tail -1)"
fi
if ip_calls | grep -q "link set enp8s0 up"; then
  pass "renamed NIC: brings the interface up"
else
  fail "renamed NIC: never issued 'link set enp8s0 up'"
fi
if ip_calls | grep -q "addr add 192.168.9.250/24 dev enp8s0"; then
  pass "renamed NIC: pins the edge-router fallback address"
else
  fail "renamed NIC: never pinned the fallback address"
fi
teardown_case

# --- Case 3: no carrier anywhere -> fails loudly, pins nothing --------------
setup_case
make_nic enp8s0 wired 0
run_selfheal
if [ "$(rc)" = "1" ] && out | grep -q "no wired NIC has carrier"; then
  pass "dead link: exits non-zero and names the physical cause"
else
  fail "dead link: expected rc=1 + a carrier message, got rc=$(rc) / $(out | tail -1)"
fi
if ! ip_calls | grep -q "addr add"; then
  pass "dead link: does not pin an address onto a cable-less NIC"
else
  fail "dead link: pinned an address despite no carrier"
fi
teardown_case

# --- Case 4: link-local only is NOT healthy --------------------------------
# A 169.254 address means DHCP FAILED. Treating it as healthy would strand the
# box exactly when recovery is needed, so the script must ignore it.
setup_case
make_nic enp8s0 wired 1
cat > "$BIN/ip" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STATE/ip-calls"
if [[ "$*" == *"-o addr show"* && "$*" == *"scope global"* ]]; then
  # Only an autoconfiguration address exists.
  echo "1: enp8s0    inet 169.254.7.9/16 scope global enp8s0"
  exit 0
fi
exit 0
STUB
chmod +x "$BIN/ip"
run_selfheal
if out | grep -q "starting recovery"; then
  pass "link-local only: treated as unhealthy and recovery runs"
else
  fail "link-local only: wrongly treated 169.254.x as a usable address"
fi
teardown_case

# --- Case 5: virtual/docker plumbing is ignored ----------------------------
setup_case
make_nic docker0 virtual 1
make_nic veth1234 virtual 1
make_nic br-lan virtual 1
make_nic wlp7s0 wireless 1     # wireless is not a WIRED candidate
make_nic enp8s0 wired 1
run_selfheal
if ! ip_calls | grep -qE "link set (docker0|veth1234|br-lan|wlp7s0) up"; then
  pass "ignores docker/veth/bridge plumbing and the radio"
else
  fail "touched virtual plumbing or the radio: $(ip_calls | grep 'link set' | tr '\n' ' ')"
fi
if ip_calls | grep -q "link set enp8s0 up"; then
  pass "still acts on the real wired NIC alongside the noise"
else
  fail "missed the real wired NIC when plumbing was present"
fi
teardown_case

# --- Summary ----------------------------------------------------------------
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "  All $TESTS tests passed"
  exit 0
fi
echo "  $FAILURES of $TESTS tests FAILED"
exit 1
