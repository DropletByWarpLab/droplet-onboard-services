#!/usr/bin/env bash
# =============================================================================
# Unit tests for setup.sh: secret generation and compose.sh psql configuration.
#
# Does NOT require Docker or a running stack.
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  Setup Unit Tests"
echo "  ================================================"
echo ""

# =============================================================================
# Phase 1: Static analysis — compose.sh psql configuration
# =============================================================================
echo "--- Phase 1: compose.sh psql configuration ---"

COMPOSE_LIB="$REPO_ROOT_REAL/scripts/lib/compose.sh"

# PGPASSWORD must be forwarded via -e into docker compose exec so psql
# does not fall back to prompting interactively.
if grep -q "\-e PGPASSWORD" "$COMPOSE_LIB"; then
  pass "compose.sh passes PGPASSWORD via -e to docker compose exec"
else
  fail "compose.sh missing '-e PGPASSWORD' — psql will prompt for password interactively"
fi

# psql -w (--no-password) prevents interactive prompts even as a failsafe.
if grep "psql" "$COMPOSE_LIB" | grep -qE "\s-w\b|\s-w[a-z]|-[a-z]*w[a-z]*\b"; then
  pass "compose.sh psql uses -w (no-password flag)"
else
  fail "compose.sh psql missing -w flag — password prompt possible if PGPASSWORD unset"
fi

# =============================================================================
# Phase 2: generate_env unit tests (no Docker)
# =============================================================================
echo "--- Phase 2: generate_env ---"

# Set up an isolated temp repo root with a copy of .env.example
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

cp "$REPO_ROOT_REAL/.env.example" "$TMP_ROOT/.env.example"
mkdir -p "$TMP_ROOT/.data"

# Source logging (safe: only defines functions and color vars)
export REPO_ROOT="$TMP_ROOT"
LOG_FILE="$TMP_ROOT/.data/setup.log"
export LOG_FILE
# shellcheck source=../scripts/lib/logging.sh
source "$REPO_ROOT_REAL/scripts/lib/logging.sh"

# Stub out Docker/openssl-dependent helpers before sourcing secrets.sh
_generate_mosquitto_passwd() { return 0; }
_write_mosquitto_conf()       { return 0; }
_generate_tls_cert()          { return 0; }

# shellcheck source=../scripts/lib/secrets.sh
source "$REPO_ROOT_REAL/scripts/lib/secrets.sh"

# Re-stub after sourcing secrets.sh (it defines these functions — override them)
_generate_mosquitto_passwd() { return 0; }
_write_mosquitto_conf()       { return 0; }
_generate_tls_cert()          { return 0; }

# Run generate_env
if generate_env >/dev/null 2>&1; then
  pass "generate_env completed without error"
else
  fail "generate_env exited with an error"
  echo "  Cannot continue — generate_env failed"
  exit 1
fi

# .env was created
if [ -f "$TMP_ROOT/.env" ]; then
  pass ".env file created"
else
  fail ".env file not created"
  exit 1
fi

# No 'change-me' placeholders remain
if ! grep -q "change-me" "$TMP_ROOT/.env"; then
  pass "No 'change-me' placeholders in generated .env"
else
  fail "Generated .env still contains 'change-me' placeholders:"
  grep "change-me" "$TMP_ROOT/.env" | while IFS= read -r line; do
    printf "    %s\n" "$line"
  done
fi

# POSTGRES_PASSWORD is non-empty
PG_PASS=$(grep "^POSTGRES_PASSWORD=" "$TMP_ROOT/.env" | cut -d= -f2-)
if [ -n "$PG_PASS" ]; then
  pass "POSTGRES_PASSWORD is set (${PG_PASS:0:4}****)"
else
  fail "POSTGRES_PASSWORD is empty in generated .env"
fi

# DATABASE_URL contains the generated password
DB_URL=$(grep "^DATABASE_URL=" "$TMP_ROOT/.env" | cut -d= -f2-)
if echo "$DB_URL" | grep -qF "$PG_PASS"; then
  pass "DATABASE_URL contains the generated POSTGRES_PASSWORD"
else
  fail "DATABASE_URL does not match POSTGRES_PASSWORD (password mismatch)"
fi

