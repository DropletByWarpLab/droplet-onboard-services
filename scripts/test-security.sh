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

# =============================================================================
# Test 1: No hardcoded fallback passwords in docker-compose.yml
# =============================================================================
# Secret variables MUST use ${VAR:?error} (fail if unset), NOT ${VAR:-default}
# (which silently falls back to an insecure value).
# Non-secret defaults like POSTGRES_USER, POSTGRES_DB are fine with :- syntax.

SECRET_VARS="POSTGRES_PASSWORD REDIS_PASSWORD MQTT_PASSWORD NEXTCLOUD_ADMIN_PASSWORD DEVICE_SECRET"

for var in $SECRET_VARS; do
  # Check for insecure fallback pattern: ${VAR:-anything}
  if grep -qE "\\\$\{${var}:-" "$COMPOSE_FILE"; then
    fail "docker-compose.yml: ${var} has insecure fallback default (uses :- instead of :?)"
  else
    pass "docker-compose.yml: ${var} has no fallback default"
  fi
done

# =============================================================================
# Test 2: Secret variables use :? (required) syntax
# =============================================================================

for var in $SECRET_VARS; do
  if grep -qE "\\\$\{${var}:\?" "$COMPOSE_FILE"; then
    pass "docker-compose.yml: ${var} uses required-variable syntax (:?)"
  else
    fail "docker-compose.yml: ${var} missing required-variable syntax (:?)"
  fi
done

# =============================================================================
# Test 3: All docker compose calls use --env-file
# =============================================================================
# Docker Compose must receive --env-file explicitly because the sudo fallback
# in run_docker_compose() strips shell environment variables (env_reset).
# Relying on `set -a; . .env; set +a` alone is insufficient.

# Every run_docker_compose call in compose.sh must include --env-file
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

# =============================================================================
# Test 4: .env.example exists and contains only placeholder values
# =============================================================================

ENV_EXAMPLE="$REPO_ROOT/.env.example"

if [ -f "$ENV_EXAMPLE" ]; then
  pass ".env.example exists in repo"
else
  fail ".env.example is missing from repo"
fi

# Ensure no real secrets leaked into the template (should only contain 'change-me')
if [ -f "$ENV_EXAMPLE" ]; then
  # Check that password fields only contain 'change-me'
  PASSWORD_LINES=$(grep -E '(PASSWORD|SECRET)=' "$ENV_EXAMPLE" | grep -v 'change-me' | grep -v '^#' || true)
  if [ -z "$PASSWORD_LINES" ]; then
    pass ".env.example: all secrets use 'change-me' placeholder"
  else
    fail ".env.example: found non-placeholder secret values"
  fi
fi

# =============================================================================
# Test 5: .env is excluded from git
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
