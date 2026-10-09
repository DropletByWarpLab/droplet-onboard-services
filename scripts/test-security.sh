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
# the value lands in the URL VERBATIM. Frigate then percent-encodes the
# password itself (escape_special_characters) and ffmpeg decodes it once, so a
# pre-encoded `%21` is encoded again (`%2521`) and goes on the wire as three
# literal characters (`%`, `2`, `1`): the camera returns 401, and after ~5
# retries the firmware locks the admin account (HTTP 490 Account Blocked) for
# several minutes. We've shipped this exact mistake in production once
# already (see the front_door comment in docker/frigate/config.yml); guard
# against it before another fresh `.env` ships with `T3stCamPw%21`.
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  encoded_pw_violations=$(grep -E '^FRIGATE_CAMERA_[A-Z0-9_]+_PASSWORD=' "$ENV_FILE" | grep -E '%[0-9A-Fa-f]{2}' || true)
  if [ -z "$encoded_pw_violations" ]; then
    pass ".env: no URL-encoded FRIGATE_CAMERA_*_PASSWORD values"
  else
    fail ".env: FRIGATE_CAMERA_*_PASSWORD contains URL-encoded chars (%XX)"
    printf "${_RED}%s${_RESET}\n" "$encoded_pw_violations" >&2
    printf "    Frigate substitutes env vars verbatim. Store the RAW password —\n" >&2
    printf "    e.g. \`T3stCamPw!\` not \`T3stCamPw%%21\` — and recreate Frigate\n" >&2
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

if grep -qE $'^\\.env\r?$' "$GITIGNORE" 2>/dev/null; then
  pass ".gitignore: .env is excluded"
else
  fail ".gitignore: .env is NOT excluded — secrets could be committed"
fi

if grep -qE $'^!\\.env\\.example\r?$' "$GITIGNORE" 2>/dev/null; then
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
# Test 14b: WARP-2895 — the sandbox sits on the internal-only network and
# nowhere else
# =============================================================================
# The first `internal: true` network in the compose file. Customer-written
# code runs in the sandbox, and the ONLY thing that keeps it off the LAN and
# the internet is this network posture — so it is asserted, not assumed:
#   - a top-level `networks.droplet-internal` with `internal: true`;
#   - the sandbox attached to exactly that network — no `ports:`, no
#     `network_mode`, no `env_file`, no docker socket;
#   - exactly four declared named volumes at their pinned paths (WARP-3906),
#     including persistent app data, with no additional mount or host bind;
#   - the hardening stanza (read-only, cap_drop ALL, no-new-privileges, tmpfs
#     /tmp, non-root image) and the ADR-021 trio incl. `pids_limit`;
#   - `init: true` (WARP-2900 / WARP-3012): a stopped extension's or a timed-out
#     run's process group is killed, and its orphans are reparented to PID 1.
#     Without an init, PID 1 is the Python server, which never reaps them, and
#     the zombies eat `pids_limit` until the container restarts;
#   - the orchestrator on BOTH `default` and `droplet-internal`, so the
#     internal network cannot silently become the orchestrator's only one.
# MUTATION: remove `internal: true` and this goes red.

