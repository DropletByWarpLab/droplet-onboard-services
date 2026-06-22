#!/usr/bin/env bash
# =============================================================================
# Unit tests for the GUEST Wi-Fi firewall-zone provisioning inside
# scripts/host/usr-local-sbin/droplet-openwrt-attach (guest_firewall_zone).
#
# The single-box guest network is a second hostapd BSS on the same radio with
# its own subnet (192.168.30.0/24). For guest clients to get a lease AND reach
# the internet — but NOTHING else — the attach stands up an isolated, default-
# deny `guest` fw4 zone:
#   - input=REJECT, opened ONLY for DHCP (:67-68) + DNS (:53) via explicit rules
#     (so guests can lease + resolve, but cannot reach the router/dashboard),
#   - forwarding guest -> lan(uplink) so egress chains onward,
#   - a NAT MASQUERADE scoped to 192.168.30.0/24 so guests reach the internet,
#   - and it TEARS the zone down when guest Wi-Fi is disabled.
# Client-to-client isolation is enforced at hostapd (ap_isolate=1), not here.
#
# Mirrors tests/openwrt-attach-firewall.test.sh: extract the sentinel-delimited
# POSIX function and run it against a stub `uci`, asserting the exact zone/rule/
# forwarding/masq config, idempotence (no dupes), and teardown.
#
# Runtime: < 5 seconds. No Docker / OpenWrt container required.
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
echo "  droplet-openwrt-attach — guest Wi-Fi firewall zone"
echo "  ================================================"
echo ""

# --- Static structure --------------------------------------------------------
echo "--- Phase 1: function present + sentinel-delimited ---"

if [ -f "$ATTACH" ]; then
  pass "attach script exists"
else
  fail "attach script missing at $ATTACH"
  echo "FAILURES=$FAILURES"; exit 1
fi

START_MARK="# >>> guest_firewall_zone (guest Wi-Fi)"
END_MARK="# <<< guest_firewall_zone (guest Wi-Fi)"

if grep -qF "$START_MARK" "$ATTACH" && grep -qF "$END_MARK" "$ATTACH"; then
  pass "guest_firewall_zone sentinel markers present"
else
  fail "guest_firewall_zone sentinel markers missing"
fi

if grep -qE "^[[:space:]]*guest_firewall_zone\b" "$ATTACH"; then
  pass "guest_firewall_zone is invoked in the attach body"
else
  fail "guest_firewall_zone is never called in the attach body"
fi

# Guardrail: must not blanket-open input. Guest input is default-deny; only the
# two explicit DHCP/DNS rules open it.
if grep -qiE "firewall\.@defaults\[0\]\.input=ACCEPT|policy[[:space:]]+accept" "$ATTACH"; then
  fail "attach blanket-opens input — must stay default-drop"
else
  pass "default-drop input posture preserved (no blanket open)"
fi

# --- Behavioral: extract + run against a stub uci ----------------------------
echo "--- Phase 2: behavioral run with stub uci (guest ENABLED) ---"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sed -n "/$(printf '%s' "$START_MARK" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$END_MARK" | sed 's/[][\\.*^$/]/\\&/g')/p" \
  "$ATTACH" > "$WORK/func.sh"

if [ -s "$WORK/func.sh" ]; then
  pass "extracted guest_firewall_zone function body"
else
  fail "could not extract function body — skipping behavioral asserts"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS passed"; echo "FAILURES=$FAILURES"
  [ "$FAILURES" -eq 0 ] || exit 1
  exit 0
fi

