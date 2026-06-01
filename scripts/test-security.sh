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
# Test 4b: FRIGATE_CAMERA_*_PASSWORD must NOT be URL-encoded
# =============================================================================
# Frigate substitutes env vars into the RTSP URL via Python str.format —
# the value lands in the URL VERBATIM. The bundled appliance ffmpeg does NOT
# URL-decode userinfo before authenticating, so a `%21` goes on the wire as
# three literal characters (`%`, `2`, `1`), the camera returns 401, and after
# ~5 retries the firmware locks the admin account (HTTP 490 Account Blocked)
# for several minutes. We've shipped this exact mistake in production once
# already (see the front_door comment in docker/frigate/config.yml); guard
# against it before another fresh `.env` ships with `Droplet123%21`.
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  encoded_pw_violations=$(grep -E '^FRIGATE_CAMERA_[A-Z0-9_]+_PASSWORD=' "$ENV_FILE" | grep -E '%[0-9A-Fa-f]{2}' || true)
  if [ -z "$encoded_pw_violations" ]; then
    pass ".env: no URL-encoded FRIGATE_CAMERA_*_PASSWORD values"
  else
    fail ".env: FRIGATE_CAMERA_*_PASSWORD contains URL-encoded chars (%XX)"
    printf "${_RED}%s${_RESET}\n" "$encoded_pw_violations" >&2
    printf "    Frigate substitutes env vars verbatim. Store the RAW password —\n" >&2
    printf "    e.g. \`Droplet123!\` not \`Droplet123%%21\` — and recreate Frigate\n" >&2
    printf "    with \`docker compose up -d --force-recreate frigate\` so it picks\n" >&2
    printf "    up the new env (\`docker restart\` keeps the old env baked in).\n\n" >&2
  fi
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
# Test 7: No new MATTER_* env vars outside the narrow allowlist
# =============================================================================
# matter.js (@matter/nodejs) auto-imports every process env var starting
# with `MATTER_` into its internal VariableService under a dot-namespaced
# key: `MATTER_FOO_BAR` becomes the var `foo.bar`. If the first segment
# matches a root-node behavior id, matter.js merges that subtree into the
# behavior's default state at activation time and throws
#     UnsupportedCastError: Property "<leaf>" is unsupported
# if the schema doesn't declare the key — at which point the whole Matter
# controller fails to initialize with a message that points nowhere near
# the real cause.
#
# Known collision we've already paid for:
#   MATTER_CONTROLLER_NAME → var `controller.name` → collides with the
#   root-node `controller` behavior. Fixed by renaming to
#   DROPLET_MATTER_CONTROLLER_NAME. See the full block comment in
#   apps/orchestrator/src/config.ts.
#
# Only MATTER_STORAGE_PATH is allow-listed (no root-node behavior has id
# `storage`, so the var subtree is visible to matter.js but never
# merged). Every new Droplet env var that needs to reach the orchestrator
# should use a `DROPLET_MATTER_*` prefix instead — that stays outside
# matter.js's auto-import scope entirely.

MATTER_ENV_ALLOWLIST="MATTER_STORAGE_PATH"

_scan_matter_env() {
  local file="$1" pattern="$2"
  [ -f "$file" ] || return 0
  local hits
  hits=$(grep -nE "$pattern" "$file" 2>/dev/null || true)
  [ -z "$hits" ] && return 0
  local line var found=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    var=$(printf '%s' "$line" | grep -oE "MATTER_[A-Z_]+" | head -1)
    [ -n "$var" ] || continue
    case " $MATTER_ENV_ALLOWLIST " in
      *" $var "*) continue ;;
    esac
    found+="    ${file#$REPO_ROOT/}:$line"$'\n'
  done <<< "$hits"
  printf '%s' "$found"
}

matter_env_violations=""
# Compose env lines:        `      - MATTER_FOO=...`
matter_env_violations+=$(_scan_matter_env "$COMPOSE_FILE" \
  '^[[:space:]]*-[[:space:]]*MATTER_[A-Z_]+=')
# Zod schema keys:           `  MATTER_FOO: z.string()...`
matter_env_violations+=$(_scan_matter_env "$REPO_ROOT/apps/orchestrator/src/config.ts" \
  '^[[:space:]]*MATTER_[A-Z_]+[[:space:]]*:')
# Example env file:          `MATTER_FOO=change-me`
matter_env_violations+=$(_scan_matter_env "$REPO_ROOT/.env.example" \
  '^MATTER_[A-Z_]+=')
# Secrets heredoc in setup:  `MATTER_FOO=$value`
matter_env_violations+=$(_scan_matter_env "$REPO_ROOT/scripts/lib/secrets.sh" \
  '^[[:space:]]*MATTER_[A-Z_]+=')

if [ -z "$matter_env_violations" ]; then
  pass "no MATTER_* env vars outside allowlist { $MATTER_ENV_ALLOWLIST }"
else
  fail "MATTER_* env var not in allowlist (collides with matter.js VariableService)"
  printf "${_RED}%s${_RESET}" "$matter_env_violations" >&2
  printf "    Use DROPLET_MATTER_* prefix for new env vars.\n" >&2
  printf "    See apps/orchestrator/src/config.ts for the full explanation.\n\n" >&2
fi

