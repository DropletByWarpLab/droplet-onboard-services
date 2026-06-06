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

# File perms are 0640 (owner-rw, GROUP-read), group droplet. WARP-819 finding 1:
# the device-bridge.service runs `User=droplet`/`Group=droplet` and reads this
# file directly via _read_persisted_psk(); a 0600 root-owned file gave the bridge
# a swallowed PermissionError (-> "" -> broken coherence fallback during the boot
# race). The fix is `chgrp droplet` + `chmod 0640` so the bridge's group can read
# it while it stays unreadable to other/world. Two parts as before:
#  (a) the code MUST invoke `chgrp droplet` + `chmod 0640` on the PSK file
#      (static guarantee, host-independent); and
#  (b) where the host HONORS chmod, assert the resulting mode is 640. On
#      msys/NTFS chmod is a no-op, so (b) is skipped there rather than false-fail.
if grep -qE 'chmod 0640 "\$psk_file"' "$ATTACH"; then
  pass "code invokes chmod 0640 on the PSK file (group-readable for the bridge)"
else
  fail "code does not chmod 0640 the PSK file — bridge (User=droplet) can't read it"
fi

# It must NOT still be 0600 (that's the bug — bridge can't read a root-only file).
if grep -qE 'chmod 0600 "\$psk_file"' "$ATTACH"; then
  fail "PSK file is still chmod 0600 — bridge group 'droplet' cannot read it"
else
  pass "PSK file is no longer chmod 0600 (the un-readable-by-bridge bug is gone)"
fi

# And the group must be set to droplet so the bridge's primary group can read it.
if grep -qE 'chgrp droplet "\$psk_file"' "$ATTACH"; then
  pass "code chgrp's the PSK file to droplet (bridge group can read it)"
else
  fail "code does not chgrp the PSK file to droplet — 0640 alone won't help the bridge"
fi

# Probe: does this host honor chmod at all?
_probe="$WORK/.permprobe"
( umask 077; : > "$_probe" ); chmod 0640 "$_probe" 2>/dev/null || true
if [ "$(stat -c '%a' "$_probe" 2>/dev/null)" = "640" ]; then
  if [ "$(stat -c '%a' "$PSK_FILE" 2>/dev/null)" = "640" ]; then
    pass "PSK file mode is 0640 (host honors chmod)"
  else
    fail "PSK file mode is $(stat -c '%a' "$PSK_FILE" 2>/dev/null), expected 640"
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
# the bridge shows matches the PSK hostapd serves. The value is single-quoted
# now (WARP-819 finding 5) so an operator passphrase with spaces survives; we
# assert the SOURCED value (what systemd/EnvironmentFile exposes to the bridge)
# equals the resolved PSK, which is correct for both quoted and bare forms.
SOURCED_GEN1="$(
  bash -c '
    # shellcheck disable=SC1090
    . "'"$BRIDGE_ENV"'" 2>/dev/null || true
    printf "%s" "${DROPLET_AP_PSK:-}"
  ' 2>/dev/null
)"
if [ "$SOURCED_GEN1" = "$GEN1" ]; then
  pass "device-bridge env mirrors the resolved PSK (QR/text == live AP creds)"
else
  fail "device-bridge env DROPLET_AP_PSK ('$SOURCED_GEN1') != resolved ('$GEN1') — creds could diverge"
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

# --- Phase 5: operator PSK with spaces survives the env mirror ---------------
# WARP-819 finding 5: the device-bridge env is consumed via systemd
# `EnvironmentFile=` (shell-like quoting). An UNQUOTED `DROPLET_AP_PSK=<value>`
# line splits an operator passphrase containing spaces. The mirror must
# quote/escape the value so it round-trips intact. We assert by SOURCING the
# written env file (the closest shell-equivalent of EnvironmentFile parsing)
# and checking the variable equals the original — and that no stray second
# token leaked onto the line.
echo "--- Phase 5: operator PSK with whitespace survives the env mirror ---"

rm -f "$PSK_FILE" "$BRIDGE_ENV"
SPACED='my secret pass 9'
GOT_SP="$(run_resolve "$SPACED")"
if [ "$GOT_SP" = "$SPACED" ]; then
  pass "spaced operator PSK is resolved verbatim"
else
  fail "spaced operator PSK not honored (got '$GOT_SP')"
fi

