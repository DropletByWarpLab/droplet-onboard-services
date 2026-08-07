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

# MQTT_PASSWORD retired by WARP-235 — MQTT identity is the per-service client
# certificate CN (see docker/mosquitto.acl + docs/security/internal-mtls.md).
SECRET_VARS="POSTGRES_PASSWORD REDIS_PASSWORD NEXTCLOUD_ADMIN_PASSWORD DEVICE_SECRET DEVICE_SECRET_KEY"

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
  # A valid placeholder is either the literal `change-me` OR an EMPTY value
  # (`KEY=` with nothing after). Empty is the SAFEST placeholder — it can never
  # be a forgeable real secret. Only TWO keys are explicitly permitted to ship
  # empty, because for both the empty string IS the designed fail-safe state,
  # not a placeholder to fill in:
  #   * ONLYOFFICE_JWT_SECRET — empty ⇒ the orchestrator treats the doc-server
  #     as unavailable and no document-access JWT is ever signed (WARP-882).
  #   * AP_OPENWRT_PASSWORD — blank ⇒ "no external AP" (WARP-1675/WARP-1676);
  #     AP-direct config is skipped, never failed (services/routing/main.py).
  #     A `change-me` literal here would be WRONG, not merely untidy: it is
  #     truthy, so it reads as a real operator-supplied AP password, breaking
  #     the blank-means-off contract in
  #     scripts/lib/secrets.sh::sync_ap_password_secret + services/routing —
  #     which would then authenticate against a nonexistent AP with the
  #     literal written into /run/secrets/ap_openwrt_password.
  #   * ERP_DB_RO_PASSWORD / ERP_DB_RW_PASSWORD (WARP-1106) — same shape as
  #     AP_OPENWRT_PASSWORD: empty means "this ERP track is not configured", and
  #     services/erp-sql-bridge/db.py refuses to connect and reports
  #     NOT_CONFIGURED. A truthy `change-me` would instead make the bridge open
  #     a real ODBC connection to a practice's database with a bogus password,
  #     turning honest degradation into an authentication failure against a
  #     customer's system of record. Empty is additionally the correct default
  #     for the WRITE account specifically: writes are opt-in and `droplet_rw`
  #     is provisioned unusable until a capability is enabled.
  # The list is deliberately explicit rather than a blanket "empty is fine" —
  # a NEW secret that ships empty by accident must fail this check and be added
  # here on purpose, with a reason.
  # All other secrets must use `change-me` as their placeholder.
  PASSWORD_LINES=$(grep -E '(PASSWORD|SECRET)=' "$ENV_EXAMPLE" \
    | grep -v 'change-me' \
    | grep -vE '^(ONLYOFFICE_JWT_SECRET|AP_OPENWRT_PASSWORD|ERP_DB_RO_PASSWORD|ERP_DB_RW_PASSWORD)=[[:space:]]*$' \
    | grep -v '^#' || true)
  if [ -z "$PASSWORD_LINES" ]; then
    pass ".env.example: all secrets use 'change-me' or empty placeholder"
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
# Compose ${...} interpolations: `mem_limit: ${MATTER_FOO:-256m}` — a bare
# MATTER_* knob documented for the operator's .env is one stray env_file
# away from matter.js's auto-import (WARP-850 QA caught exactly this with
# MATTER_CONTROLLER_MEM_LIMIT). DROPLET_MATTER_* interpolations are fine.
matter_env_violations+=$(_scan_matter_env "$COMPOSE_FILE" \
  '\$\{MATTER_[A-Z_]+')

if [ -z "$matter_env_violations" ]; then
  pass "no MATTER_* env vars outside allowlist { $MATTER_ENV_ALLOWLIST }"
else
  fail "MATTER_* env var not in allowlist (collides with matter.js VariableService)"
  printf "${_RED}%s${_RESET}" "$matter_env_violations" >&2
  printf "    Use DROPLET_MATTER_* prefix for new env vars.\n" >&2
  printf "    See apps/orchestrator/src/config.ts for the full explanation.\n\n" >&2
fi

# =============================================================================
# Test 13: WARP-562 — Orchestrator CORS allowlist rejects wildcard + credentials
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
# Test 14: WARP-569 — Every service must have mem_limit (top-level key)
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
# Test 15: WARP-535 — OTA trust anchor ships in the orchestrator image
# =============================================================================
# The update agent verifies release manifests against a baked-in cosign
# public key. Two invariants, checked statically (this script never needs
# Docker — the Dockerfile COPY is what puts the file in the built image):
#   1. The key file exists at its canonical source path.
#   2. The orchestrator Dockerfile has a real (non-comment) COPY directive
#      that ships that exact path into the RUNTIME stage. dist/ output
#      doesn't include non-TS assets, so without the explicit COPY the
#      built image silently loses the trust anchor and every OTA verify
#      fails at runtime instead of at CI time.
# NOTE: until the human key ceremony runs (scripts/README.md, "OTA release
# signing — key ceremony") this file is a clearly-marked PLACEHOLDER; the
# update agent's verify path fails closed on the placeholder marker.

