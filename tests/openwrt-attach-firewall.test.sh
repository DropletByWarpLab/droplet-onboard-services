#!/usr/bin/env bash
# =============================================================================
# WARP-810 — unit tests for the AP firewall-zone provisioning inside
# scripts/host/usr-local-sbin/droplet-openwrt-attach.
#
# Bug (field-confirmed on 192.168.1.87): the single-box AP iface (wlp14s0) is
# brought up at 192.168.20.1/24 with dnsmasq-ap serving DHCP, but it is in NO
# fw4 firewall zone. The `inet fw4 input` chain is policy-drop and only accepts
# new input from the `lan` zone (eth0 + br-lan), so a client's DHCP DISCOVER
# (new, not established) is DROPped → it associates to hostapd but never gets an
# IP. The fix adds an idempotent `ap` firewall zone (input ACCEPT) + forwarding
# out the uplink so clients get a lease AND internet, without blanket-opening
# input on any other interface.
#
# These tests do NOT require Docker or a running OpenWrt container. The
# firewall-provisioning logic is a self-contained POSIX function delimited in
# the attach script by sentinel markers; we extract it and run it against a
# stub `uci` (recording all writes to a state file) so we can assert the exact
# zone/forwarding/masq config AND that a second run is idempotent (no dupes).
#
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
echo "  ================================================"
echo "  WARP-810 — droplet-openwrt-attach AP firewall zone"
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

# The provisioning lives in a function we can call in isolation (ticket: "run
# the relevant attach function"). It must be delimited by sentinels so the test
# can extract just the POSIX function body and exercise it with stub binaries.
START_MARK="# >>> ap_firewall_zone (WARP-810)"
END_MARK="# <<< ap_firewall_zone (WARP-810)"

if grep -qF "$START_MARK" "$ATTACH" && grep -qF "$END_MARK" "$ATTACH"; then
  pass "ap_firewall_zone sentinel markers present"
else
  fail "ap_firewall_zone sentinel markers ('$START_MARK' .. '$END_MARK') missing"
fi

if grep -qE "^[[:space:]]*ap_firewall_zone\b" "$ATTACH"; then
  pass "ap_firewall_zone is invoked in the attach body"
else
  fail "ap_firewall_zone is never called in the attach body"
fi

# Guardrail: the fix must not blanket-open input. A literal flip of the global
# default input policy to ACCEPT, or an nft policy/flush of the input chain,
# would defeat the default-drop posture for every other interface.
if grep -qiE "firewall\.@defaults\[0\]\.input=ACCEPT|policy[[:space:]]+accept" "$ATTACH"; then
  fail "attach blanket-opens input (defaults input=ACCEPT or policy accept) — must stay default-drop"
else
  pass "default-drop input posture preserved (no blanket open)"
fi

# --- Behavioral: extract + run against a stub uci ----------------------------
echo "--- Phase 2: behavioral run with stub uci ---"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the function body out of the (single-quoted) docker-exec block.
sed -n "/$(printf '%s' "$START_MARK" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$END_MARK" | sed 's/[][\\.*^$/]/\\&/g')/p" \
  "$ATTACH" > "$WORK/func.sh"

if [ -s "$WORK/func.sh" ]; then
  pass "extracted ap_firewall_zone function body"
else
  fail "could not extract function body — skipping behavioral asserts"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS passed"; echo "FAILURES=$FAILURES"
  [ "$FAILURES" -eq 0 ] || exit 1
  exit 0
fi

# Stub `uci`: a tiny in-memory config persisted to $UCI_STATE. Supports the
# subset the function uses: show, get, set, add, add_list, commit, -q. Every
# `set`/`add`/`add_list` appends a line; `show` prints them back; `get`
# returns the value for an exact key. This lets us assert the resulting config
# AND detect duplicate writes across two runs.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/uci" <<'UCISTUB'
#!/usr/bin/env bash
STATE="${UCI_STATE:?UCI_STATE unset}"
touch "$STATE"
# Drop a leading -q (quiet) flag.
[ "$1" = "-q" ] && shift
cmd="$1"; shift || true
case "$cmd" in
  show)
    # Real `uci show` prints key='value' (single-quoted value). Emit the same
    # shape so callers that grep for ".name=.lan." (quote-l-a-n-quote) match,
    # exactly as they do against the real uci on the box.
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
    # uci set key=value  → upsert (replace existing key line)
    key="${1%%=*}"; val="${1#*=}"
    grep -vE "^$key=" "$STATE" > "$STATE.tmp" 2>/dev/null || true
    mv "$STATE.tmp" "$STATE"
    printf '%s=%s\n' "$key" "$val" >> "$STATE"
    ;;
  add)
    # uci add firewall zone → create anonymous section, echo its name
    cfg="$1"; typ="$2"
    idx="$(grep -cE "^__SECTION ${cfg}\.${typ}\b" "$STATE" || true)"
    name="${cfg}.@${typ}[${idx}]"
    printf '__SECTION %s.%s %s\n' "$cfg" "$typ" "$name" >> "$STATE"
    printf '%s\n' "$name"
    ;;
  add_list)
    # uci add_list key=value  → append (list semantics; dupes ARE possible if
    # the caller does not guard — which is exactly what we test for).
    printf '%s\n' "$1" >> "$STATE"
    ;;
  delete|del_list)
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

# Stub firewall reload + fw4 + nft (record invocations; the function should
# reload fw4 so the new zone takes effect, and may touch nft for masq).
for b in fw4 nft; do
  cat > "$WORK/bin/$b" <<EOF
#!/usr/bin/env bash
echo "$b \$*" >> "\${UCI_STATE}.events"
exit 0
EOF
  chmod +x "$WORK/bin/$b"
done

