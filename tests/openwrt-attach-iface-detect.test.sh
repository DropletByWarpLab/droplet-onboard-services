#!/usr/bin/env bash
# =============================================================================
# WARP-826 — unit tests for wireless phy/iface AUTO-DETECTION inside
# scripts/host/usr-local-sbin/droplet-openwrt-attach.
#
# Bug (static analysis + field history): the attach script hardcoded
# AP_PHY=phy1 / AP_IFACE=wlp7s0 (the AX210 layout). Real single-box hardware
# varies — the photo-studio MT7922 enumerates as phy0 / wlp14s0. When the
# hardcoded phy/iface does not match the card actually present, two things break:
#   * `iw phy "$AP_PHY" set netns "$PID"` targets a phy that does not exist
#     (no-op guarded by the [ -e /sys/class/ieee80211/$AP_PHY ] test → the radio
#     is NEVER moved into the container netns), and
#   * hostapd is told `interface=$AP_IFACE` for an iface the container can't see
#     → hostapd bind fails → the Droplet AP never appears.
#
# The fix: auto-detect the host's wireless phy + its netdev name by enumerating
# /sys/class/ieee80211 (phys) and `iw dev` (ifaces), so the attach works on ANY
# card. An explicit DROPLET_AP_PHY / DROPLET_AP_IFACE env override stays
# AUTHORITATIVE — set values are used verbatim and detection is skipped — so an
# operator can always pin the radio.
#
# These tests do NOT require Docker, a running OpenWrt container, or a real
# Wi-Fi card. The detection logic is a self-contained POSIX function delimited
# in the attach script by sentinel markers; we extract it and run it against a
# fake sysfs tree + a stub `iw` so we can assert it resolves the right phy/iface
# AND that an env override wins. Mirrors tests/openwrt-attach-firewall.test.sh.
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
echo "  WARP-826 — droplet-openwrt-attach phy/iface auto-detect"
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

START_MARK="# >>> detect_ap_radio (WARP-826)"
END_MARK="# <<< detect_ap_radio (WARP-826)"

if grep -qF "$START_MARK" "$ATTACH" && grep -qF "$END_MARK" "$ATTACH"; then
  pass "detect_ap_radio sentinel markers present"
else
  fail "detect_ap_radio sentinel markers ('$START_MARK' .. '$END_MARK') missing"
fi

if grep -qE "^[[:space:]]*detect_ap_radio\b" "$ATTACH"; then
  pass "detect_ap_radio is invoked in the attach body"
else
  fail "detect_ap_radio is never called in the attach body"
fi

# Guardrail: the old hardcoded literals must NOT be the *default*. The hardware
# comment may still mention them, but `AP_PHY="${DROPLET_AP_PHY:-phy1}"` /
# `AP_IFACE="${DROPLET_AP_IFACE:-wlp7s0}"` (a hardcoded fallback) must be gone —
# the fallback is now detection. We assert no `:-phy1`/`:-wlp7s0`/`:-phy0`/
# `:-wlp14s0` host-specific default remains on an AP_PHY/AP_IFACE assignment.
if grep -qE 'AP_(PHY|IFACE)=.*:-(phy[0-9]+|wl[a-z0-9]+)' "$ATTACH"; then
  fail "a hardcoded host-specific phy/iface default still exists (rule 12) — detection must be the fallback"
else
  pass "no hardcoded host-specific phy/iface default (detection is the fallback)"
fi

# --- Behavioral: extract + run against a fake sysfs + stub iw -----------------
echo "--- Phase 2: behavioral run with fake sysfs + stub iw ---"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the function body out of the attach script.
sed -n "/$(printf '%s' "$START_MARK" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$END_MARK" | sed 's/[][\\.*^$/]/\\&/g')/p" \
  "$ATTACH" > "$WORK/func.sh"

if [ -s "$WORK/func.sh" ]; then
  pass "extracted detect_ap_radio function body"
else
  fail "could not extract function body — skipping behavioral asserts"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS passed"; echo "FAILURES=$FAILURES"
  [ "$FAILURES" -eq 0 ] || exit 1
  exit 0
fi

# The function must read sysfs via a parameterizable root so the test can point
# it at a fixture dir instead of the host's real /sys. We require it to honor a
# SYS_CLASS_IEEE80211 override (defaulting to /sys/class/ieee80211 in prod).
mkdir -p "$WORK/bin"

# Stub `iw`: emulate `iw dev` output. The function parses it to map the chosen
# phy → its netdev name. Real `iw dev` groups interfaces under `phy#N`:
#   phy#0
#       Interface wlp14s0
#           ifindex 5
#           type managed
# We support that exact shape so the parser is exercised as on a real host.
make_iw_stub() {
  local devout="$1"
  cat > "$WORK/bin/iw" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "dev" ]; then
  cat <<'IWDEV'
$devout
IWDEV
  exit 0
fi
# 'iw phy ... set netns ...' and anything else: succeed quietly (not under test here)
exit 0
EOF
  chmod +x "$WORK/bin/iw"
}