# =============================================================================
# Test 8: WARP-515 — No hardcoded Plane PM secrets in tracked files
# =============================================================================
# DROPLET_PM_ADMIN_TOKEN and DROPLET_PM_WEBHOOK_SECRET are device-unique
# values generated by setup.sh. If a tracked file ever assigns them a
# concrete literal (anything other than empty or a `$shell_var`), it ships
# the secret to every clone of the repo. Mirrors Test 1's posture against
# committed POSTGRES_PASSWORD literals; specific to the Plane stack.
#
# Allow-shaped values: empty (`KEY=`), $variable references (`KEY=$x`,
# `KEY=${x}`), `change-me` / `replace-me` placeholders in .env.example,
# and the Zod default `""` in config.ts.

_scan_pm_secret_literal() {
  local file="$1" pattern="$2"
  [ -f "$file" ] || return 0
  # Capture lines that look like an assignment and reject the allow-shaped
  # right-hand sides. The remaining lines have a literal — fail.
  local hits
  hits=$(grep -nE "$pattern" "$file" 2>/dev/null \
         | grep -vE "(=$|=\"\"$|=\\\$|=\\\$\\{|=change-me|=replace-me|=<.*>|: z\\.string\\(\\)\\.default\\(\"\"\\))" \
         || true)
  [ -z "$hits" ] || printf "    %s:%s\n" "${file#$REPO_ROOT/}" "$hits"
}

pm_secret_violations=""
for f in "$REPO_ROOT/.env.example" \
         "$REPO_ROOT/scripts/lib/secrets.sh" \
         "$REPO_ROOT/apps/orchestrator/src/config.ts" \
         "$COMPOSE_FILE" \
         "$REPO_ROOT/services/pm/.env.example"; do
  [ -f "$f" ] || continue
  pm_secret_violations+=$(_scan_pm_secret_literal "$f" \
    '^[[:space:]]*-?[[:space:]]*(DROPLET_PM_ADMIN_TOKEN|DROPLET_PM_WEBHOOK_SECRET|DROPLET_PM_SECRET_KEY|DROPLET_PM_DB_PASSWORD)[[:space:]]*[:=]')
done

if [ -z "$pm_secret_violations" ]; then
  pass "no hardcoded DROPLET_PM_* secrets in tracked files"
else
  fail "hardcoded DROPLET_PM_* secret literal (ships with the repo)"
  printf "${_RED}%s${_RESET}" "$pm_secret_violations" >&2
  printf "    Use empty default (\"\") or \$variable reference; setup.sh fills it in.\n\n" >&2
fi

# =============================================================================
# Test 9: WARP-515 — No host-specific defaults in services/pm/
# =============================================================================
# Architecture-guard rule 14: defaults must work on a brand-new install OR
# fail loud. Private-range IPs and host.docker.internal are dev-machine
# defaults — they leak when an operator clones the repo to a different host.
# This sweep is scoped to services/pm/ because the broader repo has
# legitimate uses (orchestrator → host.docker.internal:8080 for routing).

PM_HOST_DEFAULT_PATTERN='\b(192\.168\.|10\.[0-9]+\.|172\.(1[6-9]|2[0-9]|3[01])\.|host\.docker\.internal)'
pm_host_default_violations=""
if [ -d "$REPO_ROOT/services/pm" ]; then
  pm_host_default_hits=$(grep -rnE "$PM_HOST_DEFAULT_PATTERN" \
    "$REPO_ROOT/services/pm" \
    --include='*.py' --include='*.ts' --include='*.yml' --include='*.yaml' \
    --include='Dockerfile' --include='.env.example' --include='*.md' \
    2>/dev/null \
    | grep -v '/tests/' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
    | grep -vE 'Override BEFORE running setup\.sh' \
    || true)
  if [ -n "$pm_host_default_hits" ]; then
    pm_host_default_violations="$pm_host_default_hits"
  fi
fi

if [ -z "$pm_host_default_violations" ]; then
  pass "no host-specific defaults in services/pm/"
else
  fail "host-specific default in services/pm/ (rule 14)"
  printf "${_RED}%s${_RESET}\n" "$pm_host_default_violations" >&2
  printf "    Defaults must work on a brand-new install OR fail loud.\n\n" >&2
fi

# =============================================================================
# Test 10: WARP-562 — Orchestrator CORS allowlist rejects wildcard + credentials
# =============================================================================
# `credentials: true` is always on for the orchestrator, so a `*` CORS allowlist
# would let any site the appliance owner visits perform credentialed reads. The
# config parser must die loud on a wildcard (mirrors ai-gateway main.py). This
# static guard ensures the fail-fast `throw` stays in config.ts so a future edit
# can't silently drop it (the unit test in cors-config.test.ts covers runtime).

CORS_CONFIG_FILE="$REPO_ROOT/apps/orchestrator/src/config.ts"
if [ -f "$CORS_CONFIG_FILE" ] \
  && grep -q 'corsAllowedOrigins' "$CORS_CONFIG_FILE" \
  && grep -qE 'includes\("\*"\)' "$CORS_CONFIG_FILE" \
  && grep -qiE 'throw new Error' "$CORS_CONFIG_FILE"; then
  pass "config.ts: CORS allowlist rejects wildcard '*' with credentials"
else
  fail "config.ts: missing fail-fast guard rejecting CORS_ALLOWED_ORIGINS=* (WARP-562)"
  printf "    Credentialed CORS must never allow '*'; config parse must throw.\n\n" >&2
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
