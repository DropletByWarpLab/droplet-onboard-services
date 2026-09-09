#!/usr/bin/env bash
# =============================================================================
# WARP-2054 — the onboard radio is OFF by default (founder rule), and that is
# what makes droplet-openwrt-attach.service's unit state meaningful again.
#
# Founder rule (2026-07-28): "we will never use the onboard droplet radios for
# the aps. droplet box should be totally local always … the final box will have
# onboard radios deactivated and all traffic will go through the pi router for
# security."
#
# Before this fix the AP leg was ON by default, and it cost two separate things:
#
#   1. detect_ap_radio resolved the phy and the attach MOVED it into the
#      openwrt container's netns, leaving the radio claimed and powered —
#      exactly what the rule forbids.
#   2. hostapd was then attempted and failed on EVERY boot, so the unit sat
#      permanently `failed`. That same unit installs the WireGuard overlay NAT,
#      so a REAL overlay-NAT failure and a cosmetic AP failure were
#      indistinguishable by unit state. That masking is the actual bug.
#
# The unit under test is the `onboard_radio_policy` block plus its interaction
# with the existing WARP-2150 `ap_attach_gate`. Sentinel extraction + stub PATH,
# mirroring tests/openwrt-attach-ap-skip-unresolved-iface.test.sh — no Docker,
# no container, no Wi-Fi card.
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
echo "  WARP-2054 — onboard radio off by default"
echo "  ================================================"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

esc() { printf '%s' "$1" | sed 's/[][\\.*^$/]/\\&/g'; }
extract() { sed -n "/$(esc "$1")/,/$(esc "$2")/p" "$ATTACH" > "$3"; }

# rfkill stub: records every invocation so we can assert WHAT was blocked.
cat > "$WORK/bin/rfkill" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RFKILL_LOG"
exit 0
STUB
chmod +x "$WORK/bin/rfkill"

POLICY="$WORK/policy.sh"
GATE="$WORK/gate.sh"
extract "# >>> onboard_radio_policy (WARP-2054)" "# <<< onboard_radio_policy (WARP-2054)" "$POLICY"
extract "# >>> ap_attach_gate (WARP-2150)" "# <<< ap_attach_gate (WARP-2150)" "$GATE"

# Drive the policy block with a stubbed detect_ap_radio, then the real gate, and
# print the decision the rest of the script would act on.
run_policy() { # env assignments come from the caller
  RFKILL_LOG="$WORK/rfkill.log"; : > "$RFKILL_LOG"
  : > "$WORK/detect.log"
  PATH="$WORK/bin:$PATH" RFKILL_LOG="$RFKILL_LOG" DETECT_LOG="$WORK/detect.log" bash -c '
    set -u
    AP_PHY="${DROPLET_AP_PHY:-}"
    AP_IFACE="${DROPLET_AP_IFACE:-}"
    detect_ap_radio() { echo called >> "$DETECT_LOG"; AP_PHY="${AP_PHY:-phy0}"; AP_IFACE="${AP_IFACE:-wlan0}"; }
    . "$1"
    . "$2"
    printf "AP_ATTACH=%s\nAP_PHY=%s\nAP_IFACE=%s\nWHY=%s\n" \
      "${AP_ATTACH:-}" "$AP_PHY" "$AP_IFACE" "${_ap_skip_why:-}"
  ' _ "$POLICY" "$GATE" 2>&1
}

# --- Phase 1: structure -------------------------------------------------------
echo "--- Phase 1: structure ---"

for m in "# >>> onboard_radio_policy (WARP-2054)" "# <<< onboard_radio_policy (WARP-2054)"; do
  if grep -qF "$m" "$ATTACH"; then pass "sentinel present: $m"; else fail "sentinel missing: $m"; fi
done

if grep -qE 'AP_ONBOARD="\$\{DROPLET_AP_ONBOARD:-0\}"' "$ATTACH"; then
  pass "DROPLET_AP_ONBOARD defaults to 0 (off) — the founder rule is the default, not an opt-out"
else
  fail "DROPLET_AP_ONBOARD does not default to 0 — the onboard AP would still run on a shipping box"
fi

