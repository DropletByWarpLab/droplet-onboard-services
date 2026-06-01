#!/usr/bin/env bash
# =============================================================================
# Unit tests for scripts/lib/systemd.sh — systemd unit generation.
#
# Tests the render_systemd_unit() helper: renders the unit text with fixture
# inputs and asserts every required invariant (WARP-571).
#
# Does NOT require Docker, sudo, or a running stack.
# Runtime: < 2 seconds.
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
echo "  Systemd Unit Generation Tests (WARP-571)"
echo "  ================================================"
echo ""

# =============================================================================
# Phase 0: bash -n syntax check
# =============================================================================
echo "--- Phase 0: bash -n syntax check ---"

SYSTEMD_LIB="$REPO_ROOT_REAL/scripts/lib/systemd.sh"

if bash -n "$SYSTEMD_LIB" 2>/dev/null; then
  pass "scripts/lib/systemd.sh passes bash -n syntax check"
else
  fail "scripts/lib/systemd.sh fails bash -n syntax check"
  echo "  Cannot continue — systemd.sh has syntax errors"
  exit 1
fi

# =============================================================================
# Phase 1: Source the library with stubs
# =============================================================================
echo "--- Phase 1: render_systemd_unit helper ---"

# Set up a minimal fake REPO_ROOT and env vars the library expects
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

FAKE_COMPOSE_FILE="$TMP_ROOT/docker/docker-compose.yml"
mkdir -p "$TMP_ROOT/docker"
touch "$FAKE_COMPOSE_FILE"

# Stub logging functions so sourcing systemd.sh doesn't fail on missing logging.sh
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
log_divider() { :; }

# Export variables the library uses
export REPO_ROOT="$TMP_ROOT"
export COMPOSE_FILE="$FAKE_COMPOSE_FILE"

# Source the library
# shellcheck source=../scripts/lib/systemd.sh
source "$SYSTEMD_LIB"

# Verify render_systemd_unit is defined
if declare -f render_systemd_unit >/dev/null 2>&1; then
  pass "render_systemd_unit function is defined"
else
  fail "render_systemd_unit function is NOT defined (helper not extracted from install_systemd_service)"
  echo "  Cannot continue — render_systemd_unit must exist for the test harness"
  exit 1
fi

# =============================================================================
# Phase 2: Invariant assertions — non-empty COMPOSE_PROFILES
# =============================================================================
echo "--- Phase 2: unit invariants (COMPOSE_PROFILES=linux,display) ---"

# Render the unit with a non-empty profile set
COMPOSE_PROFILES="linux,display"
export COMPOSE_PROFILES

UNIT_TEXT="$(render_systemd_unit "$TMP_ROOT" "$FAKE_COMPOSE_FILE" "dropletuser")"

# Invariant 1: ExecStartPre runs 'config -q' as a preflight
if echo "$UNIT_TEXT" | grep -q "ExecStartPre="; then
  if echo "$UNIT_TEXT" | grep "ExecStartPre=" | grep -q "config"; then
    pass "ExecStartPre present and runs 'config' (compose config preflight)"
  else
    fail "ExecStartPre present but does not run 'config'"
  fi
else
  fail "ExecStartPre is missing (compose config preflight required)"
fi

if echo "$UNIT_TEXT" | grep "ExecStartPre=" | grep -q -- "-q\|--quiet"; then
  pass "ExecStartPre uses quiet flag (-q)"
else
  fail "ExecStartPre missing quiet flag (-q / --quiet)"
fi

# Invariant 2: ExecStart contains --env-file pointing at the .env
if echo "$UNIT_TEXT" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -q -- "--env-file"; then
  pass "ExecStart contains --env-file"
else
  fail "ExecStart missing --env-file"
fi

if echo "$UNIT_TEXT" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -- "--env-file" | grep -q "$TMP_ROOT/.env"; then
  pass "ExecStart --env-file points to <REPO_ROOT>/.env"
else
  fail "ExecStart --env-file does not point to <REPO_ROOT>/.env (got: $(echo "$UNIT_TEXT" | grep "ExecStart=" | grep -v ExecStartPre || true))"
fi

# Invariant 3: ExecStart uses 'up -d'
if echo "$UNIT_TEXT" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -q "up -d"; then
  pass "ExecStart uses 'up -d'"
else
  fail "ExecStart does not use 'up -d'"
fi

# Invariant 4: ExecStart contains --remove-orphans
if echo "$UNIT_TEXT" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -q -- "--remove-orphans"; then
  pass "ExecStart contains --remove-orphans"