COSIGN_PUB="$REPO_ROOT/apps/orchestrator/src/services/update-agent/cosign.pub"
ORCH_DOCKERFILE="$REPO_ROOT/apps/orchestrator/Dockerfile"

if [ -f "$COSIGN_PUB" ]; then
  pass "cosign.pub exists at apps/orchestrator/src/services/update-agent/ (WARP-535)"
else
  fail "cosign.pub missing from apps/orchestrator/src/services/update-agent/ (WARP-535)"
fi

# Anchor the COPY check to the RUNTIME stage (everything from the LAST
# `FROM` onward): a builder-stage COPY does not put the file in the built
# image, so a stage-agnostic grep would stay green while the runtime image
# silently loses the trust anchor. awk isolates the final FROM block; the
# single grep on a here-string (no pipeline) avoids pipefail/SIGPIPE
# false-negatives, and `[^#]*` keeps a commented-out COPY from counting.
ORCH_RUNTIME_STAGE="$(awk '/^[[:space:]]*FROM[[:space:]]/ { buf = "" } { buf = buf $0 "\n" } END { printf "%s", buf }' "$ORCH_DOCKERFILE")"

if grep -qE '^[[:space:]]*COPY[^#]*src/services/update-agent/cosign\.pub' <<<"$ORCH_RUNTIME_STAGE"; then
  pass "orchestrator Dockerfile COPYs cosign.pub into the runtime stage (WARP-535)"
else
  fail "orchestrator Dockerfile does not COPY cosign.pub into the RUNTIME stage (WARP-535)"
fi

# =============================================================================
# Test 16: WARP-244 — keyless image signing + pull-time verification stay wired
# =============================================================================
# Two invariants that must never silently regress:
#   1. cmd_pull_images verifies each ref BEFORE docker pull (fail-closed gate).
#   2. publish-release.yml keyless-signs every pushed image.
APPLY_UPDATE_SH="$REPO_ROOT/scripts/lib/apply-update.sh"
if awk '/^cmd_pull_images\(\)/,/^}/' "$APPLY_UPDATE_SH" | grep -q 'verify_image_signature "\$img"'; then
  pass "apply-update.sh pull-images verifies signatures before docker pull (WARP-244)"
else
  fail "apply-update.sh cmd_pull_images no longer verifies before pulling (WARP-244)"
fi
if grep -q 'cosign sign --yes' "$REPO_ROOT/.github/workflows/publish-release.yml"; then
  pass "publish-release.yml keyless-signs every pushed image (WARP-244)"
else
  fail "publish-release.yml lost the keyless image-signing step (WARP-244)"
fi

# =============================================================================
# Test 17: WARP-233 — db must enforce TLS 1.3 + SCRAM + custom pg_hba
# =============================================================================
# No silent regression to plaintext Postgres. Static invariants:
#   1-3. the db service command carries the TLS 1.3 / SCRAM / hba_file flags
#        (hba_file keyed on PG_HBA with the TLS-only file as the DEFAULT —
#        the FIPS variant must never become the fallback),
#   4.   pg_hba.conf has the hostssl+scram line AND no plaintext `host` auth
#        line at all (only the terminal reject may start with `host `),
#   5.   pg_hba.fips.conf (the FIPS P1011 exception file) still SCRAMs its
#        plaintext lines (no trust/md5/password TCP auth) and keeps the
#        terminal reject.

PG_HBA="$REPO_ROOT/docker/postgres/pg_hba.conf"
PG_HBA_FIPS="$REPO_ROOT/docker/postgres/pg_hba.fips.conf"

if grep -q "ssl_min_protocol_version=TLSv1.3" "$COMPOSE_FILE" &&
   grep -q "password_encryption=scram-sha-256" "$COMPOSE_FILE" &&
   grep -q 'hba_file=/etc/postgresql/${PG_HBA:-pg_hba.conf}' "$COMPOSE_FILE" &&
   grep -q "hostssl all   all   0.0.0.0/0     scram-sha-256" "$PG_HBA" &&
   ! grep -qE "^host[[:space:]]+all[[:space:]]+all[[:space:]]+[^[:space:]]+[[:space:]]+(trust|md5|password|scram-sha-256)" "$PG_HBA"; then
  pass "db service enforces TLS 1.3 + SCRAM + custom pg_hba (WARP-233)"
