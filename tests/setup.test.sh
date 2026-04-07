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
