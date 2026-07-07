#!/usr/bin/env bash
# =============================================================================
# WARP-318 — unit tests for the DROPLET_FIPS_MODE customer knob.
#
# Drives scripts/lib/secrets.sh's `apply_fips_mode <on|off>` env-write helper
# in isolation against a sandbox .env (the same way tests/setup.test.sh
# exercises generate_env). Does NOT require Docker or a running stack.
# Runtime: < 2 seconds.
#
# The knob is the single per-customer FIPS activation point (default OFF).
# `apply_fips_mode` translates it into the derived per-service activation env
# (OPENSSL_CONF / DROPLET_FIPS_REQUIRED / OPENSSL_MODULES / NODE_OPTIONS),
# reusing the WARP-595 atomic staged-rename upsert so flips are idempotent,
# interruption-safe, and reversible in both directions.
# =============================================================================
set -uo pipefail  # NOT -e: assertions report + continue (flat harness convention)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
TESTS=0
FAILURES=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  WARP-318 FIPS-mode knob unit tests"
echo "  ================================================"
echo ""

# --- Isolated sandbox: a temp REPO_ROOT with a temp .env ---------------------
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/.data"

# secrets.sh needs REPO_ROOT + logging; stub the Docker/openssl-dependent
# helpers that only matter for full generate_env (we exercise apply_fips_mode).
export REPO_ROOT="$TMP_ROOT"
LOG_FILE="$TMP_ROOT/.data/setup.log"
export LOG_FILE
# shellcheck source=../scripts/lib/logging.sh
source "$REPO_ROOT_REAL/scripts/lib/logging.sh"
_write_mosquitto_conf()       { return 0; }
_generate_tls_cert()          { return 0; }
# shellcheck source=../scripts/lib/secrets.sh
source "$REPO_ROOT_REAL/scripts/lib/secrets.sh"

# apply_fips_mode targets $ENV_FILE if set, else $REPO_ROOT/.env.
ENV_FILE="$TMP_ROOT/.env"
export ENV_FILE

# helper: value of a key (last occurrence, matching compose last-wins)
kv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- ; }
# helper: number of lines defining a key
kcount() { grep -cE "^$1=" "$ENV_FILE" 2>/dev/null || true ; }

# =============================================================================
echo "--- Case 1: apply_fips_mode off writes OFF-posture derived vars ---"
# =============================================================================
: > "$ENV_FILE"          # fresh, empty .env — no FIPS knob yet
printf 'EXISTING_KEY=keepme\n' >> "$ENV_FILE"
apply_fips_mode off >/dev/null 2>&1
if [ "$(kv DROPLET_FIPS_MODE)" = "0" ]; then
  pass "off writes DROPLET_FIPS_MODE=0"
else
  fail "off DROPLET_FIPS_MODE expected 0, got '$(kv DROPLET_FIPS_MODE)'"
fi
if [ "$(kv DROPLET_FIPS_REQUIRED)" = "false" ]; then
  pass "off writes DROPLET_FIPS_REQUIRED=false"
else
  fail "off DROPLET_FIPS_REQUIRED expected false, got '$(kv DROPLET_FIPS_REQUIRED)'"
fi
if [ -z "$(kv OPENSSL_CONF)" ]; then
  pass "off leaves OPENSSL_CONF empty"
else
  fail "off OPENSSL_CONF expected empty, got '$(kv OPENSSL_CONF)'"
fi
if [ "$(kv EXISTING_KEY)" = "keepme" ]; then
  pass "off preserves unrelated keys"
else
  fail "off clobbered EXISTING_KEY (got '$(kv EXISTING_KEY)')"
fi

# =============================================================================
echo "--- Case 2: apply_fips_mode on writes all 4 derived activation vars ---"
# =============================================================================
apply_fips_mode on >/dev/null 2>&1
[ "$(kv DROPLET_FIPS_MODE)" = "1" ] \
  && pass "on writes DROPLET_FIPS_MODE=1" \
  || fail "on DROPLET_FIPS_MODE expected 1, got '$(kv DROPLET_FIPS_MODE)'"
[ "$(kv OPENSSL_CONF)" = "/etc/ssl/openssl-fips.cnf" ] \
  && pass "on writes OPENSSL_CONF=/etc/ssl/openssl-fips.cnf" \
  || fail "on OPENSSL_CONF expected /etc/ssl/openssl-fips.cnf, got '$(kv OPENSSL_CONF)'"
[ "$(kv DROPLET_FIPS_REQUIRED)" = "true" ] \
  && pass "on writes DROPLET_FIPS_REQUIRED=true" \
  || fail "on DROPLET_FIPS_REQUIRED expected true, got '$(kv DROPLET_FIPS_REQUIRED)'"