else
  fail "db service TLS 1.3 / SCRAM / pg_hba invariants regressed (WARP-233)"
fi

if [ -f "$PG_HBA_FIPS" ] &&
   grep -qE "^host[[:space:]]+all[[:space:]]+all[[:space:]]+all[[:space:]]+reject" "$PG_HBA_FIPS" &&
   ! grep -qE "^host(ssl)?[[:space:]]+all[[:space:]]+all[[:space:]]+[^[:space:]]+[[:space:]]+(trust|md5|password)" "$PG_HBA_FIPS"; then
  pass "pg_hba.fips.conf keeps SCRAM-only TCP auth + terminal reject (WARP-233/318)"
else
  fail "pg_hba.fips.conf regressed — plaintext TCP must stay SCRAM-authed with a terminal reject (WARP-233/318)"
fi

# =============================================================================
# Test 18: WARP-234 — cache must stay TLS-only with per-service ACLs
# =============================================================================
# (Test 17 above is the WARP-233 db guard.) No silent regression to a plaintext/shared-password Redis. All
# static:
#   1. plaintext listener disabled (--port 0) and TLS listener on 6380,
#   2. the ACL file is served (--aclfile) and --requirepass is retired,
#   3. every first-party client dials its own ACL identity over rediss://,
#   4. Nextcloud's TLS config override is mounted.

if grep -q -- "--port 0" "$COMPOSE_FILE" &&
   grep -q -- "--tls-port 6380" "$COMPOSE_FILE" &&
   grep -q -- "--aclfile /etc/redis/users.acl" "$COMPOSE_FILE" &&
   ! grep -q -- "--requirepass" "$COMPOSE_FILE"; then
  pass "cache serves TLS-only on 6380 with the generated ACL file (WARP-234)"
else
  fail "cache TLS/ACL launch flags regressed (WARP-234)"
fi

if grep -q 'REDIS_URL=rediss://orchestrator:${REDIS_PASSWORD_ORCHESTRATOR' "$COMPOSE_FILE" &&
   grep -q 'REDIS_URL=rediss://mcp-server:${REDIS_PASSWORD_MCP' "$COMPOSE_FILE" &&
   grep -q 'REDIS_URL=rediss://ai-gateway:${REDIS_PASSWORD_AI_GATEWAY' "$COMPOSE_FILE" &&
   grep -q 'zz-redis-tls.config.php' "$COMPOSE_FILE"; then
  pass "every Redis client dials its own ACL identity over rediss:// (WARP-234)"
else
  fail "a Redis client lost its per-service rediss:// identity (WARP-234)"
fi

# =============================================================================
# Test 19: WARP-235 — no compose service may mount the data/secrets ROOT
# =============================================================================
# Since WARP-236, data/secrets holds the internal CA PRIVATE key
# (internal-ca/ca.key) and every service's TLS bundle (service-tls/<svc>/).
# A container that bind-mounts the ROOT can read the CA key and mint
# arbitrary service identities, defeating per-service mTLS + the MQTT
# per-CN ACLs. Only scoped mounts are allowed:
#   - ../data/secrets/service-tls/<svc>:...   (a service's OWN bundle)
#   - ../data/secrets/<single-file-key>:...   (e.g. audit.key, email.key)
# The match targets the exact bare-root bind (../data/secrets:/...), so the
# scoped patterns above never trip it.

if grep -qE '\.\./data/secrets:' "$COMPOSE_FILE"; then
  fail "docker-compose.yml: a service mounts the data/secrets ROOT (exposes internal-ca/ca.key — use a scoped service-tls/<svc> or single-key mount)"
else
  pass "docker-compose.yml: no service mounts the data/secrets root (CA key stays unmountable)"
fi

# =============================================================================
# Test 20: WARP-1474 — overlay QR link token stays out of request logs
# =============================================================================
# The overlay link token (POST /api/vpn/overlay/link-tokens) is a
# bearer-equivalent secret returned to the owner ONCE — only its sha256 hash is
# persisted. The pino-http base logger's redact list must cover the token (and
# the client sign-key PEM + the PoP header) so a token can never leak into a log
# bundle. Static guard so a future edit to the redact config can't silently drop
# it; the runtime behaviour is covered by the middleware unit test.

