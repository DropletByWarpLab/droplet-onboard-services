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