mkdir -p "$WORK/bin"
# Stub `uci`. Same subset as the AP firewall test, but `delete` removes a named
# section AND its dotted options (^key(=|.|$)) so the teardown phase can verify
# the guest sections are gone.
cat > "$WORK/bin/uci" <<'UCISTUB'
#!/usr/bin/env bash
STATE="${UCI_STATE:?UCI_STATE unset}"
touch "$STATE"
[ "$1" = "-q" ] && shift
cmd="$1"; shift || true
case "$cmd" in
  show)
    if [ -n "${1:-}" ]; then base="$1"; else base=""; fi
    grep -E "^${base}" "$STATE" 2>/dev/null | grep -v '^__SECTION ' | \
      sed -E "s/^([^=]+)=(.*)$/\1='\2'/" || true
    ;;
  get)
    key="$1"
    line="$(grep -E "^$key=" "$STATE" | tail -1 || true)"
    [ -n "$line" ] || exit 1
    printf '%s\n' "${line#*=}"
    ;;
  set)
    key="${1%%=*}"; val="${1#*=}"
    grep -vE "^$key=" "$STATE" > "$STATE.tmp" 2>/dev/null || true
    mv "$STATE.tmp" "$STATE"
    printf '%s=%s\n' "$key" "$val" >> "$STATE"
    ;;
  add)
    cfg="$1"; typ="$2"
    idx="$(grep -cE "^__SECTION ${cfg}\.${typ}\b" "$STATE" || true)"
    name="${cfg}.@${typ}[${idx}]"
    printf '__SECTION %s.%s %s\n' "$cfg" "$typ" "$name" >> "$STATE"
    printf '%s\n' "$name"
    ;;
  add_list)
    printf '%s\n' "$1" >> "$STATE"
    ;;
  delete)
    key="$1"
    # Section delete removes the section line AND every dotted option under it.
    grep -vE "^${key}(=|\.|$)" "$STATE" > "$STATE.tmp" 2>/dev/null || true
    mv "$STATE.tmp" "$STATE"
    ;;
  del_list)
    key="${1%%=*}"
    grep -vE "^${key}(=|$)" "$STATE" > "$STATE.tmp" 2>/dev/null || true
    mv "$STATE.tmp" "$STATE"
    ;;
  commit)
    printf 'COMMIT %s\n' "${1:-all}" >> "$STATE.events"
    ;;
  *) : ;;
esac
exit 0
UCISTUB
chmod +x "$WORK/bin/uci"

for b in fw4 nft; do
  cat > "$WORK/bin/$b" <<EOF
#!/usr/bin/env bash
echo "$b \$*" >> "\${UCI_STATE}.events"
exit 0
EOF
  chmod +x "$WORK/bin/$b"
done

seed_state() {
  local state="$1"
  {
    printf '__SECTION firewall.zone firewall.lan_zone\n'
    printf 'firewall.lan_zone.name=lan\n'
    printf 'firewall.lan_zone.input=ACCEPT\n'
    printf 'firewall.lan_zone.output=ACCEPT\n'
    printf 'firewall.lan_zone.forward=ACCEPT\n'
  } > "$state"
  : > "$state.events"
}

run_func() {
  local state="$1" enabled="$2"
  UCI_STATE="$state" \
  PATH="$WORK/bin:$PATH" \
  GUEST_IFACE="wlp14s0_g" \
  GUEST_ENABLED="$enabled" \
  bash -c '
    set -e
    # shellcheck disable=SC1090
    . "'"$WORK"'/func.sh"
    guest_firewall_zone
  '
}

STATE1="$WORK/state1"
seed_state "$STATE1"
if run_func "$STATE1" 1 > "$WORK/run1.log" 2>&1; then
  pass "guest_firewall_zone ran (enabled, first invocation) without error"
else
  fail "guest_firewall_zone errored on first run:"
  sed 's/^/      /' "$WORK/run1.log" >&2 || true
fi

if grep -qE '\.name=guest$' "$STATE1"; then
  pass "guest firewall zone named 'guest' created"
else
  fail "no firewall zone named 'guest' in resulting config"
fi

# input=REJECT on the guest zone (default-deny — the brief: input opened ONLY
# for DHCP/DNS, never blanket ACCEPT like the AP zone).
if grep -qE '^firewall\.droplet_guest\.input=REJECT$' "$STATE1"; then
  pass "guest zone input=REJECT (default-deny; DHCP/DNS opened via explicit rules)"
else
  fail "guest zone input is not REJECT — guests could reach the router/dashboard"
fi

if grep -qE '\.(device|network)=wlp14s0_g$' "$STATE1"; then
  pass "guest zone covers the guest BSS iface (wlp14s0_g)"
else
  fail "guest zone does not reference the guest iface wlp14s0_g"
fi