_sandbox_output=$(python3 - "$COMPOSE_FILE" <<'PYEOF' 2>&1
import sys, yaml

with open(sys.argv[1], encoding="utf-8") as f:
    data = yaml.safe_load(f)

problems = []
nets = data.get("networks") or {}
internal = nets.get("droplet-internal")
if not isinstance(internal, dict) or internal.get("internal") is not True:
    problems.append("networks.droplet-internal must exist with `internal: true`")

sb = (data.get("services") or {}).get("sandbox")
if not isinstance(sb, dict):
    problems.append("services.sandbox is missing")
    sb = {}

if sb.get("networks") != ["droplet-internal"]:
    problems.append(f"sandbox.networks must be exactly ['droplet-internal'], got {sb.get('networks')!r}")
for key in ("ports", "network_mode", "env_file", "privileged", "devices"):
    if key in sb:
        problems.append(f"sandbox must not carry `{key}`")
for vol in sb.get("volumes") or []:
    if "docker.sock" in str(vol):
        problems.append("sandbox must never mount the docker socket")
expected_mounts = [
    "workspace-git:/var/lib/workspace-git",
    "workspace-checkouts:/var/lib/workspace",
    "extensions-installed:/var/lib/workspace-ext",
    "extensions-data:/var/lib/workspace-ext-data",
]
if sb.get("volumes") != expected_mounts:
    problems.append(f"sandbox.volumes must be exactly {expected_mounts!r}, got {sb.get('volumes')!r}")
declared_volumes = data.get("volumes") or {}
for mount in expected_mounts:
    name = mount.split(":", 1)[0]
    if name not in declared_volumes or declared_volumes[name] not in (None, {}):
        problems.append(f"{name} must be a declared default named volume, without a host bind or external override")
if sb.get("read_only") is not True:
    problems.append("sandbox must be read_only: true")
if sb.get("cap_drop") != ["ALL"]:
    problems.append("sandbox must cap_drop: [ALL]")
if "no-new-privileges:true" not in (sb.get("security_opt") or []):
    problems.append("sandbox must set security_opt no-new-privileges:true")
if not any(str(t).startswith("/tmp") for t in (sb.get("tmpfs") or [])):
    problems.append("sandbox must mount a tmpfs /tmp")
for key in ("mem_limit", "cpus", "pids_limit"):
    if key not in sb:
        problems.append(f"sandbox must set `{key}` (ADR-021)")
if sb.get("init") is not True:
    problems.append("sandbox must set init: true (orphans of a killed process group are reaped)")
env = sb.get("environment") or []
env_values = dict(str(e).split("=", 1) for e in env if "=" in str(e)) if isinstance(env, list) else env
if env_values.get("SANDBOX_EXTENSIONS_DATA_DIR") != "/var/lib/workspace-ext-data":
    problems.append("sandbox must pin SANDBOX_EXTENSIONS_DATA_DIR=/var/lib/workspace-ext-data")
env_keys = {str(e).split("=", 1)[0] for e in env} if isinstance(env, list) else set(env.keys())
extra_secrets = {k for k in env_keys if k.endswith("_TOKEN") or k.endswith("_PASSWORD") or k.endswith("_SECRET")} - {"SANDBOX_SERVICE_TOKEN"}
if extra_secrets:
    problems.append(f"sandbox may hold only its own bearer, found {sorted(extra_secrets)}")

orch = (data.get("services") or {}).get("orchestrator") or {}
onets = orch.get("networks")
if not isinstance(onets, list) or "default" not in onets or "droplet-internal" not in onets:
    problems.append(f"orchestrator.networks must list both default and droplet-internal, got {onets!r}")

for name, cfg in (data.get("services") or {}).items():
    if name in ("sandbox", "orchestrator"):
        continue
    if "droplet-internal" in (cfg.get("networks") or []):
        problems.append(f"{name} joined droplet-internal - every member is reachable from the sandbox; add it on purpose, here")

# Wyoming speech peers must be isolated from the untrusted sandbox too.
speech = nets.get("droplet-speech")
if not isinstance(speech, dict) or speech.get("internal") is not True:
    problems.append("networks.droplet-speech must exist with `internal: true`")
speech_members = {
    name for name, cfg in (data.get("services") or {}).items()
    if "droplet-speech" in (cfg.get("networks") or [])
}
if speech_members != {"orchestrator", "voice-io", "qwen-stt", "kokoro-tts"}:
    problems.append(f"droplet-speech must contain only speech services and their clients, got {sorted(speech_members)}")
for name in ("qwen-stt", "kokoro-tts"):
    cfg = (data.get("services") or {}).get(name) or {}
    if cfg.get("networks") != ["droplet-speech"] or "ports" in cfg or "network_mode" in cfg:
        problems.append(f"{name} must join only droplet-speech with no published ports or network_mode")

if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
print("sandbox: internal-only network, hardened, ADR-021 limits; orchestrator on both networks")
PYEOF
)
_sandbox_exit=$?

