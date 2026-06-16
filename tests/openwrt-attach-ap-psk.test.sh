#!/usr/bin/env bash
# =============================================================================
# WARP-819 — unit tests for the per-box AP PSK resolution inside
# scripts/host/usr-local-sbin/droplet-openwrt-attach.
#
# Goal: on first boot of the single-box, the Wi-Fi the user joins must have a
# UNIQUE-per-box password with ZERO prior config. Previously the attach script
# fell back to a SHARED hardcoded PSK (`droplet-default-wifi`) — every box on
# Earth had the same Wi-Fi password. The fix:
#   - honor an explicit DROPLET_AP_PSK env if the operator set a real one;
#   - otherwise GENERATE a strong random PSK ONCE and PERSIST it host-side in a
#     0600 file; on every subsequent boot READ that persisted value (idempotent
#     — the SSID/PSK must be stable across reboots, never regenerated);
#   - mirror the resolved PSK into the device-bridge env so the creds the
#     pairing QR/text shows ALWAYS equal the PSK hostapd actually serves
#     (coherence is an AC).
#
# These tests do NOT require Docker or a running OpenWrt container. The PSK
# resolution is a self-contained POSIX function delimited by sentinel markers;
# we extract it and run it with overridable file paths so we can assert the
# generation, persistence (0600), placeholder rejection, env-mirroring, and
# idempotence (same value across two runs) — all without touching the host.
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
echo "  WARP-819 — droplet-openwrt-attach per-box AP PSK"
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

START_MARK="# >>> resolve_ap_psk (WARP-819)"
END_MARK="# <<< resolve_ap_psk (WARP-819)"

if grep -qF "$START_MARK" "$ATTACH" && grep -qF "$END_MARK" "$ATTACH"; then
  pass "resolve_ap_psk sentinel markers present"
else
  fail "resolve_ap_psk sentinel markers ('$START_MARK' .. '$END_MARK') missing"
fi

if grep -qE "^[[:space:]]*resolve_ap_psk\b" "$ATTACH"; then
  pass "resolve_ap_psk is invoked in the attach body"
else
  fail "resolve_ap_psk is never called in the attach body"
fi

# Guardrail: the shared hardcoded default must be GONE from the live default.
# The literal `droplet-default-wifi` must not survive as the fallback PSK the
# AP comes up with (it may still be NAMED as a placeholder to reject).
if grep -qE 'AP_PSK="\$\{DROPLET_AP_PSK:-droplet-default-wifi\}"' "$ATTACH"; then
  fail "shared hardcoded PSK fallback ':-droplet-default-wifi' still present"
else
  pass "shared hardcoded PSK fallback removed"
fi

# Guardrail: no real generated secret may be committed. The script must
# GENERATE at runtime (openssl/urandom), not embed a literal key.
if grep -qE 'openssl rand|/dev/urandom|tr .*A-Za-z0-9' "$ATTACH"; then
  pass "PSK is generated at runtime (openssl/urandom), not baked in"
else
  fail "no runtime PSK generation found — a per-box secret must be generated, not embedded"
fi

# --- Behavioral: extract + run the function ----------------------------------
echo "--- Phase 2: behavioral run (generation + persistence + coherence) ---"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pull the function body out of the script (it lives in the OUTER host-side
# shell, before the docker exec, since the persisted file is on the host).
sed -n "/$(printf '%s' "$START_MARK" | sed 's/[][\\.*^$/]/\\&/g')/,/$(printf '%s' "$END_MARK" | sed 's/[][\\.*^$/]/\\&/g')/p" \
  "$ATTACH" > "$WORK/func.sh"

if [ -s "$WORK/func.sh" ]; then
  pass "extracted resolve_ap_psk function body"
else
  fail "could not extract function body — skipping behavioral asserts"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS passed"; echo "FAILURES=$FAILURES"
  [ "$FAILURES" -eq 0 ] || exit 1
  exit 0
fi

PSK_FILE="$WORK/ap-psk"
BRIDGE_ENV="$WORK/device-bridge.env"

# run_resolve <explicit-psk-or-empty> — sources the function with the test file
# paths, runs it, and echoes the resolved AP_PSK on stdout so the caller can
# capture it. The function must export/set AP_PSK; we print it from the subshell.
run_resolve() {
  local explicit="$1"
  DROPLET_AP_PSK="$explicit" \
  AP_PSK_FILE="$PSK_FILE" \
  DEVICE_BRIDGE_ENV_FILE="$BRIDGE_ENV" \
  bash -c '
    set -e
    AP_PSK="${DROPLET_AP_PSK:-}"
    # shellcheck disable=SC1090
    . "'"$WORK"'/func.sh"
    resolve_ap_psk
    printf "%s" "$AP_PSK"
  '
}

# --- Fresh box: no env, no persisted file → generate + persist ---------------
rm -f "$PSK_FILE" "$BRIDGE_ENV"
GEN1="$(run_resolve "")"

if [ -n "$GEN1" ]; then
  pass "fresh box with no env generates a non-empty PSK"
else
  fail "fresh box produced an empty PSK"
fi

# Generated PSK must be a valid WPA2 passphrase: 8..63 printable chars. We aim
# tighter (12..20) per the ticket; assert that range.
len="${#GEN1}"
if [ "$len" -ge 12 ] && [ "$len" -le 20 ]; then
  pass "generated PSK length in [12,20] (valid WPA2 passphrase): $len"
else
  fail "generated PSK length $len outside [12,20]"
fi

# It must NOT be the old shared default or a placeholder.
case "$GEN1" in
  droplet-default-wifi|CHANGE_ME_VIA_SETUP_WIZARD|"")
    fail "generated PSK is a shared default/placeholder ('$GEN1')" ;;
  *) pass "generated PSK is neither the shared default nor a placeholder" ;;
