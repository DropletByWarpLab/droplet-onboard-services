#!/usr/bin/env bash
# =============================================================================
# WARP-2150 — unit tests for the "skip AP bring-up on an unresolved wireless
# iface" gate in scripts/host/usr-local-sbin/droplet-openwrt-attach.
#
# Live root cause (first validated fresh install, 2026-08-24): the host image
# shipped WITHOUT iw(8). The attach script hit
#   /usr/local/sbin/droplet-openwrt-attach: line 449: iw: command not found
# at the phy netns move, detect_ap_radio resolved iface='' (its iw map was
# empty), logged
#   WARN: no wireless phy/iface resolved (phy='phy0' iface='')
# and then LIMPED ON into the AP phase: nft rules rendered with an empty
# iifname ("Empty string is not allowed"), `ip link set "" up` ("Device ""
# does not exist"), three doomed hostapd retries, and finally a unit failure
# blaming "AP/package prerequisites" — none of which named the actual cause.
#
# The fix under test (two halves):
#   * ap_attach_gate (host side)  — decides AP_ATTACH=0 once when AP_IFACE is
#     empty, with ONE actionable message naming the likely cause (missing iw /
#     no phy / netdev-less phy) and the fix.
#   * ap_phase_gate (container body) — the entire AP phase (hostapd conf +
#     start + watchdog, dnsmasq-ap, br-ap, AP-iface L3, guest L3) is wrapped in
#     an AP_ATTACH check, and the AP-iface DNAT rules carry the same condition,
#     so an empty iface never reaches nft or hostapd. Default is 1, so the
#     resolved-iface path is byte-for-byte the historical one.
#   * the bare `iw phy ... set netns` is command -v guarded (the literal
#     line-449 crash).
#
# No Docker, container, or Wi-Fi card needed: sentinel extraction + stub PATH,
# mirroring tests/openwrt-attach-iface-detect.test.sh and
# tests/openwrt-attach-quote-balance.test.sh (body extraction). Run it against
# a pre-fix attach script via DROPLET_ATTACH_SCRIPT to see every phase fail.
#
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTACH="${DROPLET_ATTACH_SCRIPT:-$REPO_ROOT_REAL/scripts/host/usr-local-sbin/droplet-openwrt-attach}"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-2150 — skip AP bring-up on unresolved iface"
echo "  ================================================"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

esc() { printf '%s' "$1" | sed 's/[][\\.*^$/]/\\&/g'; }
extract() { # <start-mark> <end-mark> <outfile>
  sed -n "/$(esc "$1")/,/$(esc "$2")/p" "$ATTACH" > "$3"
}

# --- Phase 1: structure -------------------------------------------------------
echo "--- Phase 1: gates present, crash line guarded, AP phase contained ---"

if [ -f "$ATTACH" ]; then pass "attach script exists"; else fail "attach script missing at $ATTACH"; echo "FAILURES=$FAILURES"; exit 1; fi

for m in \
  "# >>> ap_attach_gate (WARP-2150)" "# <<< ap_attach_gate (WARP-2150)" \
  "# >>> ap_phase_gate (WARP-2150)" "# <<< ap_phase_gate (WARP-2150)"; do
  if grep -qF "$m" "$ATTACH"; then pass "sentinel present: $m"; else fail "sentinel missing: $m"; fi
done

# The host decision must reach the container body as env.
if grep -qE -- '-e AP_ATTACH="\$AP_ATTACH"' "$ATTACH"; then
  pass "docker exec passes AP_ATTACH into the container body"
else
  fail "docker exec does not pass AP_ATTACH — the container body cannot honor the skip"
fi

# The literal live crash: a BARE `iw phy ... set netns` reachable with iw
# absent. Post-fix every `iw phy` invocation in the OUTER script must sit under
# a `command -v iw` guard (the container body installs its own iw via opkg and
# is not the host crash surface).
if grep -qE '^\[ -e "/sys/class/ieee80211/\$AP_PHY" \] && iw phy' "$ATTACH"; then
  fail "the bare one-liner netns move is still present — a host without iw dies with command-not-found (the live line-449 crash)"
else
  pass "bare one-liner netns move is gone"
fi
if awk '/command -v iw/ {guard=NR} /^[[:space:]]*iw phy .* set netns/ { if (guard == 0 || NR - guard > 3) bad=1 } END { exit bad }' "$ATTACH"; then
  pass "the netns move runs only behind a command -v iw guard"
else
  fail "an iw phy netns move is not behind a command -v iw guard"
fi