if [ "$_sandbox_exit" -eq 0 ]; then
  pass "docker-compose.yml: sandbox is on the internal-only network and nowhere else (WARP-2895)"
else
  fail "docker-compose.yml: sandbox network / hardening posture (WARP-2895)"
  printf "${_RED}%s${_RESET}\n" "$_sandbox_output" >&2
fi

# =============================================================================
# Test 14c: WARP-2898 (ADR-056 slice K1) — no base service is named ext-*
# =============================================================================
# `ext-<id>` is the namespace an extension container runs in: its compose
# override (update-agent/extension-fragment.ts) ADDS one service with that
# name. If the base file ever defined an ext-* service, an extension override
# would MERGE its keys into a first-party service instead of adding its own,
# so the name space is reserved here, not by convention. The same holds for
# the top-level `ext-<id>-data` volume the override declares: a base volume
# of that name would be merged, and extension <id> would mount first-party
# data at /data. The check first runs against two throwaway fixtures (an
# ext-foo service; an ext-foo-data volume), so a vacuous check (wrong key,
# empty parse) cannot pass.
# MUTATION: drop either startswith("ext-") test and its fixture self-check
# goes red.

_no_ext_services() {
  python3 - "$1" <<'PYEOF'
import sys, yaml

with open(sys.argv[1], encoding="utf-8") as f:
    data = yaml.safe_load(f)
services = (data or {}).get("services") or {}
if not services:
    print("no services parsed - refusing a vacuous pass", file=sys.stderr)
    sys.exit(2)
volumes = (data or {}).get("volumes") or {}
reserved = sorted(name for name in services if str(name).startswith("ext-"))
reserved += sorted("volume " + str(name) for name in volumes if str(name).startswith("ext-"))
if reserved:
    print("base services/volumes in the reserved ext-* namespace: " + ", ".join(reserved), file=sys.stderr)
    sys.exit(1)
print(f"{len(services)} base services and {len(volumes)} base volumes, none named ext-*")
PYEOF
}

_ext_fixture_dir=$(mktemp -d)
cat > "$_ext_fixture_dir/services.yml" <<'YAMLEOF'
services:
  orchestrator:
    image: orchestrator
  ext-foo:
    image: foo
YAMLEOF
cat > "$_ext_fixture_dir/volumes.yml" <<'YAMLEOF'
services:
  orchestrator:
    image: orchestrator
volumes:
  orchestrator-data:
  ext-foo-data:
YAMLEOF
_ext_fixture_rc=0
_no_ext_services "$_ext_fixture_dir/services.yml" >/dev/null 2>&1 || _ext_fixture_rc=$?
_ext_vol_fixture_rc=0
_no_ext_services "$_ext_fixture_dir/volumes.yml" >/dev/null 2>&1 || _ext_vol_fixture_rc=$?
rm -rf "$_ext_fixture_dir"

_ext_rc=0
_ext_output=$(_no_ext_services "$COMPOSE_FILE" 2>&1) || _ext_rc=$?

if [ "$_ext_fixture_rc" -ne 1 ]; then
  fail "Test 14c self-check: a fixture with an ext-foo service was not refused (rc=$_ext_fixture_rc)"
elif [ "$_ext_vol_fixture_rc" -ne 1 ]; then
  fail "Test 14c self-check: a fixture with an ext-foo-data volume was not refused (rc=$_ext_vol_fixture_rc)"
elif [ "$_ext_rc" -eq 0 ]; then
  pass "docker-compose.yml: no base service or volume is named ext-* (the extension namespace, WARP-2898)"
