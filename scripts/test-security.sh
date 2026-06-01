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

# Join backslash-continued shell lines into one logical line before matching,
# keyed by the starting line number. Without this, a command split across a
# `\` continuation (e.g. the flags on line N and `--env-file` on line N+1)
# is falsely flagged as missing --env-file. Output: "<startlineno>:<joined>".
join_continuations() {
  awk '
    { gsub(/\r$/, "") }
    buf == "" { start = NR }
    { line = $0
      cont = (line ~ /\\[[:space:]]*$/)
      sub(/\\[[:space:]]*$/, "", line)
      buf = buf line
      if (cont) { next }
      print start ":" buf
      buf = ""
    }
    END { if (buf != "") print start ":" buf }
  ' "$1"
}

compose_calls=$(join_continuations "$COMPOSE_SH" | grep 'run_docker_compose' || true)
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
verify_calls=$(join_continuations "$VERIFY_SH" | grep -E '(_docker_compose|docker compose) -f' | grep -v 'printf' || true)
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
# Test 10: WARP-575 — makeplane/plane-worker must not appear anywhere
# =============================================================================
# makeplane/plane-worker:* does not exist on Docker Hub (404). Plane runs the
# Celery worker from the backend image with an explicit command. This guard
# prevents the 404 image name from re-entering compose files, docs, or scripts.

plane_worker_hits=$(grep -rn 'makeplane/plane-worker' \
  "$REPO_ROOT/docker/" "$REPO_ROOT/docs/" "$REPO_ROOT/scripts/" \
  --exclude="test-security.sh" \
  2>/dev/null || true)

if [ -z "$plane_worker_hits" ]; then
  pass "no makeplane/plane-worker references in docker/, docs/, scripts/"
else
  fail "makeplane/plane-worker found — image does not exist on Docker Hub (WARP-575)"
  printf "${_RED}%s${_RESET}\n" "$plane_worker_hits" >&2
  printf "    pm-worker must use makeplane/plane-backend with an explicit\n" >&2
  printf "    command: [\"./bin/docker-entrypoint-worker.sh\"]\n\n" >&2
fi

# =============================================================================
# Test 11: WARP-575 — pm-worker and pm-api must share the same plane-backend pin
# =============================================================================
# Both services must reference the same makeplane/plane-backend:<tag> so the
# already-pulled pm-api image is reused; diverged pins introduce a hidden
# second download and break the ADR-010 OQ3 'single upstream pin' posture.

# Extract the image pin for a top-level service block, scoping by the service's
# 2-space-indented key (e.g. "  pm-api:"). This walks the block until the next
# top-level service key, so it is independent of whether image: comes before or
# after container_name: — a plain grep -B5 silently false-passes if keys are
# reordered (review nit, WARP-575). yq is not guaranteed in CI, so we stay awk-only.
extract_pm_image_pin() {
  awk -v svc="$1" '
    $0 ~ "^  " svc ":[[:space:]]*$" { in_svc = 1; next }
    in_svc && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_svc = 0 }
    in_svc && /^[[:space:]]+image:[[:space:]]+makeplane\/plane-backend:/ {
      line = $0
      sub(/.*image:[[:space:]]+/, "", line)
      print line
      exit
    }
  ' "$COMPOSE_FILE"
}

pm_api_pin=$(extract_pm_image_pin "pm-api")
pm_worker_pin=$(extract_pm_image_pin "pm-worker")

if [ -z "$pm_api_pin" ]; then
  fail "pm-api image pin not found (expected makeplane/plane-backend:<tag>)"
elif [ -z "$pm_worker_pin" ]; then
  fail "pm-worker image pin not found (expected makeplane/plane-backend:<tag>)"
elif [ "$pm_api_pin" = "$pm_worker_pin" ]; then
  pass "pm-api and pm-worker share the same plane-backend pin ($pm_api_pin)"
else
  fail "pm-api ($pm_api_pin) and pm-worker ($pm_worker_pin) image pins diverged"
  printf "${_RED}  pm-api:   %s${_RESET}\n" "$pm_api_pin" >&2
  printf "${_RED}  pm-worker:%s${_RESET}\n" "$pm_worker_pin" >&2
  printf "    Both must reference the same makeplane/plane-backend:<tag>.\n\n" >&2
fi

# =============================================================================
# Test 12: WARP-575 — pm-worker environment must be a superset of pm-api
# =============================================================================
# The Celery worker runs the same Plane backend image as pm-api and reads the
# same app config (SECRET_KEY for message/session signing, WEB_URL for email /
# notification link hrefs at worker init). Any env key the API sets must also be
# set on the worker, or the separate worker process silently diverges (this is
# exactly how the WEB_URL gap slipped in). We compare the environment: key names.