# Source the env file and confirm the value comes back whole (spaces intact).
# Run in a child bash WITHOUT set -e and swallow stderr so a bare unquoted line
# (the bug — `DROPLET_AP_PSK=my secret pass 9` runs `secret` as a command)
# degrades to a failed assertion here rather than aborting the whole suite.
SOURCED="$(
  bash -c '
    # shellcheck disable=SC1090
    . "'"$BRIDGE_ENV"'" 2>/dev/null || true
    printf "%s" "${DROPLET_AP_PSK:-}"
  ' 2>/dev/null
)"
if [ "$SOURCED" = "$SPACED" ]; then
  pass "device-bridge env round-trips a spaced PSK intact (no whitespace split)"
else
  fail "device-bridge env mangled the spaced PSK: '$SOURCED' != '$SPACED'"
fi

# The raw mirror line must not be the bare unquoted form (which is the bug).
if grep -qE "^DROPLET_AP_PSK=my secret pass 9\$" "$BRIDGE_ENV"; then
  fail "device-bridge env wrote a bare unquoted spaced value (will split on whitespace)"
else
  pass "device-bridge env spaced value is quoted/escaped, not bare"
fi

# An operator PSK with an EMBEDDED single quote must also round-trip (the
# escaping must not corrupt it). Edge, but cheap to lock down.
rm -f "$PSK_FILE" "$BRIDGE_ENV"
QUOTED_PSK="o'reilly secret 9"
GOT_Q="$(run_resolve "$QUOTED_PSK")"
SOURCED_Q="$(
  bash -c '
    # shellcheck disable=SC1090
    . "'"$BRIDGE_ENV"'" 2>/dev/null || true
    printf "%s" "${DROPLET_AP_PSK:-}"
  ' 2>/dev/null
)"
if [ "$GOT_Q" = "$QUOTED_PSK" ] && [ "$SOURCED_Q" = "$QUOTED_PSK" ]; then
  pass "operator PSK with an embedded single quote round-trips through the env mirror"
else
  fail "embedded-quote PSK mangled: resolved='$GOT_Q' sourced='$SOURCED_Q' want='$QUOTED_PSK'"
fi

# --- Phase 6: silent PSK-write failures are surfaced -------------------------
# WARP-819 finding 7: the persist block guarded every step with `|| true`, so a
# write failure (e.g. read-only /etc) was SILENT — a different generated PSK
# next boot with no breadcrumb. The script must WARN to stderr when the persist
# write fails, mirroring the OPENWRT_ROOT_PW / firewall warns already in place.
echo "--- Phase 6: persist write failure is not silent ---"

if grep -qE 'WARN.*(persist|PSK|ap-psk)' "$ATTACH"; then
  pass "script warns (stderr) when the PSK persist write fails"
else
  fail "no persist-failure warning found — a failed write would be silent"
fi

# Behavioral: when the host honors chmod, point the resolver at an UNWRITABLE
# directory and assert it emits a warning rather than dying silently.
_probe2="$WORK/.permprobe2"
( umask 077; : > "$_probe2" ); chmod 0400 "$_probe2" 2>/dev/null || true
if [ "$(stat -c '%a' "$_probe2" 2>/dev/null)" = "400" ]; then
  RO_DIR="$WORK/ro"
  mkdir -p "$RO_DIR"
  chmod 0500 "$RO_DIR" 2>/dev/null || true
  WARN_OUT="$(
    DROPLET_AP_PSK="" \
    AP_PSK_FILE="$RO_DIR/ap-psk" \
    DEVICE_BRIDGE_ENV_FILE="$RO_DIR/device-bridge.env" \
    bash -c '
      AP_PSK="${DROPLET_AP_PSK:-}"
      # shellcheck disable=SC1090
      . "'"$WORK"'/func.sh"
      resolve_ap_psk
    ' 2>&1 1>/dev/null || true
  )"
  chmod 0700 "$RO_DIR" 2>/dev/null || true
  if printf '%s' "$WARN_OUT" | grep -qiE 'warn|fail|persist'; then
    pass "unwritable PSK dir emits a stderr warning (not silent)"
  else
    fail "unwritable PSK dir produced no warning: '$WARN_OUT'"
  fi
else
  pass "write-failure behavioral check skipped (host does not honor chmod)"
fi
rm -f "$_probe2"

echo ""
echo "  $((TESTS - FAILURES))/$TESTS checks passed"
if [ "$FAILURES" -ne 0 ]; then
  echo "  RESULT: FAIL ($FAILURES failing)"
  exit 1
fi
echo "  RESULT: PASS"