# Locate the docker-exec body (same technique as the quote-balance test), then
# the ap_phase_gate span inside it, and assert every AP-phase entry point that
# used to grind on an empty iface lies INSIDE the gate.
open=$(grep -nE "sh -c '$" "$ATTACH" | head -1 | cut -d: -f1) || true
close=""
[ -n "$open" ] && close=$(awk -v o="$open" 'NR>o && $0 ~ /^[[:space:]]*\x27[[:space:]]*$/ {print NR; exit}' "$ATTACH")
g_open=$(grep -nF "# >>> ap_phase_gate (WARP-2150)" "$ATTACH" | head -1 | cut -d: -f1) || true
g_close=$(grep -nF "# <<< ap_phase_gate (WARP-2150)" "$ATTACH" | head -1 | cut -d: -f1) || true

if [ -n "$open" ] && [ -n "$close" ] && [ -n "$g_open" ] && [ -n "$g_close" ] \
   && [ "$open" -lt "$g_open" ] && [ "$g_close" -lt "$close" ]; then
  pass "ap_phase_gate lives inside the docker-exec body (body ${open}..${close}, gate ${g_open}..${g_close})"

  inside() { # <pattern> <label>
    local n
    n=$(grep -nF "$1" "$ATTACH" | head -1 | cut -d: -f1) || true
    if [ -n "$n" ] && [ "$n" -gt "$g_open" ] && [ "$n" -lt "$g_close" ]; then
      pass "$2 is inside the AP_ATTACH gate"
    else
      fail "$2 is NOT inside the AP_ATTACH gate (line ${n:-<absent>}) — it would run with an empty iface"
    fi
  }
  inside 'cat > /etc/hostapd.conf.new' "hostapd conf generation"
  inside 'if ! start_hostapd; then' "start_hostapd invocation (the three doomed retries)"
  inside 'dnsmasq -C /etc/dnsmasq-ap.conf' "dnsmasq-ap start"
  inside 'ip link set "$AP_IFACE" up' "AP-iface link-up (Device \"\" does not exist)"
else
  fail "could not locate the docker-exec body + ap_phase_gate span (body ${open:-?}..${close:-?}, gate ${g_open:-?}..${g_close:-?})"
fi

# The AP-iface DNAT rules sit BEFORE the phase gate (between the wg0 rules that
# must always run) — they must carry the AP_ATTACH condition themselves, or nft
# renders iifname "" (Empty string is not allowed).
if grep -qE 'if \[ "\$\{AP_ATTACH:-1\}" = 1 \] && \[ "\$\{AP_BRIDGE:-0\}" != 1 \]; then' "$ATTACH"; then
  pass "AP-iface DNAT rules are conditioned on AP_ATTACH (no empty-iifname nft)"
else
  fail "AP-iface DNAT rules are not conditioned on AP_ATTACH — empty iifname reaches nft"
fi

# The wg0 dashboard DNAT must stay OUTSIDE the gate: VPN clients reach the
# dashboard whether or not the local radio resolved.
wg_line=$(grep -nF 'iifname \"wg0\" ip daddr 192.168.20.1 tcp dport 443' "$ATTACH" | head -1 | cut -d: -f1) || true
if [ -n "$wg_line" ] && { [ -z "$g_open" ] || [ "$wg_line" -lt "$g_open" ]; }; then
  pass "wg0 dashboard DNAT stays outside the gate (VPN path unaffected by the skip)"
else
  fail "wg0 dashboard DNAT is missing or was swallowed by the gate (line ${wg_line:-<absent>})"
fi

# --- Phase 2: ap_attach_gate behavior (host side) -----------------------------
echo "--- Phase 2: ap_attach_gate — iface-empty / iw-missing / iface-present ---"

extract "# >>> ap_attach_gate (WARP-2150)" "# <<< ap_attach_gate (WARP-2150)" "$WORK/gate.sh"
if [ -s "$WORK/gate.sh" ]; then
  pass "extracted ap_attach_gate"
else
  fail "could not extract ap_attach_gate — skipping behavioral asserts"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS checks passed"; echo "FAILURES=$FAILURES"
  [ "$FAILURES" -eq 0 ] || exit 1
  exit 0
fi

run_gate() { # <envline> <path>
  local envline="$1" path="$2"
  PATH="$path" "$BASH" -c "
    AP_PHY=\"\"
    AP_IFACE=\"\"
    $envline
    . '$WORK/gate.sh'
    printf 'AP_ATTACH=%s\n' \"\$AP_ATTACH\"
  " 2>&1
}
BASH="$(command -v bash)"
mkdir -p "$WORK/noiw"           # a PATH with no iw at all

# Case A: iw missing + phy present + iface empty (the live 2026-08-24 journal).
OUT_A="$(run_gate 'AP_PHY=phy0' "$WORK/noiw" || true)"
if printf '%s' "$OUT_A" | grep -q 'AP_ATTACH=0'; then
  pass "iw missing, phy present: AP_ATTACH=0 (AP phase will be skipped)"
else
  fail "iw missing, phy present: expected AP_ATTACH=0, got: $OUT_A"
fi
if printf '%s' "$OUT_A" | grep -q 'skipping AP bring-up' && printf '%s' "$OUT_A" | grep -qi 'iw'; then
  pass "iw missing: ONE clear skip message naming iw as the cause"