else
  fail "docker-compose.yml: a base service or volume sits in the reserved ext-* namespace (WARP-2898)"
  printf "${_RED}%s${_RESET}\n" "$_ext_output" >&2
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
APPLY_UPDATE_SH="$REPO_ROOT/docker/ota/apply-update.sh"
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
# Test 20: request credentials stay out of request logs
# =============================================================================
# Keep authentication headers, cookies and application tokens redacted even if
# a future serializer or explicit request log includes them. Runtime behavior
# is covered by the middleware unit tests.

REQ_LOGGER="$REPO_ROOT/apps/orchestrator/src/middleware/request-logger.ts"
if [ -f "$REQ_LOGGER" ] \
  && grep -q '"req.headers.authorization"' "$REQ_LOGGER" \
  && grep -q '"req.headers.cookie"' "$REQ_LOGGER" \
  && grep -q 'set-cookie' "$REQ_LOGGER" \
  && grep -q '"req.body.token"' "$REQ_LOGGER" \
  && grep -q '"req.query.token"' "$REQ_LOGGER" \
  && grep -q '"res.body.token"' "$REQ_LOGGER"; then
  pass "request-logger redacts authentication headers, cookies and application tokens"
else
  fail "request-logger.ts lost credential redaction paths"
  printf "    Authentication headers, cookies and tokens must never enter request logs.\n\n" >&2
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
# Test 21b: WARP-3588 / WARP-3625 / WARP-3656 — compose secret distribution
# =============================================================================
# scripts/check-compose-hardening.py: services converted off `env_file` do not
# regain it and still render their required secrets; DEVICE_SECRET_KEY,
# JWT_SECRET and the database credentials have an explicit recipient allowlist;
# voice-io / rag-eval / file-indexer keep their bearer dependency; the services
# hardened with no-new-privileges keep it. It also mutates the compose model to
# prove the guard fails when it should.
# MUTATION: add `env_file: [../.env]` to cache, or `- JWT_SECRET` to web-fetch.
_hard_exit=0
_hard_output=$(python3 "$REPO_ROOT/scripts/check-compose-hardening.py" 2>&1) || _hard_exit=$?
if [ "$_hard_exit" -eq 0 ]; then
  pass "compose secret distribution, bearer wiring and no-new-privileges guards hold (WARP-3588/3625/3656)"
else
  fail "compose secret distribution / hardening guard failed (WARP-3588/3625/3656)"
  printf "${_RED}%s${_RESET}\n" "$_hard_output" >&2
fi

# =============================================================================
# Test 21c: WARP-3693 — the nextcloud entrypoint chowns the droplet-share root
# as root, so the SMB network drive is writable
# =============================================================================
# The `droplet-share` named volume is exported over SMB by the samba service
# (`force user` uid 33) and mounted into nextcloud at /droplet-share (www-data,
# uid 33). A fresh named volume materializes root:root 755, so neither writer
# could create anything: Windows/macOS users could log in to the share but not
# add a file or folder. The ONLY place that can fix it is the nextcloud
# service's `entrypoint:` override, which runs as root before /entrypoint.sh
# drops to www-data. nextcloud-init.sh is a before-starting hook, which the
# stock entrypoint runs as www-data (run_as), so a chown there is a silent
# EPERM no-op. The chown must stay non-recursive (a recursive one over a
# populated share would stall every boot) and come BEFORE the exec hand-off.
# MUTATION: delete `chown 33:33 /droplet-share` from the nextcloud entrypoint
# (or move it after `exec /entrypoint.sh`) and this goes red.
_dshare_exit=0
_dshare_output=$(python3 - "$COMPOSE_FILE" <<'PYEOF' 2>&1
import re, sys, yaml

with open(sys.argv[1], encoding="utf-8") as f:
    data = yaml.safe_load(f)

nc = (data.get("services") or {}).get("nextcloud")
if not isinstance(nc, dict):
    print("services.nextcloud is missing")
    sys.exit(1)

ep = nc.get("entrypoint")
script = " ".join(str(a) for a in ep) if isinstance(ep, list) else str(ep or "")
chown = re.search(r"\bchown\s+33:33\s+/droplet-share(?![\w./-])", script)
handoff = re.search(r"\bexec\s+/entrypoint\.sh\b", script)
if not chown:
    print("nextcloud entrypoint must run a non-recursive `chown 33:33 /droplet-share`")
    sys.exit(1)
if not handoff or chown.start() > handoff.start():
    print("the droplet-share chown must run BEFORE `exec /entrypoint.sh`")
    sys.exit(1)
PYEOF
) || _dshare_exit=$?