# .env permissions are 600
PERMS=$(stat -c "%a" "$TMP_ROOT/.env" 2>/dev/null || stat -f "%OLp" "$TMP_ROOT/.env" 2>/dev/null || echo "unknown")
if [ "$PERMS" = "600" ]; then
  pass ".env has restricted permissions (600)"
else
  fail ".env permissions are $PERMS (expected 600)"
fi

# generate_env is idempotent — second call keeps existing secrets
PG_PASS_FIRST="$PG_PASS"
if generate_env >/dev/null 2>&1; then
  PG_PASS_SECOND=$(grep "^POSTGRES_PASSWORD=" "$TMP_ROOT/.env" | cut -d= -f2-)
  if [ "$PG_PASS_FIRST" = "$PG_PASS_SECOND" ]; then
    pass "generate_env is idempotent (second call keeps existing secrets)"
  else
    fail "generate_env regenerated secrets on second call (not idempotent)"
  fi
else
  fail "generate_env failed on second call"
fi

# =============================================================================
# Phase 3: single-box .env knobs — configure_single_box_env (WARP-654 follow-up)
# =============================================================================
echo "--- Phase 3: configure_single_box_env (single-box knobs) ---"

# lib/single-box.sh is a sourceable lib (functions only; no top-level run).
# logging.sh is already sourced above, and REPO_ROOT + a generated .env exist
# from Phase 2 — so configure_single_box_env has everything it needs.
# shellcheck source=../scripts/lib/single-box.sh
source "$REPO_ROOT_REAL/scripts/lib/single-box.sh"

if configure_single_box_env >/dev/null 2>&1; then
  pass "configure_single_box_env completed without error"
else
  fail "configure_single_box_env exited with an error"
fi

# The single-box shape runs the AP as a host hostapd (not a Pi-5 UCI router),
# so the device-bridge must read pairing-QR creds in hostapd mode. The install
# records that as a .env knob; install-device-bridge.sh mirrors it into
# /etc/droplet/device-bridge.env, where device-bridge.py reads it (it defaults
# to uci otherwise — multi-box). WARP-654 / PR #471 follow-up.
AP_MODE_COUNT=$(grep -cE '^DROPLET_AP_MODE=hostapd$' "$TMP_ROOT/.env" || true)
if [ "$AP_MODE_COUNT" = "1" ]; then
  pass "configure_single_box_env sets DROPLET_AP_MODE=hostapd (single occurrence)"
else
  fail "expected exactly one 'DROPLET_AP_MODE=hostapd' in .env, found ${AP_MODE_COUNT}"
fi

# Sanity: the knob block ran (COMPOSE_PROFILES merged to include single-box).
if grep -E '^COMPOSE_PROFILES=' "$TMP_ROOT/.env" | tail -1 | grep -q 'single-box'; then
  pass "COMPOSE_PROFILES includes single-box"
else
  fail "COMPOSE_PROFILES does not include single-box after configure_single_box_env"
fi

# Idempotent — a second call must not duplicate the AP-mode knob.
configure_single_box_env >/dev/null 2>&1 || true
AP_MODE_COUNT2=$(grep -cE '^DROPLET_AP_MODE=hostapd$' "$TMP_ROOT/.env" || true)
if [ "$AP_MODE_COUNT2" = "1" ]; then
  pass "configure_single_box_env is idempotent for DROPLET_AP_MODE (no duplicate)"
else
  fail "DROPLET_AP_MODE duplicated/changed on second call (found ${AP_MODE_COUNT2})"
fi

# --- Shape-aware CAMERA_SUBNET (ADR-018 Decision 4 / T5) ------------------
# The compose default CAMERA_SUBNET is 192.168.100.0/24 — the multi-box
# OpenWrt camera VLAN (openwrt/files/etc/config/dhcp `cameras`). On the
# single-box shape the cameras live on the box's own LAN (br-lan,
# 192.168.20.0/24 per scripts/host/etc-droplet-poc-host-net/lan-dhcp.conf),
# NOT on a separate VLAN — so the multi-box default would scan an empty
# subnet and find nothing (the live "camera scan finds nothing" symptom).
# configure_single_box_env must pin CAMERA_SUBNET to the single-box camera
# network so camera-discovery scans where the cameras actually are.
# Two calls already ran above, so this also asserts idempotency.
CAM_SUBNET_COUNT=$(grep -cE '^CAMERA_SUBNET=192\.168\.20\.0/24$' "$TMP_ROOT/.env" || true)
if [ "$CAM_SUBNET_COUNT" = "1" ]; then
  pass "configure_single_box_env sets CAMERA_SUBNET=192.168.20.0/24 (single occurrence, idempotent)"