[ "$(kv NODE_OPTIONS)" = "--openssl-shared-config" ] \
  && pass "on writes NODE_OPTIONS=--openssl-shared-config" \
  || fail "on NODE_OPTIONS expected --openssl-shared-config, got '$(kv NODE_OPTIONS)'"
case "$(kv OPENSSL_MODULES)" in
  */ossl-modules) pass "on writes non-empty OPENSSL_MODULES ($(kv OPENSSL_MODULES))" ;;
  *)              fail "on OPENSSL_MODULES expected a *ossl-modules path, got '$(kv OPENSSL_MODULES)'" ;;
esac

# =============================================================================
echo "--- Case 3: on is idempotent (single row per key) ---"
# =============================================================================
apply_fips_mode on >/dev/null 2>&1   # second run
dup_ok=true
for k in DROPLET_FIPS_MODE OPENSSL_CONF DROPLET_FIPS_REQUIRED OPENSSL_MODULES NODE_OPTIONS; do
  [ "$(kcount "$k")" = "1" ] || { dup_ok=false; break; }
done
$dup_ok \
  && pass "on twice → exactly one line per derived key" \
  || fail "on twice produced a duplicate row (key=$k count=$(kcount "$k"))"

# =============================================================================
echo "--- Case 4: on → off converges every derived var back to OFF ---"
# =============================================================================
apply_fips_mode off >/dev/null 2>&1
conv_ok=true
[ "$(kv DROPLET_FIPS_MODE)" = "0" ]      || conv_ok=false
[ "$(kv DROPLET_FIPS_REQUIRED)" = "false" ] || conv_ok=false
[ -z "$(kv OPENSSL_CONF)" ]              || conv_ok=false
[ -z "$(kv OPENSSL_MODULES)" ]           || conv_ok=false
[ -z "$(kv NODE_OPTIONS)" ]              || conv_ok=false
$conv_ok \
  && pass "on→off restores all derived vars to OFF values (deactivation-safe)" \
  || fail "on→off did not fully converge (MODE=$(kv DROPLET_FIPS_MODE) CONF='$(kv OPENSSL_CONF)' REQ=$(kv DROPLET_FIPS_REQUIRED) MOD='$(kv OPENSSL_MODULES)' NODE='$(kv NODE_OPTIONS)')"

# =============================================================================
echo "--- Case 5: atomic write leaves no torn .env / no stranded stage ---"
# =============================================================================
# The upsert stages to a sibling .upsert.* file then rename(2)s into place.
# After any completed call there must be no leftover stage file, and .env must
# end in a newline (never a half-written last line).
apply_fips_mode on  >/dev/null 2>&1
apply_fips_mode off >/dev/null 2>&1
stray_stage="$(find "$TMP_ROOT" -maxdepth 1 -name '.env.upsert.*' 2>/dev/null | head -1)"
[ -z "$stray_stage" ] \
  && pass "no stranded .upsert.* staging file after flips" \
  || fail "found stranded staging file: $stray_stage"
if [ -s "$ENV_FILE" ] && [ -z "$(tail -c 1 "$ENV_FILE")" ]; then
  pass ".env ends in a newline (no torn last line)"
else
  fail ".env has no trailing newline — torn write risk"
fi

# =============================================================================
echo "--- Case 6: missing/garbage arg exits non-zero, .env untouched ---"
# =============================================================================
apply_fips_mode on >/dev/null 2>&1
before="$(cat "$ENV_FILE")"
apply_fips_mode garbage >/dev/null 2>&1
rc_garbage=$?
apply_fips_mode >/dev/null 2>&1
rc_missing=$?
after="$(cat "$ENV_FILE")"
[ "$rc_garbage" -ne 0 ] \
  && pass "garbage arg exits non-zero (rc=$rc_garbage)" \
  || fail "garbage arg exited 0 — should reject (explicit boolean, never derived)"
[ "$rc_missing" -ne 0 ] \
  && pass "missing arg exits non-zero (rc=$rc_missing)" \
  || fail "missing arg exited 0 — should reject"
[ "$before" = "$after" ] \
  && pass "rejected call left .env byte-identical" \
  || fail "rejected call mutated .env"

# =============================================================================
echo ""
echo "  ------------------------------------------------"
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mResults: %d passed, 0 failed\033[0m\n" "$TESTS"
  echo "  ------------------------------------------------"
  echo ""
  exit 0
else
  printf "  \033[31mResults: %d passed, %d failed\033[0m\n" "$((TESTS - FAILURES))" "$FAILURES"
  echo "  ------------------------------------------------"
  echo ""
  exit 1
fi
