#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — Postgres TLS 1.3 + SCRAM + hostssl-only (WARP-233)
# =============================================================================
#
# Dockerized integration test. Spins up a throwaway pgvector/pgvector:pg16
# container with the SAME launch shape the compose `db` service gets in Task A2
# (bash -c 'install certs … exec docker-entrypoint.sh postgres -c ssl=on …')
# and proves:
#   1. plaintext TCP is rejected (no hostssl match → pg_hba reject line),
#   2. TLS TCP is accepted AND negotiates TLS 1.3,
#   3. password_encryption is scram-sha-256 and the droplet role holds a
#      SCRAM verifier,
#   4. (static, no docker) every DATABASE_URL producer pins sslmode=require.
#
# Requires local Docker for tests 1-3. Test 4 is pure grep. If Docker is
# unreachable, tests 1-3 SKIP (reported, non-fatal) so the static guard still
# runs on a dev box without a daemon; the live run is in the PR's deferred
# stack-verification section.
#
# ci: developer-only — pulls pgvector/pgvector:pg16 (~450 MB) and boots the
# database once per case. The Docker-free case 4 (every DATABASE_URL producer
# pins sslmode=require) is the half worth gating on every PR and is the
# natural follow-up; wiring the whole suite would put a multi-minute image
# pull on a large share of PRs under the $100/month cap (WARP-2647).
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMG=pgvector/pgvector:pg16
NAME=droplet-pgtls-test
HBA="$REPO_ROOT_REAL/docker/postgres/pg_hba.conf"
HBA_FIPS="$REPO_ROOT_REAL/docker/postgres/pg_hba.fips.conf"

# --- Colors ---
if [ -t 1 ]; then
  _GREEN='\033[0;32m'; _RED='\033[0;31m'; _YELLOW='\033[0;33m'; _BOLD='\033[1m'; _RESET='\033[0m'
else
  _GREEN=''; _RED=''; _YELLOW=''; _BOLD=''; _RESET=''
fi

TOTAL=0; PASSED=0; FAILED=0; SKIPPED=0
FAILED_NAMES=()
_pass() { PASSED=$((PASSED + 1)); printf "  ${_GREEN}PASS${_RESET}  %s\n" "$1"; }
_fail() { FAILED=$((FAILED + 1)); FAILED_NAMES+=("$1"); printf "  ${_RED}FAIL${_RESET}  %s\n" "$1"; }
_skip() { SKIPPED=$((SKIPPED + 1)); printf "  ${_YELLOW}SKIP${_RESET}  %s\n" "$1"; }

_run_test() {
  local name="$1"; shift
  TOTAL=$((TOTAL + 1))
  printf "\n${_BOLD}→ %s${_RESET}\n" "$name"
  if "$@"; then _pass "$name"; else _fail "$name"; fi
}