esac

# Persisted to the 0600 file.
if [ -f "$PSK_FILE" ]; then
  pass "PSK persisted to the secret file"
else
  fail "PSK was not persisted to \$AP_PSK_FILE"
fi

# File perms are 0600 (owner-only). Two parts:
#  (a) the code MUST invoke `chmod 0600` on the PSK file (static guarantee that
#      works on any real POSIX box, independent of the test host); and
#  (b) when the test host actually HONORS chmod (probe a temp file), assert the
#      resulting mode is 600. On msys/NTFS, chmod is a no-op and stat always
#      reports 644 regardless — there, only (a) is meaningful, so we skip (b)
#      rather than false-fail. The box is Linux and honors both.
if grep -qE 'chmod 0600 "\$psk_file"' "$ATTACH"; then
  pass "code invokes chmod 0600 on the PSK file (POSIX 0600 guarantee)"
else
  fail "code does not chmod 0600 the PSK file — secret could be world-readable"
fi

# Probe: does this host honor chmod at all?
_probe="$WORK/.permprobe"
( umask 077; : > "$_probe" ); chmod 0600 "$_probe" 2>/dev/null || true
if [ "$(stat -c '%a' "$_probe" 2>/dev/null)" = "600" ]; then
  if [ "$(stat -c '%a' "$PSK_FILE" 2>/dev/null)" = "600" ]; then
    pass "PSK file mode is 0600 (host honors chmod)"
  else
    fail "PSK file mode is $(stat -c '%a' "$PSK_FILE" 2>/dev/null), expected 600"
  fi
else
  pass "PSK file mode value check skipped (host filesystem does not honor chmod)"
fi
rm -f "$_probe"

# The persisted file content equals the resolved PSK (coherence at the file).
if [ "$(cat "$PSK_FILE")" = "$GEN1" ]; then
  pass "persisted file content equals the resolved PSK"
else
  fail "persisted file content differs from the resolved PSK"
fi

# Coherence: the device-bridge env was written with the SAME PSK so the QR/text
# the bridge shows matches the PSK hostapd serves.
if grep -qE "^DROPLET_AP_PSK=${GEN1}\$" "$BRIDGE_ENV"; then
  pass "device-bridge env mirrors the resolved PSK (QR/text == live AP creds)"
else
  fail "device-bridge env does not contain DROPLET_AP_PSK=<resolved> — creds could diverge"
fi

# The bridge env holds the PSK too, so it must also be chmod 0600 (static
# guarantee; mode-value asserted only where the host honors chmod, above).
if grep -qE 'chmod 0600 "\$bridge_env"' "$ATTACH"; then
  pass "code invokes chmod 0600 on the device-bridge env (secret protected)"
else
  fail "device-bridge env is not chmod 0600 — PSK could be world-readable"
fi

# --- Idempotence: second run with no env reads the persisted value -----------
echo "--- Phase 3: idempotence (stable across reboots, never regenerated) ---"

GEN2="$(run_resolve "")"
if [ "$GEN2" = "$GEN1" ]; then
  pass "second run with no env returns the SAME persisted PSK (stable across reboots)"
else
  fail "second run regenerated the PSK ('$GEN1' -> '$GEN2') — not idempotent"
fi

# --- Explicit override wins --------------------------------------------------
echo "--- Phase 4: explicit DROPLET_AP_PSK override is honored ---"