# Explicit DHCP + DNS allow rules from the guest zone.
if grep -qE '\.name=Allow-Guest-DHCP$' "$STATE1" && grep -qE '^firewall\.droplet_guest_dhcp\.dest_port=67-68$' "$STATE1"; then
  pass "Allow-Guest-DHCP rule present (guests can lease)"
else
  fail "no Allow-Guest-DHCP rule (:67-68) — guests would never get an IP"
fi
if grep -qE '\.name=Allow-Guest-DNS$' "$STATE1" && grep -qE '^firewall\.droplet_guest_dns\.dest_port=53$' "$STATE1"; then
  pass "Allow-Guest-DNS rule present (guests can resolve)"
else
  fail "no Allow-Guest-DNS rule (:53) — guests would have no DNS"
fi

# Forwarding guest -> lan(uplink) for egress.
if grep -qE '^firewall\.droplet_guest_fwd\.src=guest$' "$STATE1"; then
  pass "forwarding from guest zone configured (egress out the uplink)"
else
  fail "no forwarding with src=guest — guests would have no internet"
fi

# Masquerade scoped to the guest subnet.
if grep -qE '\.target=MASQUERADE$' "$STATE1" && grep -qE '^firewall\.droplet_guest_masq\.src_ip=192\.168\.30\.0/24$' "$STATE1"; then
  pass "MASQUERADE scoped to the guest subnet (192.168.30.0/24)"
else
  fail "no MASQUERADE scoped to 192.168.30.0/24 — guests get a private-IP-only path"
fi

# Must NOT masquerade the AP subnet (no cross-wiring with droplet_ap_masq).
if grep -qE '^firewall\.droplet_guest_masq\.src_ip=192\.168\.20\.0/24$' "$STATE1"; then
  fail "guest masq is scoped to the AP subnet (192.168.20.0/24) — wrong subnet"
else
  pass "guest masq is not cross-wired to the AP subnet"
fi

if grep -qE '^COMMIT (firewall|all)$' "${STATE1}.events" 2>/dev/null; then
  pass "firewall config committed (uci commit firewall) so the zone persists"
else
  fail "firewall config was not committed — zone changes would be lost"
fi

echo "--- Phase 3: idempotence (second enabled run must not duplicate) ---"

if run_func "$STATE1" 1 > "$WORK/run2.log" 2>&1; then
  pass "guest_firewall_zone ran (second invocation) without error"
else
  fail "guest_firewall_zone errored on second run:"
  sed 's/^/      /' "$WORK/run2.log" >&2 || true
fi

zone_count="$(grep -cE '\.name=guest$' "$STATE1" || true)"
if [ "$zone_count" -eq 1 ]; then
  pass "exactly one 'guest' zone after two runs (no duplicate zone)"
else
  fail "found $zone_count 'guest' zone sections after two runs — not idempotent"
fi

dev_count="$(grep -cE '\.(device|network)=wlp14s0_g$' "$STATE1" || true)"
if [ "$dev_count" -eq 1 ]; then
  pass "guest iface listed exactly once (no duplicate device entry)"
else
  fail "guest iface appears $dev_count times after two runs — not idempotent"
fi

echo "--- Phase 4: teardown (GUEST_ENABLED=0 removes the zone) ---"

if run_func "$STATE1" 0 > "$WORK/run3.log" 2>&1; then
  pass "guest_firewall_zone ran (disabled) without error"
else
  fail "guest_firewall_zone errored on teardown run:"
  sed 's/^/      /' "$WORK/run3.log" >&2 || true
fi

if grep -qE '^firewall\.droplet_guest=' "$STATE1"; then
  fail "guest zone section still present after teardown — not removed"
else
  pass "guest zone section removed on teardown"
fi
if grep -qE '^firewall\.droplet_guest_masq' "$STATE1"; then
  fail "guest masq still present after teardown — not removed"
else
  pass "guest masq removed on teardown"
fi
# The LAN zone we seeded must survive teardown untouched.
if grep -qE '^firewall\.lan_zone\.name=lan$' "$STATE1"; then
  pass "LAN zone untouched by guest teardown"
else
  fail "teardown clobbered the LAN zone — too aggressive"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