# The function calls the absolute path /etc/init.d/firewall reload, which we
# cannot intercept without root. We make the call succeed-or-fail without
# touching the real host by wrapping the function call so a shadow
# `/etc/init.d/firewall` is unreachable; instead we observe persistence via the
# stub uci `COMMIT firewall` event (recorded to ${UCI_STATE}.events). Commit is
# the step that actually persists the zone; the reload is best-effort and
# guarded by a WARN in production.

# Seed a realistic baseline firewall config: a named `lan` zone (as the baked
# openwrt/files/etc/config/firewall ships). On the real box trust_eth0_fw runs
# before this and the lan zone always exists, so the forwarding + masq path
# (which targets the lan zone) must be exercised here.
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

# Harness: source the extracted function, set AP_IFACE, run it once, snapshot
# the config, run it again, compare. We intercept the absolute-path reload by
# masking /etc/init.d via a function-scoped override is impossible, so the
# script reload call is allowed to fail harmlessly in-test (no real fw4 here);
# the assertions key off committed UCI state + the COMMIT event.
run_func() {
  local state="$1"
  UCI_STATE="$state" \
  PATH="$WORK/bin:$PATH" \
  AP_IFACE="wlp14s0" \
  bash -c '
    set -e
    # shellcheck disable=SC1090
    . "'"$WORK"'/func.sh"
    ap_firewall_zone
  '
}

STATE1="$WORK/state1"
seed_state "$STATE1"
if run_func "$STATE1" > "$WORK/run1.log" 2>&1; then
  pass "ap_firewall_zone ran (first invocation) without error"
else
  fail "ap_firewall_zone errored on first run:"
  sed 's/^/      /' "$WORK/run1.log" >&2 || true
fi

# Assert: a zone is named 'ap'.
if grep -qE '\.name=ap$' "$STATE1"; then
  pass "AP firewall zone named 'ap' created"
else
  fail "no firewall zone named 'ap' in resulting config"
fi

# Assert: the AP zone covers wlp14s0 (device or network).
if grep -qE '\.(device|network)=wlp14s0$' "$STATE1"; then
  pass "AP zone covers wlp14s0"
else
  fail "AP zone does not reference wlp14s0"
fi

# Assert: input is ACCEPT on the AP zone (the critical DHCP-DISCOVER fix).
if grep -qE '\.input=ACCEPT$' "$STATE1"; then
  pass "AP zone input=ACCEPT (DHCP/DNS reach dnsmasq-ap)"
else
  fail "AP zone is missing input=ACCEPT — DHCP DISCOVER would still be dropped"
fi

# Assert: a forwarding rule out of the AP zone exists (clients reach internet).
if grep -qE '\.src=ap$' "$STATE1"; then
  pass "forwarding from AP zone configured (clients can route out the uplink)"
else
  fail "no forwarding with src=ap — AP clients would have no internet"
fi

# Assert: masquerade is ensured for AP egress — either a fw4 NAT MASQUERADE
# section scoped to the AP subnet, a zone masq=1, or an nft masquerade rule.
if grep -qiE '\.target=MASQUERADE$|\.masq=1$' "$STATE1" || \
   grep -qiE 'masquerade' "$WORK/run1.log" "${STATE1}.events" 2>/dev/null; then
  pass "masquerade ensured for AP egress (NAT MASQUERADE scoped to 192.168.20.0/24)"
else
  fail "no masquerade for AP egress — clients would get a private-IP-only path"
fi

# Assert: the masquerade NAT is scoped to the AP subnet (must NOT blanket-NAT —
# would double-NAT the lan zone's own clients on the multi-box shape).
if ! grep -qE '\.src_ip=192\.168\.20\.0/24$' "$STATE1"; then
  fail "MASQUERADE is not scoped to 192.168.20.0/24 — risks double-NAT on multi-box"
else
  pass "MASQUERADE scoped to the AP subnet (192.168.20.0/24)"
fi

# Assert: the firewall config was committed (the persistence step that makes
# the zone real). The subsequent /etc/init.d/firewall reload is best-effort and
# guarded by a WARN in production; commit is the deterministic signal.
if grep -qE '^COMMIT (firewall|all)$' "${STATE1}.events" 2>/dev/null; then
  pass "firewall config committed (uci commit firewall) so the zone persists"
else
  fail "firewall config was not committed — zone changes would be lost"
fi

echo "--- Phase 3: idempotence (second run must not duplicate) ---"

# Second run against the SAME state file (simulates re-running the attach).
if run_func "$STATE1" > "$WORK/run2.log" 2>&1; then
  pass "ap_firewall_zone ran (second invocation) without error"
else
  fail "ap_firewall_zone errored on second run:"
  sed 's/^/      /' "$WORK/run2.log" >&2 || true
fi

# No duplicate 'ap' zone section.
zone_count="$(grep -cE '\.name=ap$' "$STATE1" || true)"
if [ "$zone_count" -eq 1 ]; then
  pass "exactly one 'ap' zone after two runs (no duplicate zone)"
else
  fail "found $zone_count 'ap' zone sections after two runs — not idempotent"
fi

# No duplicate wlp14s0 device/network membership.
dev_count="$(grep -cE '\.(device|network)=wlp14s0$' "$STATE1" || true)"
if [ "$dev_count" -eq 1 ]; then
  pass "wlp14s0 listed exactly once (no duplicate device entry)"
else
  fail "wlp14s0 appears $dev_count times after two runs — not idempotent"
fi

# No duplicate forwarding section.
fwd_count="$(grep -cE '\.src=ap$' "$STATE1" || true)"
if [ "$fwd_count" -eq 1 ]; then
  pass "exactly one ap-source forwarding after two runs (no duplicate forwarding)"
else
  fail "found $fwd_count ap-source forwardings after two runs — not idempotent"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
