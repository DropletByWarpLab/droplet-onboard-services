#!/usr/bin/env bash
# =============================================================================
# WARP-2985 — migrate_env gives every box a per-device DEVICE_SECRET, once,
# and never rotates a real one.
# =============================================================================
#
# THE INVARIANT:
#   After setup.sh, DEVICE_SECRET in .env is non-empty and not a publicly-known
#   value. A real value is never rewritten (rotating it orphans unclaimed claim
#   codes, live clip links and every stored BYOK cloud key). The value never
#   reaches the setup log.
#
# WHY: the orchestrator now refuses to boot on DROPLET_ENV=production with a
# missing/public DEVICE_SECRET, and the claim-code HMAC no longer falls back
# to the literal "dev-only-not-secure". The backfill is how a box whose .env
# lacks one (operator-authored, or copied from .env.example) recovers with a
# plain `setup.sh --sync-secrets`.
#
# Runs the REAL migrate_env out of scripts/lib/secrets.sh in a temp REPO_ROOT;
# no docker, no root, no network.
# =============================================================================
set -uo pipefail

REPO_ROOT_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="$REPO_ROOT_REAL/scripts/lib/secrets.sh"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-2985: DEVICE_SECRET is backfilled once and never rotated ===\n\n'

if grep -qE '"tests/device-secret-backfill.test.sh"' "$REPO_ROOT_REAL/.github/workflows/setup-tests.yml" \
   && grep -qE 'run: bash tests/device-secret-backfill.test.sh' "$REPO_ROOT_REAL/.github/workflows/setup-tests.yml"; then
  ok "this suite is wired into setup-tests.yml (paths + run step)"
else
  bad "this suite is not wired into setup-tests.yml — it would run nowhere (WARP-2647 class)"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export REPO_ROOT="$TMP/repo"
mkdir -p "$REPO_ROOT/.data"
cp "$REPO_ROOT_REAL/.env.example" "$REPO_ROOT/.env.example"
LOG_FILE="$REPO_ROOT/.data/setup.log"; export LOG_FILE
# shellcheck source=../scripts/lib/logging.sh
source "$REPO_ROOT_REAL/scripts/lib/logging.sh"
# shellcheck source=../scripts/lib/secrets.sh
source "$SECRETS"
_write_mosquitto_conf() { return 0; }
_write_mosquitto_acl()  { return 0; }
_generate_tls_cert()    { return 0; }

ENV="$REPO_ROOT/.env"
secret_now() { grep -E '^DEVICE_SECRET=' "$ENV" | tail -1 | cut -d= -f2-; }
is_usable() {
  case "$1" in
    ""|change-me|dev-only-not-secure|dev-secret-change-in-production|dev-only-device-secret-do-not-ship) return 1 ;;
  esac
  return 0
}
set_secret_line() { # replace every DEVICE_SECRET line with "$1" (a full line, or "" to delete)
  { grep -vE '^DEVICE_SECRET=' "$ENV" || true; } > "$ENV.t"
  [ -n "$1" ] && printf '%s\n' "$1" >> "$ENV.t"
  mv "$ENV.t" "$ENV"
}

if ! generate_env >/dev/null 2>&1 || [ ! -f "$ENV" ]; then
  bad "generate_env failed — cannot run the backfill cases"
  printf '\n%d passed, %d failed\n\n' "$pass" "$fail"; exit 1
fi
if is_usable "$(secret_now)"; then
  ok "generate_env writes a per-device DEVICE_SECRET"
else
  bad "generate_env wrote no usable DEVICE_SECRET"
fi

# --- absent / empty / public → a fresh value, exactly one line --------------
for case_ in "absent|" "empty|DEVICE_SECRET=" "placeholder|DEVICE_SECRET=change-me" \
             "old claim literal|DEVICE_SECRET=dev-only-not-secure" \
             "old ai-gateway literal|DEVICE_SECRET=dev-secret-change-in-production" \
             "whitespace|DEVICE_SECRET=   "; do
  label="${case_%%|*}"; line="${case_#*|}"
  set_secret_line "$line"
  : > "$LOG_FILE"
  migrate_env >/dev/null 2>&1 || true
  v="$(secret_now)"
  if is_usable "$v" && [ "$(grep -cE '^DEVICE_SECRET=' "$ENV")" = "1" ]; then
    ok "$label DEVICE_SECRET → backfilled with a fresh value (one line)"
  else
    bad "$label DEVICE_SECRET → '$(grep -cE '^DEVICE_SECRET=' "$ENV") line(s)', usable=$(is_usable "$v" && echo y || echo n)"
  fi
  if [ -n "$v" ] && grep -qF -- "$v" "$LOG_FILE" 2>/dev/null; then
    bad "$label: the generated DEVICE_SECRET value reached the setup log"
  else
    ok "$label: the value never reaches the setup log"
  fi
done

# Two backfills never produce the same value (it is random, not a constant).
set_secret_line ""; migrate_env >/dev/null 2>&1 || true; first="$(secret_now)"
set_secret_line ""; migrate_env >/dev/null 2>&1 || true; second="$(secret_now)"
if [ "$first" != "$second" ]; then
  ok "backfilled values are random per run, not a shared constant"
else
  bad "two backfills produced the same DEVICE_SECRET"
fi

# --- a real value is NEVER rewritten, and a re-run is a byte-level no-op ----
set_secret_line "DEVICE_SECRET=a-real-per-device-secret-0123456789abcdef"
migrate_env >/dev/null 2>&1 || true
cp "$ENV" "$TMP/after-first"
migrate_env >/dev/null 2>&1 || true
if [ "$(secret_now)" = "a-real-per-device-secret-0123456789abcdef" ]; then
  ok "a real DEVICE_SECRET is kept verbatim"
else
  bad "migrate_env rotated a real DEVICE_SECRET"
fi
if cmp -s "$ENV" "$TMP/after-first"; then
  ok "a second migrate_env run leaves .env byte-identical (idempotent)"
else
  bad "a second migrate_env run changed .env"
fi

printf '\n%d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