rm -f "$PSK_FILE" "$BRIDGE_ENV"
OVERRIDE="operator-set-secret-9"
GOT="$(run_resolve "$OVERRIDE")"
if [ "$GOT" = "$OVERRIDE" ]; then
  pass "explicit DROPLET_AP_PSK is used verbatim"
else
  fail "explicit DROPLET_AP_PSK not honored (got '$GOT')"
fi

# A placeholder/shared value passed as the explicit env must be REJECTED and
# replaced by a generated one (so a stale .env placeholder can't reinstate the
# shared password).
rm -f "$PSK_FILE" "$BRIDGE_ENV"
GOT_PH="$(run_resolve "droplet-default-wifi")"
if [ "$GOT_PH" != "droplet-default-wifi" ] && [ -n "$GOT_PH" ]; then
  pass "placeholder/shared explicit value rejected → generated a real PSK"
else
  fail "placeholder explicit value was accepted ('$GOT_PH') — shared password could persist"
fi

# --- WARP-821: hard-fail when no strong entropy source is available ----------
echo "--- Phase 5: WARP-821 hard-fail on missing strong entropy (no weak PRNG) ---"

# Force BOTH openssl and /dev/urandom reads to fail (shadow the commands), then
# assert resolve_ap_psk exits non-zero and writes NO PSK file — it must refuse
# to emit a weak password rather than fall back to a PRNG.
rm -f "$PSK_FILE" "$BRIDGE_ENV"
hardfail_rc=0
DROPLET_AP_PSK="" \
AP_PSK_FILE="$PSK_FILE" \
DEVICE_BRIDGE_ENV_FILE="$BRIDGE_ENV" \
bash -c '
  openssl() { return 1; }
  head() { return 1; }
  AP_PSK="${DROPLET_AP_PSK:-}"
  # shellcheck disable=SC1090
  . "'"$WORK"'/func.sh"
  resolve_ap_psk
' >/dev/null 2>&1 || hardfail_rc=$?

if [ "$hardfail_rc" -ne 0 ]; then
  pass "no strong entropy source → resolve_ap_psk exits non-zero (refuses weak PSK)"
else
  fail "no strong entropy source → exited 0; must hard-fail, not emit a weak PSK"
fi

if [ ! -f "$PSK_FILE" ]; then
  pass "no PSK file written when no strong entropy source is available"
else
  fail "a PSK file was written without a strong entropy source ('$(cat "$PSK_FILE" 2>/dev/null)')"
fi

# Guardrail: the weak awk-PRNG fallback alphabet must be GONE from the script.
if grep -qF 'abcdefghjkmnpqrstuvwxyz23456789' "$ATTACH"; then
  fail "awk-PRNG fallback alphabet still present (WARP-821 must remove the PRNG fallback)"
else
  pass "awk-PRNG fallback removed from PSK generation"
fi

# --- WARP-835: leading digit is a uniform {2..9} sample, not a biased constant -
echo "--- Phase 6: WARP-835 leading digit sampled uniformly from {2..9} ---"

# Guardrail: the biased fallback is gone. The old code derived the leading digit
# from a `dnum` base64-digit pick and fell back to a constant 7 when it was
# empty/0/1; the replacement samples one byte mod 8 -> {2..9} uniformly (no
# `dnum`, no hardcoded leading digit).
if grep -qE '\bdnum\b' "$ATTACH"; then
  fail "biased leading-digit fallback (dnum + constant) still present"
else
  pass "biased leading-digit fallback removed (uniform sample)"
fi

# Behavioral: across many FRESH generations the first char is ALWAYS a digit in
# [2-9], and it actually varies (not stuck on a single constant value).
leads=""
lead_ok=1
for _i in $(seq 1 20); do
  rm -f "$PSK_FILE" "$BRIDGE_ENV"
  p="$(run_resolve "")"
  c="${p:0:1}"
  case "$c" in
    [2-9]) leads="${leads}${c}" ;;
    *) lead_ok=0; echo "      unexpected leading char '$c' in '$p'" ;;
  esac
done
if [ "$lead_ok" -eq 1 ]; then
  pass "every generated PSK starts with a digit in [2-9]"
else
  fail "a generated PSK started with a char outside [2-9]"
fi
distinct="$(printf '%s' "$leads" | fold -w1 | sort -u | wc -l | tr -d ' ')"
if [ "${distinct:-0}" -ge 2 ]; then
  pass "leading digit varies across draws ($distinct distinct values)"
else
  fail "leading digit constant across 20 draws — not sampling"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
