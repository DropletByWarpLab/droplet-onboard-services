#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — Security Regression Tests
# =============================================================================
#
# Static checks that validate security invariants in source files.
# No Docker or running services required — safe to run in CI or locally.
#
# Usage:
#   ./scripts/test-security.sh
#
# Exit code 0 = all checks passed, 1 = one or more failed.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
COMPOSE_SH="$REPO_ROOT/scripts/lib/compose.sh"

# --- Colors ---
if [ -t 1 ]; then
  _GREEN='\033[0;32m'; _RED='\033[0;31m'; _BOLD='\033[1m'; _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _BOLD=''; _RESET=''
fi

PASS=0
FAIL=0

pass() { printf "  ${_GREEN}PASS${_RESET}  %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ${_RED}FAIL${_RESET}  %s\n" "$1"; FAIL=$((FAIL + 1)); }

SECRET_VARS="POSTGRES_PASSWORD REDIS_PASSWORD MQTT_PASSWORD NEXTCLOUD_ADMIN_PASSWORD DEVICE_SECRET DEVICE_SECRET_KEY"

# =============================================================================
# Test 1: Compose file contains NO :? patterns (always parseable)
# =============================================================================
# The compose file must NEVER use ${VAR:?error} syntax, which makes it
# unparseable when .env is missing. All validation is in _validate_env().

if grep -qE '\$\{[A-Z_]+:\?' "$COMPOSE_FILE"; then
  fail "docker-compose.yml: contains :? patterns — must use :- or env_file only"
else
  pass "docker-compose.yml: no :? patterns (always parseable)"
fi

# =============================================================================
# Test 2: No non-empty secret defaults in compose
# =============================================================================
# Secret variables must NOT have non-empty fallback defaults in compose.
# ${POSTGRES_PASSWORD:-} (empty) is OK. ${POSTGRES_PASSWORD:-secret} is NOT.
# The only safe patterns are: env_file delivery, or ${VAR:-} (empty default).

for var in $SECRET_VARS; do
  # Match ${VAR:-X} where X is at least one non-} character (a real default)
  if grep -qE "\\\$\{${var}:-[^}]+" "$COMPOSE_FILE"; then
    fail "docker-compose.yml: ${var} has non-empty fallback (insecure)"
  else
    pass "docker-compose.yml: ${var} has no hardcoded fallback"
  fi
done

# =============================================================================
# Test 3: Validation function covers all secrets
# =============================================================================
# compose.sh must define REQUIRED_ENV_VARS containing all secret variable names.
# This is the single source of truth for env validation.

if grep -q '_validate_env()' "$COMPOSE_SH"; then
  pass "compose.sh: _validate_env() function exists"
else
  fail "compose.sh: _validate_env() function is missing"
fi

for var in $SECRET_VARS; do
  if grep -q "$var" "$COMPOSE_SH"; then
    pass "compose.sh: ${var} is in REQUIRED_ENV_VARS"
  else
    fail "compose.sh: ${var} is NOT in REQUIRED_ENV_VARS"
  fi
done

# =============================================================================
# Test 4: All docker compose calls use --env-file
# =============================================================================
# Docker Compose must receive --env-file explicitly because the sudo fallback
# in run_docker_compose() strips shell environment variables (env_reset).

compose_calls=$(grep -n 'run_docker_compose' "$COMPOSE_SH" || true)
missing_env_file=false

while IFS= read -r line; do
  [ -z "$line" ] && continue
  if ! echo "$line" | grep -q '\-\-env-file'; then
    lineno=$(echo "$line" | cut -d: -f1)
    fail "compose.sh line $lineno: run_docker_compose missing --env-file"
    missing_env_file=true
  fi
done <<< "$compose_calls"

if [ "$missing_env_file" = false ]; then
  pass "compose.sh: all run_docker_compose calls include --env-file"
fi

# Verify COMPOSE_ENV_FILE is defined pointing to .env
if grep -q 'COMPOSE_ENV_FILE=.*\.env' "$COMPOSE_SH"; then
  pass "compose.sh: COMPOSE_ENV_FILE is defined"
else
  fail "compose.sh: COMPOSE_ENV_FILE is not defined"
fi

# Every docker compose invocation in verify.sh must also include --env-file.
VERIFY_SH="$REPO_ROOT/scripts/verify.sh"
verify_calls=$(grep -nE '(_docker_compose|docker compose) -f' "$VERIFY_SH" | grep -v 'printf' || true)
missing_verify=false

while IFS= read -r line; do
  [ -z "$line" ] && continue
  if ! echo "$line" | grep -q '\-\-env-file'; then
    lineno=$(echo "$line" | cut -d: -f1)
    fail "verify.sh line $lineno: docker compose call missing --env-file"
    missing_verify=true
  fi
done <<< "$verify_calls"

if [ "$missing_verify" = false ]; then
  pass "verify.sh: all docker compose calls include --env-file"
fi

# =============================================================================
# Test 5: .env.example exists with placeholder values
# =============================================================================

ENV_EXAMPLE="$REPO_ROOT/.env.example"

if [ -f "$ENV_EXAMPLE" ]; then
  pass ".env.example exists in repo"
else
  fail ".env.example is missing from repo"
fi

if [ -f "$ENV_EXAMPLE" ]; then
  PASSWORD_LINES=$(grep -E '(PASSWORD|SECRET)=' "$ENV_EXAMPLE" | grep -v 'change-me' | grep -v '^#' || true)
  if [ -z "$PASSWORD_LINES" ]; then
    pass ".env.example: all secrets use 'change-me' placeholder"
  else
    fail ".env.example: found non-placeholder secret values"
  fi
fi

# =============================================================================
# Test 6: .env is excluded from git
# =============================================================================

GITIGNORE="$REPO_ROOT/.gitignore"

if grep -qE '^\.env$' "$GITIGNORE" 2>/dev/null; then
  pass ".gitignore: .env is excluded"
else
  fail ".gitignore: .env is NOT excluded — secrets could be committed"
fi

if grep -qE '^!\.env\.example$' "$GITIGNORE" 2>/dev/null; then
  pass ".gitignore: .env.example is explicitly included"
else
  fail ".gitignore: .env.example is not explicitly included"
fi

# =============================================================================
# Summary
# =============================================================================
printf "\n"
printf "  ──────────────────────────────────\n"
printf "  ${_GREEN}Passed: %d${_RESET}  " "$PASS"
if [ $FAIL -gt 0 ]; then
  printf "${_RED}Failed: %d${_RESET}" "$FAIL"
fi
printf "\n"
printf "  ──────────────────────────────────\n\n"

exit "$FAIL"