else
  fail "ExecStart missing --remove-orphans"
fi

# Invariant 5: ExecStart contains --profile when COMPOSE_PROFILES is non-empty
if echo "$UNIT_TEXT" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -q -- "--profile"; then
  pass "ExecStart contains --profile (profiles: linux,display)"
else
  fail "ExecStart missing --profile when COMPOSE_PROFILES=linux,display"
fi

# Invariant 5a: each comma-split profile is its OWN --profile flag.
# The Compose CLI does NOT comma-split --profile (only the COMPOSE_PROFILES
# env var does), so "--profile linux,display" matches no profile and the
# linux/display services never start. Assert the count of --profile flags
# equals the number of comma-split profiles.
EXEC_START_LINE="$(echo "$UNIT_TEXT" | grep "ExecStart=" | grep -v "ExecStartPre")"
PROFILE_FLAG_COUNT="$(echo "$EXEC_START_LINE" | grep -o -- "--profile" | wc -l | tr -d ' ')"
if [ "$PROFILE_FLAG_COUNT" -eq 2 ]; then
  pass "ExecStart has one --profile per profile (2 flags for linux,display)"
else
  fail "ExecStart has $PROFILE_FLAG_COUNT --profile flag(s); expected 2 (one per comma-split profile)"
fi

# Invariant 5b: no single --profile carries a comma-joined value.
if echo "$EXEC_START_LINE" | grep -qE -- "--profile +[A-Za-z0-9_-]+,[A-Za-z0-9_-]+"; then
  fail "ExecStart has a comma-joined --profile value (e.g. --profile linux,display) — Compose treats it as one profile name"
else
  pass "ExecStart has no comma-joined --profile value"
fi

# Invariant 5c: both expected profile names are present as flags.
if echo "$EXEC_START_LINE" | grep -q -- "--profile linux" \
   && echo "$EXEC_START_LINE" | grep -q -- "--profile display"; then
  pass "ExecStart contains both '--profile linux' and '--profile display'"
else
  fail "ExecStart missing one of '--profile linux' / '--profile display'"
fi

# Invariant 5d: ExecReload mirrors the repeated-flag form too.
RELOAD_PROFILE_COUNT="$(echo "$UNIT_TEXT" | grep "ExecReload=" | grep -o -- "--profile" | wc -l | tr -d ' ')"
if [ "$RELOAD_PROFILE_COUNT" -eq 2 ]; then
  pass "ExecReload has one --profile per profile (2 flags for linux,display)"
else
  fail "ExecReload has $RELOAD_PROFILE_COUNT --profile flag(s); expected 2"
fi

# Invariant 6: ExecReload uses 'up -d --force-recreate' (NOT bare restart)
if echo "$UNIT_TEXT" | grep "ExecReload=" | grep -q -- "--force-recreate"; then
  pass "ExecReload uses --force-recreate"
else
  fail "ExecReload missing --force-recreate"
fi

if echo "$UNIT_TEXT" | grep "ExecReload=" | grep -q "up -d"; then
  pass "ExecReload uses 'up -d' (not bare restart)"
else
  fail "ExecReload does not use 'up -d'"
fi

# Invariant 7: ExecReload must NOT be a bare 'docker compose ... restart'
# (CLAUDE.md explicitly documents restart as NOT re-reading env_file)
if echo "$UNIT_TEXT" | grep "ExecReload=" | grep -qE "compose .* restart$|compose .*restart[[:space:]]*$"; then
  fail "ExecReload uses bare 'restart' — this does NOT re-read env_file (WARP-571)"
else
  pass "ExecReload does NOT use bare 'restart'"
fi

# Invariant 8: ExecReload also contains --env-file
if echo "$UNIT_TEXT" | grep "ExecReload=" | grep -q -- "--env-file"; then
  pass "ExecReload contains --env-file"
else
  fail "ExecReload missing --env-file"
fi

# Invariant 9: ExecStop is present (regression guard — must not have been lost)
if echo "$UNIT_TEXT" | grep -q "ExecStop="; then
  pass "ExecStop is present"
else
  fail "ExecStop is missing (regression — was present before fix)"
fi

# Invariant 10: EnvironmentFile is present (belt + suspenders for process env)
if echo "$UNIT_TEXT" | grep -q "EnvironmentFile="; then
  pass "EnvironmentFile is present"
else
  fail "EnvironmentFile is missing"
fi