if [ "$_dshare_exit" -eq 0 ]; then
  pass "docker-compose.yml: nextcloud entrypoint chowns droplet-share as root before exec (WARP-3693)"
else
  fail "docker-compose.yml: nextcloud entrypoint must chown 33:33 /droplet-share before exec (WARP-3693)"
  printf "${_RED}%s${_RESET}\n" "$_dshare_output" >&2
fi

# =============================================================================
# Test 22: WARP-3193 SEC-DATA-1 — `env_file: ../.env` only on an allowlist
# =============================================================================
# The root .env carries JWT_SECRET, DEVICE_SECRET_KEY, POSTGRES_PASSWORD and
# the rest of the box's keys. A container that parses untrusted input (office
# documents, web content, camera streams, ONVIF replies) must get an explicit
# `environment:` list instead — one parser RCE there must not yield the key an
# owner JWT is forged from. Adding a service here is a security decision:
# say in the PR why it needs the whole file.
# MUTATION: add `env_file: [../.env]` to web-fetch or nextcloud and this goes red.
# (nextcloud left the allowlist in WARP-3585; Test 22b pins its variable list.)
_envfile_exit=0
_envfile_output=$(python3 - "$COMPOSE_FILE" <<'PYEOF' 2>&1
import sys, yaml

ALLOWED = {
    "ai-gateway", "cache", "db", "device-identity-svc", "erp-sql-bridge",
    "file-indexer", "fleet-agent", "inference-manager", "mcp-bridge",
    "mcp-server", "orchestrator", "rag-eval", "voice-io",
}

with open(sys.argv[1], encoding="utf-8") as f:
    data = yaml.safe_load(f)

bad = []
for name, cfg in sorted((data.get("services") or {}).items()):
    ef = cfg.get("env_file")
    if ef is None:
        continue
    entries = ef if isinstance(ef, list) else [ef]
    paths = [e.get("path") if isinstance(e, dict) else e for e in entries]
    if any(str(p).rstrip("/").endswith(".env") and "../.env" in str(p) for p in paths) \
            and name not in ALLOWED:
        bad.append(name)
if bad:
    print("services loading ../.env outside the allowlist: " + ", ".join(bad), file=sys.stderr)
    sys.exit(1)
PYEOF
) || _envfile_exit=$?
if [ "$_envfile_exit" -eq 0 ]; then
  pass "docker-compose.yml: env_file ../.env only on allowlisted services (SEC-DATA-1)"
else
  fail "docker-compose.yml: env_file ../.env on a non-allowlisted service (SEC-DATA-1)"
  printf "${_RED}%s${_RESET}\n" "$_envfile_output" >&2
fi