else
  fail "expected exactly one 'CAMERA_SUBNET=192.168.20.0/24' in .env, found ${CAM_SUBNET_COUNT}"
fi

# The last-wins CAMERA_SUBNET (what docker-compose env_file actually uses)
# must be the single-box network, not the inherited multi-box default. This
# guards against an append-without-strip regression that would leave the
# 192.168.100.0/24 default as the effective value.
CAM_SUBNET_EFFECTIVE=$( { grep -E '^CAMERA_SUBNET=' "$TMP_ROOT/.env" || true; } | tail -1 | cut -d= -f2-)
if [ "$CAM_SUBNET_EFFECTIVE" = "192.168.20.0/24" ]; then
  pass "effective (last-wins) CAMERA_SUBNET is the single-box network 192.168.20.0/24"
else
  fail "effective CAMERA_SUBNET is '${CAM_SUBNET_EFFECTIVE}' (expected 192.168.20.0/24)"
fi

# ADR-018 item 9: single-box enables switch bring-up auto-provisioning in the
# flat-lan profile (NOT segmented — single-box has no inter-VLAN routing yet,
# item 3). Assert both knobs are written exactly once and stay idempotent
# across the second call above (no duplicate, value unchanged).
SWITCH_AP_COUNT=$(grep -cE '^SWITCH_AUTOPROVISION=1$' "$TMP_ROOT/.env" || true)
if [ "$SWITCH_AP_COUNT" = "1" ]; then
  pass "configure_single_box_env sets SWITCH_AUTOPROVISION=1 (single, idempotent)"
else
  fail "expected exactly one 'SWITCH_AUTOPROVISION=1' in .env, found ${SWITCH_AP_COUNT}"
fi

SWITCH_PROFILE_COUNT=$(grep -cE '^SWITCH_VLAN_PROFILE=flat-lan$' "$TMP_ROOT/.env" || true)
if [ "$SWITCH_PROFILE_COUNT" = "1" ]; then
  pass "configure_single_box_env sets SWITCH_VLAN_PROFILE=flat-lan (single, idempotent)"
else
  fail "expected exactly one 'SWITCH_VLAN_PROFILE=flat-lan' in .env, found ${SWITCH_PROFILE_COUNT}"
fi

# Camera-safety guard: single-box must NEVER bake the segmented profile (it
# would isolate the camera VLAN and cut the working camera + Frigate off).
if grep -qE '^SWITCH_VLAN_PROFILE=segmented$' "$TMP_ROOT/.env"; then
  fail "single-box .env must not set SWITCH_VLAN_PROFILE=segmented (camera-isolation hazard)"
else
  pass "single-box .env does not enable segmented isolation (camera-safe)"
fi

# Rule 12: no host-specific default baked for the protected/uplink port.
if grep -qE '^SWITCH_PROTECTED_PORT=[1-9]' "$TMP_ROOT/.env"; then
  fail "single-box .env must not bake a host-specific SWITCH_PROTECTED_PORT value"
else
  pass "single-box .env does not bake a host-specific SWITCH_PROTECTED_PORT (rule 12)"
fi

# =============================================================================
# Phase 4: install-device-bridge.sh provisions host pairing-QR deps (WARP-654)
# =============================================================================
echo "--- Phase 4: install-device-bridge.sh host deps + AP mode ---"

BRIDGE_INSTALL="$REPO_ROOT_REAL/scripts/install-device-bridge.sh"

# Privileged linear script — not executed in unit tests, but its syntax must
# be valid and its provisioning intent must be present (Phase-1-style static
# assertions; behavioural coverage of the env write lives in Phase 3 above).
if bash -n "$BRIDGE_INSTALL" 2>/dev/null; then
  pass "install-device-bridge.sh passes bash -n syntax check"