else
  fail "iw missing: skip message absent or does not name iw, got: $OUT_A"
fi
if [ "$(printf '%s\n' "$OUT_A" | grep -c 'droplet-openwrt-attach:')" = 1 ]; then
  pass "iw missing: exactly one attach log line (no error spray)"
else
  fail "iw missing: expected exactly one attach log line, got: $OUT_A"
fi

# Case B: iw present (stub) + NO phy + iface empty — no card / radio already in
# the container netns. Skip with the no-phy cause, and still exit 0 (the gate
# must never abort the attach: everything after it still runs).
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/iw"; chmod +x "$WORK/bin/iw"
if OUT_B="$(run_gate '' "$WORK/bin:$PATH")"; then
  if printf '%s' "$OUT_B" | grep -q 'AP_ATTACH=0' && printf '%s' "$OUT_B" | grep -q 'skipping AP bring-up'; then
    pass "no phy, iface empty: AP_ATTACH=0 with the skip message, gate exits 0"
  else
    fail "no phy, iface empty: expected AP_ATTACH=0 + skip message, got: $OUT_B"
  fi
else
  fail "no phy, iface empty: ap_attach_gate exited non-zero (must not abort the attach)"
fi

# Case C: iface resolved — the historical path must be untouched: AP_ATTACH=1
# and NO skip message.
OUT_C="$(run_gate 'AP_PHY=phy0; AP_IFACE=wlp14s0' "$WORK/bin:$PATH" || true)"
if printf '%s' "$OUT_C" | grep -q 'AP_ATTACH=1' && ! printf '%s' "$OUT_C" | grep -q 'skipping AP bring-up'; then
  pass "iface resolved: AP_ATTACH=1, no skip message (unchanged path)"
else
  fail "iface resolved: expected AP_ATTACH=1 and no skip message, got: $OUT_C"
fi

# --- Phase 3: ap_phase_gate behavior (container body) -------------------------
echo "--- Phase 3: ap_phase_gate — AP_ATTACH=0 runs nothing, logs once, rc 0 ---"

extract "# >>> ap_phase_gate (WARP-2150)" "# <<< ap_phase_gate (WARP-2150)" "$WORK/phase.sh"
if [ -s "$WORK/phase.sh" ]; then
  pass "extracted ap_phase_gate span"
else
  fail "could not extract ap_phase_gate span"
fi

if [ -s "$WORK/phase.sh" ]; then
  # Logging stubs: ANY invocation of an AP-phase tool is recorded. With
  # AP_ATTACH=0 the interior must be dead code, so the log stays EMPTY.
  for tool in nft hostapd dnsmasq uci ip pgrep iw start-stop-daemon; do
    printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/calls.log"\nexit 0\n' "$tool" "$WORK" > "$WORK/bin/$tool"
    chmod +x "$WORK/bin/$tool"
  done
  : > "$WORK/calls.log"
  if OUT_P="$(AP_ATTACH=0 AP_IFACE="" PATH="$WORK/bin:$PATH" "$BASH" "$WORK/phase.sh" 2>&1)"; then
    if [ ! -s "$WORK/calls.log" ]; then
      pass "AP_ATTACH=0: zero nft/hostapd/dnsmasq/ip invocations (clean skip)"
    else
      fail "AP_ATTACH=0: AP-phase tools were invoked: $(tr '\n' '; ' < "$WORK/calls.log")"
    fi
    if printf '%s' "$OUT_P" | grep -q 'AP bring-up skipped inside the container'; then
      pass "AP_ATTACH=0: single skip breadcrumb logged in the container body"
    else
      fail "AP_ATTACH=0: skip breadcrumb missing, got: $OUT_P"
    fi
  else
    fail "AP_ATTACH=0: gated span exited non-zero — the skip would fail the unit (got: $OUT_P)"
  fi

  # Default must be RUN (an unset AP_ATTACH keeps the historical path): the
  # gate condition is ${AP_ATTACH:-1} so an old caller without the env change
  # behaves exactly as before.
  if grep -qE 'if \[ "\$\{AP_ATTACH:-1\}" = 1 \]; then' "$WORK/phase.sh"; then
    pass "gate defaults to 1 (unset env keeps the historical bring-up path)"
  else
    fail "gate does not default AP_ATTACH to 1 — an unset env would skip the AP on every box"
  fi

  # The single-quoted docker-exec body tolerates no apostrophes; assert the
  # whole gated span (comments included) stays clean, mirroring the quote-
  # balance guard so a reworded message cannot break the body.
  if grep -q "'" "$WORK/phase.sh"; then
    fail "apostrophe inside the gated span — would close the single-quoted docker-exec body early"
  else
    pass "gated span is apostrophe-free (safe inside the single-quoted exec body)"
  fi
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