# Invariant 11: absolute path for compose file in ExecStart
if echo "$UNIT_TEXT" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -- "-f" | grep -q "$FAKE_COMPOSE_FILE"; then
  pass "ExecStart uses absolute path for compose file (-f)"
else
  fail "ExecStart does not use absolute path for compose file"
fi

# Invariant 12: [Unit] ordering — After=docker.service network-online.target
if echo "$UNIT_TEXT" | grep -q "^After=docker.service network-online.target"; then
  pass "After=docker.service network-online.target is present"
else
  fail "After=docker.service network-online.target missing/incorrect"
fi

# Invariant 13: [Service] is a oneshot that stays active
if echo "$UNIT_TEXT" | grep -q "^Type=oneshot"; then
  pass "Type=oneshot is present"
else
  fail "Type=oneshot missing (boot start would not run to completion correctly)"
fi

if echo "$UNIT_TEXT" | grep -q "^RemainAfterExit=yes"; then
  pass "RemainAfterExit=yes is present"
else
  fail "RemainAfterExit=yes missing (oneshot would report inactive after start)"
fi

# Invariant 14: User= is the explicit non-root user passed to the renderer
if echo "$UNIT_TEXT" | grep -q "^User=dropletuser"; then
  pass "User= reflects the explicit run_user argument (not ambient \$USER)"
else
  fail "User= does not reflect the explicit run_user argument (got: $(echo "$UNIT_TEXT" | grep '^User=' || true))"
fi

# Invariant 15: render is idempotent — same inputs produce byte-identical output
UNIT_TEXT_AGAIN="$(render_systemd_unit "$TMP_ROOT" "$FAKE_COMPOSE_FILE" "dropletuser")"
if [ "$UNIT_TEXT" = "$UNIT_TEXT_AGAIN" ]; then
  pass "render_systemd_unit is idempotent for identical inputs"
else
  fail "render_systemd_unit produced different output for identical inputs"
fi

# Invariant 16: run_user is required — calling without it must fail.
if ( render_systemd_unit "$TMP_ROOT" "$FAKE_COMPOSE_FILE" >/dev/null 2>&1 ); then
  fail "render_systemd_unit succeeded without a run_user arg (should be required)"
else
  pass "render_systemd_unit rejects a missing run_user argument"
fi

# =============================================================================
# Phase 3: empty COMPOSE_PROFILES (macOS / default-only)
# =============================================================================
echo "--- Phase 3: unit invariants (COMPOSE_PROFILES empty) ---"

COMPOSE_PROFILES=""
export COMPOSE_PROFILES

UNIT_TEXT_EMPTY="$(render_systemd_unit "$TMP_ROOT" "$FAKE_COMPOSE_FILE" "dropletuser")"

# With empty profiles, ExecStart should NOT have '--profile ""' (bad syntax)
# It may either omit --profile entirely or use no-profile form.
# Key: 'up -d' and '--env-file' must still be present.
if echo "$UNIT_TEXT_EMPTY" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -q -- "--env-file"; then
  pass "ExecStart still has --env-file when COMPOSE_PROFILES is empty"
else
  fail "ExecStart lost --env-file when COMPOSE_PROFILES is empty"
fi

if echo "$UNIT_TEXT_EMPTY" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -q "up -d"; then
  pass "ExecStart still has 'up -d' when COMPOSE_PROFILES is empty"
else
  fail "ExecStart lost 'up -d' when COMPOSE_PROFILES is empty"
fi

if echo "$UNIT_TEXT_EMPTY" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -- "--profile" | grep -q '""'; then
  fail "ExecStart has '--profile \"\"' (empty-string profile arg) — bad syntax"
else
  pass "ExecStart does not have '--profile \"\"' (empty profiles handled cleanly)"
fi

# With empty profiles, NO --profile flag should be emitted at all.
if echo "$UNIT_TEXT_EMPTY" | grep "ExecStart=" | grep -v "ExecStartPre" | grep -q -- "--profile"; then
  fail "ExecStart emits a --profile flag when COMPOSE_PROFILES is empty"
else
  pass "ExecStart omits --profile entirely when COMPOSE_PROFILES is empty"
fi

# ExecReload must also stay correct with empty profiles
if echo "$UNIT_TEXT_EMPTY" | grep "ExecReload=" | grep -q -- "--force-recreate"; then
  pass "ExecReload still has --force-recreate when COMPOSE_PROFILES is empty"
else
  fail "ExecReload lost --force-recreate when COMPOSE_PROFILES is empty"
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