REQ_LOGGER="$REPO_ROOT/apps/orchestrator/src/middleware/request-logger.ts"
if [ -f "$REQ_LOGGER" ] \
  && grep -q '"req.body.token"' "$REQ_LOGGER" \
  && grep -q '"req.body.sign_public_key_pem"' "$REQ_LOGGER" \
  && grep -q '"res.body.token"' "$REQ_LOGGER"; then
  pass "request-logger redacts the overlay QR link token + sign-key PEM (WARP-1474)"
else
  fail "request-logger.ts lost the overlay link-token redaction paths (WARP-1474)"
  printf "    The overlay link token must stay in the pino redact list — never logged.\n\n" >&2
fi

# =============================================================================
# Test 21: WARP-1607 — Nextcloud PHP sessions use the SAME Redis endpoint
#                      as config.php (TLS :6380, `nextcloud` ACL user)
# =============================================================================
# Nextcloud reaches Redis from TWO surfaces and WARP-234 only migrated one:
#
#   1. config.php   — docker/nextcloud/zz-redis-tls.config.php (distributed
#      cache + file locking). Migrated: tls://cache:6380, user `nextcloud`.
#   2. PHP sessions — /usr/local/etc/php/conf.d/redis-session.ini, which the
#      upstream nextcloud image entrypoint REGENERATES on every boot from
#      REDIS_HOST/REDIS_HOST_PORT/REDIS_HOST_USER/REDIS_HOST_PASSWORD with a
#      hardcoded `tcp://` scheme and no stream context. It cannot express TLS
#      or a CA bundle at all, so it kept dialling the retired plaintext :6379
#      listener with the retired shared password. Every session write then
#      failed ("Redis connection not available"), which surfaced downstream as
#      an opaque `Groupfolder add group: 500` and stalled department/team
#      provisioning (ADR-029) on every reconciler tick.
#
# The fix mounts docker/nextcloud/zz-redis-session.ini into conf.d. PHP scans
# that directory with php_alphasort and later files override earlier ones
# (php-src main/php_ini.c), so a `zz-` name deterministically beats the
# entrypoint's redis-session.ini.
#
# ANTI-DRIFT: both artifacts must read the SAME compose-defined env contract.
# That is what this test pins — not just "the ini looks right today".

NC_SESSION_INI="$REPO_ROOT/docker/nextcloud/zz-redis-session.ini"
NC_REDIS_PHP="$REPO_ROOT/docker/nextcloud/zz-redis-tls.config.php"

if [ -f "$NC_SESSION_INI" ] &&
   grep -q 'zz-redis-session.ini:/usr/local/etc/php/conf.d/zz-redis-session.ini:ro' "$COMPOSE_FILE"; then
  pass "Nextcloud session handler config is mounted into php conf.d (WARP-1607)"
else
  fail "docker/nextcloud/zz-redis-session.ini missing or not mounted into php conf.d (WARP-1607)"
  printf "    Without it the image entrypoint's plaintext redis-session.ini wins and every PHP session write fails.\n\n" >&2
fi

# The override only works because conf.d is scanned alphabetically — pin it.
_ini_base="$(basename "$NC_SESSION_INI")"
if [ "$(printf 'redis-session.ini\n%s\n' "$_ini_base" | LC_ALL=C sort | tail -n 1)" = "$_ini_base" ]; then
  pass "session ini filename sorts after the entrypoint's redis-session.ini (WARP-1607)"
else
  fail "$_ini_base sorts BEFORE redis-session.ini — the entrypoint's plaintext file would win (WARP-1607)"
fi

# The compose env contract is the single source of truth for BOTH surfaces.
if grep -q 'REDIS_HOST=cache$' "$COMPOSE_FILE" &&
   grep -q 'REDIS_HOST_PORT=6380$' "$COMPOSE_FILE" &&
   grep -q 'REDIS_HOST_USER=nextcloud$' "$COMPOSE_FILE" &&
   grep -q 'REDIS_TLS_SCHEME=tls$' "$COMPOSE_FILE" &&
   grep -q 'REDIS_TLS_CAFILE=/data/service-tls/ca.pem$' "$COMPOSE_FILE"; then
  pass "compose defines the Nextcloud→Redis endpoint contract once (WARP-1607)"
else
  fail "the nextcloud service lost part of its Redis endpoint env contract (WARP-1607)"
  printf "    REDIS_HOST/REDIS_HOST_PORT/REDIS_HOST_USER/REDIS_TLS_SCHEME/REDIS_TLS_CAFILE must all be set on the nextcloud service.\n\n" >&2
fi