else
  fail "install-device-bridge.sh has a bash syntax error"
fi

# (1) The host /usr/bin/python3 that runs droplet-device-bridge.service must be
# able to import qrcode for the pairing-QR render (device-bridge.py imports it
# lazily in the /openwrt/qr path). The installer must provision python3-qrcode.
if grep -q 'python3-qrcode' "$BRIDGE_INSTALL"; then
  pass "install-device-bridge.sh provisions python3-qrcode for the host bridge"
else
  fail "install-device-bridge.sh does not provision python3-qrcode (GET /openwrt/qr -> 'No module named qrcode')"
fi

# (2) It must verify qrcode is importable by the bridge's python so a fresh box
# surfaces a clear failure instead of a silently broken QR endpoint.
if grep -qE 'import qrcode' "$BRIDGE_INSTALL"; then
  pass "install-device-bridge.sh verifies qrcode is importable"
else
  fail "install-device-bridge.sh does not verify qrcode importability"
fi

# (3) Single-box uses hostapd, not a UCI router. The installer must mirror
# DROPLET_AP_MODE from the repo .env into the bridge env via set_env_if_blank
# (never clobbering an operator override). Multi-box leaves it unset, so the
# bridge keeps its uci default.
if grep -qE 'set_env_if_blank "DROPLET_AP_MODE"' "$BRIDGE_INSTALL"; then
  pass "install-device-bridge.sh mirrors DROPLET_AP_MODE into the bridge env"
else
  fail "install-device-bridge.sh does not mirror DROPLET_AP_MODE from .env"
fi

# (4) The old 'no host pip deps to gate on' claim is untrue now that the
# pairing-QR render is a shipping feature with a host dep; the comment must not
# assert there are zero host deps (guard rule 12 — no untruthful docstrings).
if grep -q 'no host pip deps to gate on' "$BRIDGE_INSTALL"; then
  fail "install-device-bridge.sh still claims 'no host pip deps to gate on' (stale after WARP-654 QR feature)"
else
  pass "install-device-bridge.sh comment no longer claims zero host pip deps"
fi

# =============================================================================
# Phase 5: camera-discovery is part of the single-box shape (ADR-018 T5)
# =============================================================================
# Static assertion on docker/docker-compose.yml: the camera-discovery service
# must be reachable on the single-box deployment, which activates the
# COMPOSE_PROFILES set { linux, display, single-box } (see Phase 3 +
# scripts/lib/single-box.sh). The service was previously gated to `full`
# ONLY, which the single-box never activates — so no camera-discovery
# container ran and the camera scan found nothing (the live symptom #5 root
# cause). A compose service runs when ANY of its profiles is active, so the
# fix is to add `single-box` to the service's profile list (NOT to drop the
# profile guard, which would force it onto macOS dev installs).
echo "--- Phase 5: camera-discovery enabled on single-box (compose profile) ---"

COMPOSE_FILE_REAL="$REPO_ROOT_REAL/docker/docker-compose.yml"

# Extract the `profiles:` line that belongs to the camera-discovery service.
# The service block starts at `  camera-discovery:` and ends at the next
# top-level (2-space-indented) service key. awk captures the profiles line
# within that window.
CAM_PROFILES_LINE=$(awk '
  /^  camera-discovery:[[:space:]]*$/ { in_svc=1; next }
  in_svc && /^  [a-z]/               { in_svc=0 }
  in_svc && /^[[:space:]]+profiles:/ { print; exit }
' "$COMPOSE_FILE_REAL")

if printf '%s' "$CAM_PROFILES_LINE" | grep -q 'single-box'; then
  pass "camera-discovery profiles include single-box (runs on the single-box shape)"
else
  fail "camera-discovery profiles do NOT include single-box — orphaned on single-box (found: '${CAM_PROFILES_LINE}')"
fi

# Defence against scope-creep / regression: the service must STILL keep the
# `full` profile so the multi-box / explicit-full path is unchanged.
if printf '%s' "$CAM_PROFILES_LINE" | grep -q 'full'; then
  pass "camera-discovery still keeps the full profile (multi-box path unchanged)"
else
  fail "camera-discovery lost the full profile (regressed the multi-box/full path)"
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ $FAILURES -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit $FAILURES