extract_pm_env_keys() {
  awk -v svc="$1" '
    $0 ~ "^  " svc ":[[:space:]]*$" { in_svc = 1; next }
    in_svc && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_svc = 0 }
    in_svc && /^    environment:[[:space:]]*$/ { in_env = 1; next }
    in_env && /^    [A-Za-z]/ { in_env = 0 }
    in_env && /^      [A-Za-z0-9_]+:/ {
      key = $0
      sub(/^[[:space:]]+/, "", key)
      sub(/:.*/, "", key)
      print key
    }
  ' "$COMPOSE_FILE" | sort -u
}

pm_api_env=$(extract_pm_env_keys "pm-api")
pm_worker_env=$(extract_pm_env_keys "pm-worker")
missing_worker_env=$(comm -23 <(printf '%s\n' "$pm_api_env") <(printf '%s\n' "$pm_worker_env"))

if [ -z "$pm_api_env" ]; then
  fail "pm-api environment block not found (expected at least SECRET_KEY/WEB_URL)"
elif [ -z "$missing_worker_env" ]; then
  pass "pm-worker environment is a superset of pm-api"
else
  fail "pm-worker is missing env keys that pm-api sets (WARP-575)"
  printf "${_RED}%s${_RESET}\n" "$missing_worker_env" >&2
  printf "    The worker runs the same image; mirror pm-api's environment keys.\n\n" >&2
fi

# =============================================================================
# Test 13: WARP-569 — Every service must have mem_limit (top-level key)
# =============================================================================
# Containers without a mem_limit are uncapped — a single runaway process can
# OOM-kill the whole appliance (7 GB shared RAM, 30 services). Use top-level
# `mem_limit`, NOT `deploy.resources.limits`: deploy.* is silently IGNORED by
# `docker compose up` outside Swarm and would appear to fix this while
# enforcing nothing.

_limits_output=$(python3 - "$COMPOSE_FILE" <<'PYEOF' 2>&1
import sys, yaml

compose_file = sys.argv[1]
try:
    with open(compose_file) as f:
        data = yaml.safe_load(f)
except Exception as e:
    print(f"YAML parse error: {e}", file=sys.stderr)
    sys.exit(2)

services = data.get("services", {})
missing_limit = [name for name, cfg in services.items() if "mem_limit" not in cfg]
has_deploy_resources = [
    name for name, cfg in services.items()
    if "deploy" in cfg and isinstance(cfg["deploy"], dict) and "resources" in cfg["deploy"]
]

ok = True
if missing_limit:
    print("Services missing mem_limit: " + ", ".join(sorted(missing_limit)), file=sys.stderr)
    ok = False
if has_deploy_resources:
    print("Services using deploy.resources (silently ignored outside Swarm): " + ", ".join(sorted(has_deploy_resources)), file=sys.stderr)
    ok = False

if ok:
    print(f"All {len(services)} services have mem_limit; no deploy.resources usage")
sys.exit(0 if ok else 1)
PYEOF
)
_limits_exit=$?

if [ "$_limits_exit" -eq 0 ]; then
  pass "docker-compose.yml: all services have mem_limit (no deploy.resources)"
else
  fail "docker-compose.yml: resource-limit coverage gap (WARP-569)"
  printf "${_RED}%s${_RESET}\n" "$_limits_output" >&2
  printf "    Add top-level mem_limit + cpus + pids_limit to every service.\n" >&2
  printf "    Do NOT use deploy.resources.limits — it is silently ignored outside Swarm.\n\n" >&2
fi

# =============================================================================
# Test 14: WARP-573 — orchestrator migration-on-boot is guarded
# =============================================================================
# The orchestrator container must NOT boot via the old unguarded
# `prisma migrate deploy && node` CMD (no advisory lock, no snapshot, silent
# power-cut restart loop). It must invoke the guarded entrypoint instead, and
# the entrypoint's own unit test must pass.

MIGRATE_DOCKERFILE="$REPO_ROOT/apps/orchestrator/Dockerfile"
# Only flag an ACTUAL directive — strip comment lines first (the Dockerfile
# legitimately documents the old `migrate deploy && node` chain in comments).
if grep -vE '^[[:space:]]*#' "$MIGRATE_DOCKERFILE" | grep -qE 'migrate deploy[[:space:]]*&&'; then
  fail "orchestrator Dockerfile still uses unguarded 'migrate deploy &&' CMD (WARP-573)"
elif ! grep -q "migrate-and-start.sh" "$MIGRATE_DOCKERFILE"; then
  fail "orchestrator Dockerfile does not invoke the guarded migrate-and-start.sh (WARP-573)"
else
  pass "orchestrator boots through the guarded migration entrypoint (WARP-573)"
fi

MIGRATE_TEST="$REPO_ROOT/apps/orchestrator/scripts/migrate-and-start.test.sh"
if [ -f "$MIGRATE_TEST" ]; then
  if bash "$MIGRATE_TEST" >/dev/null 2>&1; then
    pass "migrate-and-start.sh unit test (lock/snapshot/recovery/loud-failure) passes (WARP-573)"
  else
    fail "migrate-and-start.sh unit test failed (WARP-573)"
  fi
else
  fail "migrate-and-start.test.sh is missing (WARP-573)"
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