# =============================================================================
# Test 22b: WARP-3585 — the nextcloud container receives only the variables it reads
# =============================================================================
# With env_file gone, the `environment:` list IS the allowlist. A key added
# here must be read by the Nextcloud image entrypoint, docker/nextcloud-init.sh
# or docker/nextcloud/*; a box secret that none of them read must not appear.
# MUTATION: add `JWT_SECRET=${JWT_SECRET}` to nextcloud's environment -> red.
_ncenv_exit=0
_ncenv_output=$(python3 - "$COMPOSE_FILE" <<'PYEOF' 2>&1
import sys, yaml

EXPECTED = {
    "POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD",
    "NEXTCLOUD_ADMIN_USER", "NEXTCLOUD_ADMIN_PASSWORD",
    "DOCS_ENABLED", "DOCS_ENGINE", "ONLYOFFICE_JWT_SECRET",
    "PGSSLMODE", "REDIS_HOST", "REDIS_HOST_PORT", "REDIS_HOST_USER",
    "REDIS_HOST_PASSWORD", "REDIS_TLS_SCHEME", "REDIS_TLS_CAFILE",
    "NEXTCLOUD_TRUSTED_DOMAINS", "OVERWRITEPROTOCOL",
    "DROPLET_SHARED_FOLDER_NAME", "DROPLET_SHARED_FOLDER_QUOTA",
}
with open(sys.argv[1], encoding="utf-8") as f:
    svc = yaml.safe_load(f)["services"]["nextcloud"]
env = svc.get("environment") or []
keys = set(env) if isinstance(env, dict) else {e.split("=", 1)[0] for e in env}
if svc.get("env_file") is not None:
    print("nextcloud declares env_file", file=sys.stderr)
    sys.exit(1)
if keys != EXPECTED:
    print("nextcloud environment drifted: unexpected=%s missing=%s" % (
        sorted(keys - EXPECTED), sorted(EXPECTED - keys)), file=sys.stderr)
    sys.exit(1)
PYEOF
) || _ncenv_exit=$?
if [ "$_ncenv_exit" -eq 0 ]; then
  pass "docker-compose.yml: nextcloud has no env_file and exactly the allowlisted environment (WARP-3585)"
else
  fail "docker-compose.yml: nextcloud environment is not the allowlist (WARP-3585)"
  printf "${_RED}%s${_RESET}\n" "$_ncenv_output" >&2
fi

# =============================================================================
# Test 22c: WARP-3586 — Nextcloud enforces a public-link expiry on every start
# =============================================================================
# The orchestrator route caps links at 90 days, but Nextcloud's own endpoints
# are reachable too; nextcloud-init.sh (run on every start) sets the same
# ceiling. MUTATION: delete any of the three settings and this goes red.
_NC_INIT_SHARE="$REPO_ROOT/docker/nextcloud-init.sh"
_share_missing=""
for _kv in shareapi_default_expire_date=yes shareapi_enforce_expire_date=yes shareapi_expire_after_n_days=90; do
  grep -qF "\"$_kv\"" "$_NC_INIT_SHARE" || _share_missing+="$_kv "
done
if [ -z "$_share_missing" ]; then
  pass "nextcloud-init.sh sets the public-link expiry policy on every start (WARP-3586)"
else
  fail "nextcloud-init.sh is missing share expiry settings (WARP-3586): $_share_missing"
fi

# =============================================================================
# Test 23: WARP-3193 SEC-DATA-12 — secrets stay off process command lines
# =============================================================================
# /proc/<pid>/cmdline is world-readable, container processes included when
# viewed from the host. Where the tool can take the secret another way, it
# must: `docker exec -e NAME` (value from the caller's env) instead of
# `-e NAME="$VALUE"`, and `occ config:import <0600 file>` instead of
# `occ config:app:set … --value="$SECRET"`.
# MUTATION: restore `-e OPENWRT_ROOT_PW="$OPENWRT_ROOT_PW"` and this goes red.
_argv_secret_bad=""
_ATTACH="$REPO_ROOT/scripts/host/usr-local-sbin/droplet-openwrt-attach"
_NC_INIT="$REPO_ROOT/docker/nextcloud-init.sh"
if grep -nE -- '-e (OPENWRT_ROOT_PW|AP_PSK|GUEST_PSK)=' "$_ATTACH" >/dev/null; then
  _argv_secret_bad+="droplet-openwrt-attach: docker exec -e NAME=\$SECRET "