# detect_ap_radio must NOT be invoked unconditionally any more: detection is
# what resolved the phy that then got moved into the container netns.
if grep -qE '^detect_ap_radio[[:space:]]*$' "$ATTACH"; then
  fail "detect_ap_radio is still invoked unconditionally — the radio is resolved even when policy says it is off"
else
  pass "detect_ap_radio is no longer invoked unconditionally"
fi

p_line=$(grep -nF "# >>> onboard_radio_policy (WARP-2054)" "$ATTACH" | head -1 | cut -d: -f1)
g_line=$(grep -nF "# >>> ap_attach_gate (WARP-2150)" "$ATTACH" | head -1 | cut -d: -f1)
if [ -n "$p_line" ] && [ -n "$g_line" ] && [ "$p_line" -lt "$g_line" ]; then
  pass "policy block precedes the WARP-2150 gate (gate consumes the emptied AP_IFACE)"
else
  fail "policy block does not precede ap_attach_gate — the gate would see a stale iface"
fi

# --- Phase 2: default (shipping) behaviour ------------------------------------
echo ""
echo "--- Phase 2: default shipping box — radio off ---"

out="$(run_policy)"
case "$out" in *"AP_ATTACH=0"*) pass "default: AP_ATTACH=0 (no AP attempted)" ;;
  *) fail "default: expected AP_ATTACH=0, got: $out" ;; esac
if printf '%s' "$out" | grep -qE '^AP_IFACE=$'; then
  pass "default: AP_IFACE left empty (nothing for the netns move to act on)"
else
  fail "default: AP_IFACE is not empty — the phy could still be moved into the container"
fi
if [ -s "$WORK/detect.log" ]; then
  fail "default: detect_ap_radio was called — the radio is being resolved despite policy"
else
  pass "default: detect_ap_radio NOT called"
fi
if grep -q 'block wlan' "$WORK/rfkill.log" 2>/dev/null; then
  pass "default: radio is soft-blocked (deactivated, not merely ignored)"
else
  fail "default: rfkill block was not issued — a powered radio is still a transmitter"
fi

# Bluetooth must survive: Matter BLE commissioning needs the adapter, and on the
# MT7922 it is a different USB function of the SAME chip.
if grep -qE 'block (all|bluetooth)' "$WORK/rfkill.log" 2>/dev/null; then
  fail "Bluetooth was blocked too — that breaks Matter BLE commissioning"
else
  pass "Bluetooth untouched (only the wlan class is blocked)"
fi

# --- Phase 3: a stale operator pin must not defeat the policy -----------------
echo ""
echo "--- Phase 3: stale DROPLET_AP_IFACE pin ---"

# DROPLET_AP_IFACE is AUTHORITATIVE elsewhere in the script, so a leftover pin
# is exactly how a box keeps attempting an AP after the policy lands. This is
# the live 2026-08-27 shape: /etc/default carried DROPLET_AP_IFACE=wlp10s0.
out="$(DROPLET_AP_PHY=phy0 DROPLET_AP_IFACE=wlp10s0 run_policy)"
if printf '%s' "$out" | grep -qE '^AP_ATTACH=0$'; then
  pass "stale pin: policy still wins (AP_ATTACH=0)"
else
  fail "stale pin: the authoritative pin defeated the policy — got: $out"
fi

# --- Phase 4: the dev opt-in still works --------------------------------------
echo ""
echo "--- Phase 4: DROPLET_AP_ONBOARD=1 (dev opt-in) ---"

out="$(DROPLET_AP_ONBOARD=1 run_policy)"
if [ -s "$WORK/detect.log" ]; then
  pass "opt-in: detect_ap_radio IS called"
else
  fail "opt-in: detect_ap_radio was not called — the dev path is broken"
fi
if printf '%s' "$out" | grep -qE '^AP_ATTACH=1$'; then
  pass "opt-in: AP_ATTACH=1 (historical path preserved)"
else
  fail "opt-in: expected AP_ATTACH=1, got: $out"
fi
# A prior policy-off boot leaves the radio blocked; opting in must undo that or
# the AP silently stays dead and looks like the very bug being fixed.
if grep -q 'unblock wlan' "$WORK/rfkill.log" 2>/dev/null; then
  pass "opt-in: radio is unblocked (a previous policy-off boot cannot strand it)"