# Helper: build a fake /sys/class/ieee80211 tree with the given phy names.
make_sysfs() {
  local root="$1"; shift
  rm -rf "$root"; mkdir -p "$root"
  local p
  for p in "$@"; do
    mkdir -p "$root/$p"
  done
}

# Run the detector with a given environment, echo the resolved AP_PHY/AP_IFACE.
run_detect() {
  local sysfs="$1" envline="$2"
  UCI_UNUSED=1 \
  PATH="$WORK/bin:$PATH" \
  SYS_CLASS_IEEE80211="$sysfs" \
  bash -c "
    set -e
    AP_PHY=\"\"
    AP_IFACE=\"\"
    $envline
    # shellcheck disable=SC1090
    . '$WORK/func.sh'
    detect_ap_radio
    printf 'PHY=%s IFACE=%s\n' \"\$AP_PHY\" \"\$AP_IFACE\"
  "
}

# --- Case A: single phy (phy0 → wlp14s0) — the MT7922 single-box -------------
SYSA="$WORK/sysA"
make_sysfs "$SYSA" phy0
make_iw_stub 'phy#0
	Interface wlp14s0
		ifindex 5
		wdev 0x1
		addr aa:bb:cc:dd:ee:ff
		type managed'

OUT_A="$(run_detect "$SYSA" '' 2>&1 || true)"
if printf '%s' "$OUT_A" | grep -qx 'PHY=phy0 IFACE=wlp14s0'; then
  pass "single-phy host: detects phy0 → wlp14s0 (MT7922 single-box)"
else
  fail "single-phy host: expected 'PHY=phy0 IFACE=wlp14s0', got: $OUT_A"
fi

# --- Case B: a DIFFERENT card (phy0 → wlan0) — proves it isn't hardcoded -----
SYSB="$WORK/sysB"
make_sysfs "$SYSB" phy0
make_iw_stub 'phy#0
	Interface wlan0
		ifindex 3
		type managed'

OUT_B="$(run_detect "$SYSB" '' 2>&1 || true)"
if printf '%s' "$OUT_B" | grep -qx 'PHY=phy0 IFACE=wlan0'; then
  pass "different card: detects phy0 → wlan0 (works regardless of card naming)"
else
  fail "different card: expected 'PHY=phy0 IFACE=wlan0', got: $OUT_B"
fi

# --- Case C: env override is AUTHORITATIVE -----------------------------------
# Hardware has phy0/wlp14s0, but operator pinned phy1/wlp7s0. The override must
# win verbatim and detection must NOT clobber it.
SYSC="$WORK/sysC"
make_sysfs "$SYSC" phy0 phy1
make_iw_stub 'phy#0
	Interface wlp14s0
		type managed
phy#1
	Interface wlp7s0
		type managed'

OUT_C="$(run_detect "$SYSC" 'AP_PHY=phy1; AP_IFACE=wlp7s0' 2>&1 || true)"
if printf '%s' "$OUT_C" | grep -qx 'PHY=phy1 IFACE=wlp7s0'; then
  pass "env override authoritative: explicit phy1/wlp7s0 used verbatim (detection skipped)"
else
  fail "env override authoritative: expected 'PHY=phy1 IFACE=wlp7s0', got: $OUT_C"
fi

# --- Case D: partial override — only AP_IFACE pinned -------------------------
# If the operator pins only the iface, detection must still fill the phy from
# that iface's grouping (never blank it), and must NOT overwrite the pinned iface.
SYSD="$WORK/sysD"
make_sysfs "$SYSD" phy0
make_iw_stub 'phy#0
	Interface wlp14s0
		type managed'

OUT_D="$(run_detect "$SYSD" 'AP_IFACE=wlp14s0' 2>&1 || true)"
if printf '%s' "$OUT_D" | grep -qE 'IFACE=wlp14s0$'; then
  pass "partial override: pinned AP_IFACE preserved (not overwritten by detection)"
else
  fail "partial override: pinned AP_IFACE was clobbered, got: $OUT_D"
fi

# --- Case E: no wireless hardware — detection leaves values empty, no crash --
# A box with NO phy must not crash the attach; detect leaves AP_IFACE empty and
# the downstream guards (the [ -e /sys/class/ieee80211/$AP_PHY ] check + hostapd
# bring-up) handle the absence. The function must exit 0 (set +e posture) so the
# attach script keeps going.
SYSE="$WORK/sysE"
make_sysfs "$SYSE"   # no phys
make_iw_stub ''      # iw dev returns nothing
if OUT_E="$(run_detect "$SYSE" '' 2>&1)"; then
  if printf '%s' "$OUT_E" | grep -qx 'PHY= IFACE='; then
    pass "no wireless hardware: detection leaves phy/iface empty without crashing"
  else
    fail "no wireless hardware: expected empty PHY/IFACE, got: $OUT_E"
  fi
else
  fail "no wireless hardware: detect_ap_radio exited non-zero (must not abort the attach)"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