fi
if grep -nE -- '--value="?\$\{?[A-Z_]*(SECRET|PASSWORD|_PSK|TOKEN)' "$_NC_INIT" >/dev/null; then
  _argv_secret_bad+="nextcloud-init.sh: occ --value=\$SECRET "
fi
if [ -z "$_argv_secret_bad" ]; then
  pass "no secret passed as a command-line argument at the SEC-DATA-12 sites"
else
  fail "secret on a command line (SEC-DATA-12): $_argv_secret_bad"
fi

# =============================================================================
# Test 24: WARP-3193 SEC-DATA-14 — the OpenWrt overlay ships no Wi-Fi PSK
# =============================================================================
# openwrt/files/etc/config/wireless is copied verbatim into every image built
# from it, so any `option key` there is one PSK shared by every such box. The
# single-box shape generates a per-box PSK at runtime; the overlay's AP
# sections ship with a blank key and `disabled '1'`.
# MUTATION: set default_radio3's key back to 'ChangeMe!2024'.
_WIRELESS="$REPO_ROOT/openwrt/files/etc/config/wireless"
_psk_bad=$(awk '
  /^config /             { sec=$3; iface=($2=="wifi-iface"); next }
  iface && /^[[:space:]]*option key /  { k=$0; sub(/^[^'"'"']*'"'"'/, "", k); sub(/'"'"'.*$/, "", k); if (k != "") print sec " has a static key" }
  iface && /^[[:space:]]*option disabled .0./ { print sec " is enabled" }
' "$_WIRELESS")
if [ -z "$_psk_bad" ]; then
  pass "openwrt overlay: every AP ships disabled with no static PSK (SEC-DATA-14)"
else
  fail "openwrt overlay ships a static/enabled Wi-Fi AP (SEC-DATA-14): $(printf '%s' "$_psk_bad" | tr '\n' ';')"
fi

# =============================================================================
# Test 25: WARP-3516 — the samba share never maps unknown logins to guest
# =============================================================================
# The servercontainers/samba entrypoint defaults `map to guest = Bad User`
# when SAMBA_CONF_MAP_TO_GUEST is unset, so Windows' first logon (the PC's own
# account, unknown to Samba) got a GUEST session. Windows 11 24H2+ refuses an
# unsigned guest session and gives up without prompting for the `droplet`
# password; `Never` returns LOGON_FAILURE instead, which makes it prompt.
# MUTATION: delete SAMBA_CONF_MAP_TO_GUEST from the samba service (or set it
# to `Bad User`) and this goes red.
_samba_exit=0
_samba_output=$(python3 - "$COMPOSE_FILE" <<'PYEOF' 2>&1
import sys, yaml

with open(sys.argv[1], encoding="utf-8") as f:
    data = yaml.safe_load(f)

samba = (data.get("services") or {}).get("samba")
if not isinstance(samba, dict):
    print("services.samba is missing")
    sys.exit(1)

env = samba.get("environment") or []
if isinstance(env, list):
    env = dict(str(e).split("=", 1) for e in env if "=" in str(e))
got = env.get("SAMBA_CONF_MAP_TO_GUEST")
if got != "Never":
    print(f"samba must set SAMBA_CONF_MAP_TO_GUEST=Never, got {got!r}")
    sys.exit(1)
PYEOF
) || _samba_exit=$?

if [ "$_samba_exit" -eq 0 ]; then
  pass "docker-compose.yml: samba never maps unknown logins to guest (WARP-3516)"
else
  fail "docker-compose.yml: samba must set SAMBA_CONF_MAP_TO_GUEST=Never (WARP-3516)"
  printf "${_RED}%s${_RESET}\n" "$_samba_output" >&2
fi

# =============================================================================
# Test 26: HA-3 — the hosted-app TLS origin is relay-only, bounded and does
# not log single-use exchange credentials. Removing ANY invariant is a failure.
# =============================================================================
_hosted_exit=0
_hosted_output=$(python3 - "$COMPOSE_FILE" "$REPO_ROOT/docker/nginx/nginx.conf" <<'PYEOF' 2>&1
import re, sys, yaml
from pathlib import Path
compose = yaml.safe_load(Path(sys.argv[1]).read_text(encoding='utf-8'))
services = compose['services']
ports = services['gateway'].get('ports', [])
assert '8443:8443' in ports, 'gateway must publish hosted TLS :8443'
assert not services['sandbox'].get('ports'), 'app processes must never publish a port'
env = services['orchestrator'].get('environment', [])
assert 'SANDBOX_PROCESS_SUPERVISION=${SANDBOX_PROCESS_SUPERVISION:-0}' in env, 'orchestrator supervision gate must match sandbox'
text = re.sub(r'#[^\n]*', '', Path(sys.argv[2]).read_text(encoding='utf-8'))
starts = list(re.finditer(r'server\s*\{\s*listen\s+8443\s+ssl\s*;', text))
assert len(starts) == 1, 'exactly one hosted TLS server is required'
start = starts[0].start()
depth = 0
seen = False
for end in range(start, len(text)):
    if text[end] == '{': depth += 1; seen = True
    elif text[end] == '}':
        depth -= 1
        if seen and depth == 0: break
block = text[start:end + 1]
assert len(re.findall(r'\blocation\s+', block)) == 1 and 'location / {' in block, 'hosted listener serves only its relay location'
assert len(re.findall(r'\bproxy_pass\s+', block)) == 1, 'only one hosted upstream is allowed'
assert '"orchestrator:3000"' in block and 'proxy_pass $internal_scheme://$upstream_hosted_orchestrator;' in block, 'hosted traffic must preserve internal mTLS policy'
for directive in ('access_log off;', 'error_log /dev/null;', 'proxy_buffering off;', 'proxy_request_buffering off;',
                  'client_max_body_size 32m;', 'proxy_read_timeout 60s;', 'proxy_set_header X-Forwarded-Port 8443;',
                  'proxy_set_header X-Droplet-Hosted-Ingress 8443;', 'proxy_set_header Authorization "";',
                  'proxy_set_header Upgrade "";', 'include /etc/nginx/cipher-profile.active.conf;'):
    assert directive in block, 'missing hosted invariant: ' + directive
assert 'rewrite ^/(.*)$ /api/hosted/relay/$1 break;' in block, 'hosted origin must route only through authenticated relay'
assert 'proxy_set_header X-Droplet-Hosted-Ingress "";' in text, 'dashboard ingress must overwrite forged hosted marker'
imports = re.findall(r'location\s*=\s*/api/workspace/import\s*\{([^}]*)\}', text)
assert len(imports) == 1, 'exactly one dashboard archive import location is required'
for directive in ('client_max_body_size 257m;', 'proxy_request_buffering off;',
                  'set $upstream_orchestrator "orchestrator:3000";', 'proxy_pass $internal_scheme://$upstream_orchestrator;',
                  'proxy_set_header Authorization $http_authorization;', 'proxy_set_header Host $host;',
                  'proxy_set_header X-Forwarded-Port $server_port;', 'proxy_set_header X-Droplet-Hosted-Ingress "";',
                  'proxy_read_timeout 360s;', 'proxy_send_timeout 360s;'):
    assert directive in imports[0], 'missing archive import invariant: ' + directive
PYEOF
) || _hosted_exit=$?
if [ "$_hosted_exit" -eq 0 ]; then
  pass "hosted TLS :8443 is relay-only, credential-safe and bounded (HA-3)"
else
  fail "hosted TLS origin security invariants failed (HA-3)"
  printf '%s\n' "$_hosted_output" >&2
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