else
  fail "opt-in: no rfkill unblock — a previously blocked radio stays dead with no clue why"
fi

# --- Phase 5: the skip message tells the truth ---------------------------------
echo ""
echo "--- Phase 5: diagnostics ---"

out="$(run_policy)"
if printf '%s' "$out" | grep -qi 'disabled by policy'; then
  pass "skip reason names the policy, not a phantom hardware fault"
else
  fail "skip reason does not name the policy — triage will chase a missing card"
fi
if printf '%s' "$out" | grep -q 'Fix the cause or pin DROPLET_AP_PHY'; then
  fail "policy-off still prints the 'Fix the cause' WARN — it tells the operator to undo an intended state"
else
  pass "policy-off does not emit the misleading 'Fix the cause' WARN"
fi

# --- Phase 6: mutation — prove the guards are load-bearing ---------------------
echo ""
echo "--- Phase 6: mutation checks ---"

MUT="$WORK/mutant-policy.sh"

# Drop the AP_PHY/AP_IFACE clearing: a stale pin must then leak through.
sed 's/^  AP_IFACE=""$/  : # mutated/' "$POLICY" > "$MUT"
if ! cmp -s "$POLICY" "$MUT"; then
  RFKILL_LOG="$WORK/rfkill.log"; : > "$RFKILL_LOG"; : > "$WORK/detect.log"
  mout="$(PATH="$WORK/bin:$PATH" RFKILL_LOG="$RFKILL_LOG" DETECT_LOG="$WORK/detect.log" \
    DROPLET_AP_IFACE=wlp10s0 bash -c '
      set -u
      AP_PHY="${DROPLET_AP_PHY:-}"; AP_IFACE="${DROPLET_AP_IFACE:-}"
      detect_ap_radio() { echo called >> "$DETECT_LOG"; }
      . "$1"; . "$2"; printf "AP_ATTACH=%s\n" "${AP_ATTACH:-}"' _ "$MUT" "$GATE" 2>&1)"
  if printf '%s' "$mout" | grep -qE '^AP_ATTACH=1$'; then
    pass "mutation: removing the AP_IFACE clear lets a stale pin through (guard is load-bearing)"
  else
    fail "mutation: clearing AP_IFACE changed nothing — that guard never fires, so it is not what stops the pin"
  fi
else
  fail "mutation: could not mutate the policy block (shape changed — update this test)"
fi

# Flip the default to 1: the shipping box must then attempt an AP again.
sed 's/AP_ONBOARD="${DROPLET_AP_ONBOARD:-0}"/AP_ONBOARD="${DROPLET_AP_ONBOARD:-1}"/' "$POLICY" > "$MUT"
if ! cmp -s "$POLICY" "$MUT"; then
  RFKILL_LOG="$WORK/rfkill.log"; : > "$RFKILL_LOG"; : > "$WORK/detect.log"
  mout="$(PATH="$WORK/bin:$PATH" RFKILL_LOG="$RFKILL_LOG" DETECT_LOG="$WORK/detect.log" bash -c '
      set -u
      AP_PHY=""; AP_IFACE=""
      detect_ap_radio() { echo called >> "$DETECT_LOG"; AP_PHY=phy0; AP_IFACE=wlan0; }
      . "$1"; . "$2"; printf "AP_ATTACH=%s\n" "${AP_ATTACH:-}"' _ "$MUT" "$GATE" 2>&1)"
  if printf '%s' "$mout" | grep -qE '^AP_ATTACH=1$'; then
    pass "mutation: flipping the default to 1 re-enables the AP (the default is what turns it off)"
  else
    fail "mutation: flipping the default changed nothing — the default is not what disables the AP"
  fi
else
  fail "mutation: could not mutate the default (shape changed — update this test)"
fi

echo ""
echo "  ------------------------------------------------"
printf "  %s test(s), %s failure(s)\n" "$TESTS" "$FAILURES"
echo "  ------------------------------------------------"
echo ""
[ "$FAILURES" -eq 0 ]