_docker_up() { docker info >/dev/null 2>&1; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

SANDBOX=""
# start_db <sandbox> [hba_file] — boots the throwaway db with the given
# pg_hba (defaults to the TLS-only production file).
start_db() {
  local sandbox="$1" hba="${2:-$HBA}"
  # Issue the db bundle with the SAME WARP-236 internal CA the compose stack
  # uses (scripts/lib/internal-ca.sh; one trust root, no parallel CA). The
  # container-side `install` re-owns the key for uid 999 so this works on
  # macOS Docker Desktop too (host chown 999 is Linux-only).
  # The lib needs log_* stubs + REPO_ROOT set BEFORE sourcing (its *_DIR
  # defaults are computed at source time) and still set at call time
  # (internal_ca_ensure chmods "$REPO_ROOT/data/secrets").
  log_info() { :; }; log_warn() { :; }; log_success() { :; }
  REPO_ROOT="$sandbox"
  # shellcheck source=/dev/null
  source "$REPO_ROOT_REAL/scripts/lib/internal-ca.sh"
  internal_ca_ensure
  internal_ca_issue db
  docker run -d --name "$NAME" \
    -e POSTGRES_USER=droplet -e POSTGRES_PASSWORD=pgtls-test-pw -e POSTGRES_DB=droplet \
    -v "$sandbox/data/secrets/service-tls/db:/certs-src:ro" \
    -v "$hba:/etc/postgresql/pg_hba.conf:ro" \
    "$IMG" \
    bash -c 'install -o postgres -g postgres -m 600 /certs-src/key.pem /tmp/server.key
             install -o postgres -g postgres -m 644 /certs-src/cert.pem /tmp/server.crt
             exec docker-entrypoint.sh postgres \
               -c ssl=on \
               -c ssl_cert_file=/tmp/server.crt \
               -c ssl_key_file=/tmp/server.key \
               -c ssl_min_protocol_version=TLSv1.3 \
               -c password_encryption=scram-sha-256 \
               -c hba_file=/etc/postgresql/pg_hba.conf' >/dev/null || return 1
  local i; for i in $(seq 1 60); do
    docker exec "$NAME" psql -U droplet -d droplet -c 'SELECT 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

test_plaintext_tcp_rejected() {
  # Capture-then-grep (NOT a pipeline): under `set -o pipefail` the expected
  # psql failure (exit 2) would fail the pipeline even when grep matches.
  # The explicit terminal `reject` line makes the server say "pg_hba.conf
  # rejects connection ... no encryption" (a matched reject), not the
  # no-match wording "no pg_hba.conf entry".
  local out
  out="$(docker exec -e PGPASSWORD=pgtls-test-pw "$NAME" \
    psql "host=127.0.0.1 sslmode=disable user=droplet dbname=droplet" -c 'SELECT 1' 2>&1)" || true
  grep -q 'pg_hba.conf rejects connection.*no encryption' <<<"$out"
}

test_tls_tcp_accepted_and_tls13() {
  docker exec -e PGPASSWORD=pgtls-test-pw "$NAME" \
    psql "host=127.0.0.1 sslmode=require user=droplet dbname=droplet" -tA \
    -c "SELECT ssl AND version = 'TLSv1.3' FROM pg_stat_ssl WHERE pid = pg_backend_pid()" \
    | grep -qx t
}

test_scram_verifier_and_setting() {
  docker exec "$NAME" psql -U droplet -d droplet -tA \
    -c "SHOW password_encryption" | grep -qx 'scram-sha-256' || return 1
  docker exec "$NAME" psql -U droplet -d droplet -tA \
    -c "SELECT rolpassword LIKE 'SCRAM-SHA-256\$%' FROM pg_authid WHERE rolname='droplet'" \
    | grep -qx t
}

# FIPS P1011 variant (WARP-318 decision A): with pg_hba.fips.conf served,
# plaintext TCP from container-local ranges is ACCEPTED but still SCRAM-authed
# (a wrong password must fail), and TLS 1.3 keeps working for capable clients.
test_fips_hba_plaintext_scram() {
  local out
  docker exec -e PGPASSWORD=pgtls-test-pw "$NAME" \
    psql "host=127.0.0.1 sslmode=disable user=droplet dbname=droplet" -tAc 'SELECT 1' \
    | grep -qx 1 || return 1
  # Capture-then-grep: pipefail would swallow the expected psql failure.
  out="$(docker exec -e PGPASSWORD=wrong-password "$NAME" \
    psql "host=127.0.0.1 sslmode=disable user=droplet dbname=droplet" -c 'SELECT 1' 2>&1)" || true
  grep -q 'password authentication failed' <<<"$out" || return 1
  docker exec -e PGPASSWORD=pgtls-test-pw "$NAME" \
    psql "host=127.0.0.1 sslmode=require user=droplet dbname=droplet" -tA \
    -c "SELECT ssl AND version = 'TLSv1.3' FROM pg_stat_ssl WHERE pid = pg_backend_pid()" \
    | grep -qx t
}

# Static guard — no docker. Runs unconditionally.
test_database_url_producers_pin_sslmode() {
  grep -q 'DATABASE_URL=postgresql://droplet:${pg_password}@db:5432/droplet?sslmode=require' \
    "$REPO_ROOT_REAL/scripts/lib/secrets.sh" || return 1
  # file-indexer inline URL: sslmode keyed on PG_SSLMODE with require as the
  # DEFAULT — the FIPS `disable` value must never become the fallback.
  grep -q 'DATABASE_URL=postgresql://droplet:${POSTGRES_PASSWORD}@db:5432/droplet?sslmode=${PG_SSLMODE:-require}' \
    "$REPO_ROOT_REAL/docker/docker-compose.yml" || return 1
  # email-indexer compose fallback must not silently regress to plaintext
  grep -q 'DATABASE_URL=${DATABASE_URL:-postgresql://droplet:droplet@db:5432/droplet?sslmode=require}' \
    "$REPO_ROOT_REAL/docker/docker-compose.yml" || return 1
}

# =============================================================================
# Driver
# =============================================================================
printf "\n  ${_BOLD}Postgres TLS 1.3 + SCRAM + hostssl-only integration suite${_RESET}\n"
printf "  Real repo: %s\n" "$REPO_ROOT_REAL"
printf "  ──────────────────────────────────\n"

if _docker_up; then
  SANDBOX="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "cleanup; rm -rf '$SANDBOX'" EXIT
  printf "\n${_BOLD}→ boot db container (TLS/scram launch shape)${_RESET}\n"
  TOTAL=$((TOTAL + 1))
  if start_db "$SANDBOX"; then
    _pass "db container booted"
    _run_test "plaintext TCP is rejected by pg_hba" test_plaintext_tcp_rejected
    _run_test "TLS TCP accepted and negotiates TLS 1.3" test_tls_tcp_accepted_and_tls13
    _run_test "password_encryption=scram-sha-256 + role holds SCRAM verifier" test_scram_verifier_and_setting
  else
    _fail "db container failed to boot"
  fi
  # Second boot with the FIPS-variant hba (WARP-318 P1011 decision A):
  # a FIPS-mode box must still boot AND still SCRAM its plaintext hop.
  cleanup
  printf "\n${_BOLD}→ boot db container (FIPS pg_hba.fips.conf variant)${_RESET}\n"
  TOTAL=$((TOTAL + 1))
  if start_db "$SANDBOX" "$HBA_FIPS"; then
    _pass "db container booted with pg_hba.fips.conf"
    _run_test "FIPS hba: plaintext accepted from container-local, still SCRAM-authed; TLS 1.3 intact" \
      test_fips_hba_plaintext_scram
  else
    _fail "db container failed to boot with pg_hba.fips.conf"
  fi
else
  printf "\n  ${_YELLOW}Docker daemon unreachable — skipping the 5 dockerized TLS/SCRAM tests${_RESET}\n"
  printf "  ${_YELLOW}(run on a box with Docker; see the PR's deferred stack-verification section)${_RESET}\n"
  _skip "plaintext TCP is rejected by pg_hba"
  _skip "TLS TCP accepted and negotiates TLS 1.3"
  _skip "password_encryption=scram-sha-256 + role holds SCRAM verifier"
  _skip "FIPS hba: plaintext accepted from container-local, still SCRAM-authed; TLS 1.3 intact"
fi

_run_test "every DATABASE_URL producer pins sslmode=require (static)" \
  test_database_url_producers_pin_sslmode

printf "\n  ──────────────────────────────────\n"
printf "  Results: %d/%d passed" "$PASSED" "$TOTAL"
[ "$SKIPPED" -gt 0 ] && printf "  ${_YELLOW}(%d skipped — no docker)${_RESET}" "$SKIPPED"
if [ "$FAILED" -gt 0 ]; then
  printf "  ${_RED}(%d failed)${_RESET}\n" "$FAILED"
  printf "  Failed: %s\n" "${FAILED_NAMES[*]}"
  exit 1
fi
printf "  ${_GREEN}(all runnable passed)${_RESET}\n"
exit 0