# phpredis 6.2.0 (pecl redis-6.2.0 in the pinned nextcloud:29 image) takes the
# transport straight from the save_path scheme, supports auth[user]/auth[pass]
# (redis_extract_auth_info) and maps stream[...] onto the "ssl" stream context
# (redis_sock_set_stream_context). All four must be present.
if [ -f "$NC_SESSION_INI" ] &&
   grep -qE '^session\.save_handler[[:space:]]*=[[:space:]]*redis$' "$NC_SESSION_INI" &&
   grep -q '${REDIS_TLS_SCHEME}://${REDIS_HOST}:${REDIS_HOST_PORT}' "$NC_SESSION_INI" &&
   grep -q 'auth\[user\]=${REDIS_HOST_USER}' "$NC_SESSION_INI" &&
   grep -q 'auth\[pass\]=${REDIS_HOST_PASSWORD}' "$NC_SESSION_INI" &&
   grep -q 'stream\[cafile\]=${REDIS_TLS_CAFILE}' "$NC_SESSION_INI" &&
   grep -q 'stream\[verify_peer\]=1' "$NC_SESSION_INI" &&
   grep -q 'stream\[verify_peer_name\]=1' "$NC_SESSION_INI"; then
  pass "session save_path is TLS + verified CA + the nextcloud ACL user (WARP-1607)"
else
  fail "session save_path lost its TLS scheme, ACL user or peer verification (WARP-1607)"
  printf "    Required shape: \"\${REDIS_TLS_SCHEME}://\${REDIS_HOST}:\${REDIS_HOST_PORT}?auth[user]=...&auth[pass]=...&stream[cafile]=...&stream[verify_peer]=1&stream[verify_peer_name]=1\"\n\n" >&2
fi

# No generated/mounted Nextcloud Redis artifact may name the retired plaintext
# listener or the retired shared identity. Comment lines are stripped first:
# these files legitimately DOCUMENT the retired pattern they replaced, and a
# lint that punishes explaining yourself just gets the comments deleted.
_strip_comments() { grep -vE '^[[:space:]]*(;|#|\*|//|/\*)' "$1" || true; }
_nc_redis_regression=0
for _f in "$NC_SESSION_INI" "$NC_REDIS_PHP"; do
  [ -f "$_f" ] || { _nc_redis_regression=1; continue; }
  _code="$(_strip_comments "$_f")"
  if printf '%s\n' "$_code" | grep -qE '6379|tcp://'; then
    _nc_redis_regression=1
    printf "    %s references the retired plaintext Redis listener\n" "$(basename "$_f")" >&2
  fi
  # REDIS_PASSWORD is the ping-only `default` ACL user — never Nextcloud's.
  if printf '%s\n' "$_code" | grep -qE '(^|[^_])REDIS_PASSWORD\b'; then
    _nc_redis_regression=1
    printf "    %s uses the retired shared secret instead of REDIS_HOST_PASSWORD\n" "$(basename "$_f")" >&2
  fi
done
if [ "$_nc_redis_regression" -eq 0 ]; then
  pass "no Nextcloud Redis config references :6379 or the retired shared secret (WARP-1607)"
else
  fail "a Nextcloud Redis config regressed to plaintext :6379 / the shared password (WARP-1607)"
fi

# THE anti-drift assertion: the session ini and config.php must resolve their
# endpoint from the identical set of environment variables. If someone edits
# one surface's port/user/CA without the other, these sets diverge and this
# fails — which is exactly the WARP-1607 bug class.
if [ -f "$NC_SESSION_INI" ] && [ -f "$NC_REDIS_PHP" ]; then
  _ini_vars="$(_strip_comments "$NC_SESSION_INI" | grep -oE '\$\{[A-Z_]+\}' \
                | tr -d '${}' | LC_ALL=C sort -u)"
  _php_vars="$(_strip_comments "$NC_REDIS_PHP" | grep -oE "getenv\('[A-Z_]+'\)" \
                | sed -E "s/getenv\('([A-Z_]+)'\)/\1/" | LC_ALL=C sort -u)"
  if [ -n "$_ini_vars" ] && [ "$_ini_vars" = "$_php_vars" ]; then
    pass "session ini and config.php derive Redis from one env contract (WARP-1607)"
  else
    fail "Nextcloud's two Redis surfaces read DIFFERENT env vars — they can drift (WARP-1607)"
    printf "    zz-redis-session.ini: %s\n" "$(printf '%s' "$_ini_vars" | tr '\n' ' ')" >&2
    printf "    zz-redis-tls.config.php: %s\n\n" "$(printf '%s' "$_php_vars" | tr '\n' ' ')" >&2
  fi
else
  fail "Nextcloud Redis config files missing — cannot verify the shared env contract (WARP-1607)"
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
