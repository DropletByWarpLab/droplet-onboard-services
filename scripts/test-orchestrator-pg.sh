#!/usr/bin/env bash
# =============================================================================
# scripts/test-orchestrator-pg.sh — real-Postgres vitest lane (WARP-1026).
#
# Boots a throwaway Postgres, applies the orchestrator's full Prisma
# migration set, then runs the pg-gated vitest files (src/**/*.pg.test.ts,
# self-gated on RUN_PG_INTEGRATION=1).
#
# Backend selection:
#   * Docker present  -> throwaway `pgvector/pgvector:pg16` container
#     (matches CI).
#   * Docker absent   -> throwaway NATIVE cluster via initdb/pg_ctl
#     (Homebrew postgresql@14+ on PATH). The concurrency behaviour under
#     test — SELECT ... FOR UPDATE vs pg_advisory_xact_lock under READ
#     COMMITTED — is identical across PG 14/16, so the proof is valid on
#     either backend. NOTE: the migration set runs `CREATE EXTENSION IF
#     NOT EXISTS vector` (20260412000000_add_file_content_index), so the
#     native server needs pgvector installed (e.g. `brew install pgvector`);
#     the Docker backend gets it from the image. CI always uses the
#     pgvector/pgvector:pg16 service container.
#
# Prerequisites: Node on the host; plus EITHER Docker OR a local
# PostgreSQL server (initdb/pg_ctl/pg_isready on PATH). Runtime: ~60-90 s.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SUFFIX="$$"
PG_PORT="${DROPLET_PG_TEST_PORT:-55486}"
PG_USER="droplet_test"
PG_PASSWORD="droplet_test_pw"
PG_DB="droplet_test"
export DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}?schema=public"

# WARP-1571 / WARP-1575 — readiness probe for the Docker backend's throwaway
# Postgres. MUST stay TCP-gated: on a cold volume the postgres entrypoint runs
# a temporary init server that listens on the unix socket ONLY, so a socket
# probe reports ready mid-initdb and the next client lands in the shutdown
# window. The temp server never binds TCP, so -h 127.0.0.1 cannot match it.
# Guarded by apps/orchestrator/src/__tests__/pg-lane-image-parity.test.ts.
PG_READY_PROBE=(pg_isready -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB")

# Predeclared so EXIT traps referencing them are safe under `set -u`.
PG_BIN=""
DATA_DIR=""
SOCK_DIR=""

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

run_pg_tests() {
  echo "--- prisma migrate deploy ---"
  (cd "$REPO_ROOT/apps/orchestrator" && npx prisma migrate deploy)

  echo "--- vitest (pg-gated files) ---"
  # Keep this env in lockstep with the pg-integration job in
  # .github/workflows/orchestrator-tests.yml — erp-api-e2e.pg.test.ts drives the
  # real Express app over HTTP, so it needs the app configured (auth off, and an
  # encryption key for the stored ERP credentials), not just a database. The
  # rationale is spelled out in that workflow.
  #
  # The key is minted per run, never committed: the suite encrypts and decrypts
  # within one process, so a stable value buys nothing and a literal here would
  # be a key checked into the repo.
  #
  # --no-file-parallelism: the pg files share ONE database, and
  # rbac-v2-guard-rails.pg.test.ts asserts a BOX-WIDE invariant (rail 5 — "is
  # any ACTIVE operator left") that no per-suite prefix can scope. Run in
  # parallel forks, another suite's in-flight ACTIVE admin/owner rows
  # (tx-isolation, team-chat*) are live COMMITTED rows that rbac counts as
  # foreign operators, turning its last-operator refusals into false failures.
  # Serializing the files keeps each suite's operators off the DB while any
  # other pg suite runs. Keep in lockstep with the pg-integration job in
  # .github/workflows/orchestrator-tests.yml.
  RUN_PG_INTEGRATION=1 \
  AUTH_ENABLED=false \
  DEVICE_SECRET_KEY="$(openssl rand -base64 32)" \
    npm run -w @droplet/orchestrator test -- pg.test --no-file-parallelism
}

# ---------------------------------------------------------------------------
# Backend A: Docker (pgvector/pgvector:pg16), matches CI.
#
# WARP-1541: the image MUST stay identical to the pg-integration job in
# .github/workflows/orchestrator-tests.yml. Plain postgres:16 does not ship
# the pgvector extension, so `prisma migrate deploy` fails on
# 20260412000000_add_file_content_index (`CREATE EXTENSION ... vector`).
# Parity is pinned by
# apps/orchestrator/src/__tests__/pg-lane-image-parity.test.ts.
# ---------------------------------------------------------------------------
run_with_docker() {
  local PG_CONTAINER="droplet-warp1026-pg-$SUFFIX"
  cleanup() { docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  echo "--- booting throwaway pgvector/pgvector:pg16 container on :${PG_PORT} ---"
  docker run -d --rm \
    --name "$PG_CONTAINER" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB="$PG_DB" \
    -p "${PG_PORT}:5432" \
    pgvector/pgvector:pg16 >/dev/null

  for i in $(seq 1 30); do
    if docker exec "$PG_CONTAINER" "${PG_READY_PROBE[@]}" >/dev/null 2>&1; then
      break
    fi
    [ "$i" = 30 ] && { echo "postgres did not become ready" >&2; exit 1; }
    sleep 1
  done

  run_pg_tests
}

# ---------------------------------------------------------------------------
# Backend B: native throwaway cluster (initdb/pg_ctl), no Docker required.
# ---------------------------------------------------------------------------
run_with_native_pg() {
  # macOS: a Homebrew postmaster aborts with "became multithreaded during
  # startup" unless a concrete UTF-8 locale is set. Harmless on Linux.
  export LC_ALL="${LC_ALL:-en_US.UTF-8}"
  export LANG="${LANG:-en_US.UTF-8}"

  # Script-global (NOT local) so the EXIT trap, which fires outside this
  # function's scope, still sees them under `set -u`.
  PG_BIN="$(dirname "$(command -v initdb)")"
  DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/droplet-warp1026-pgdata.XXXXXX")"
  SOCK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/droplet-warp1026-pgsock.XXXXXX")"

  cleanup() {
    [ -n "$PG_BIN" ] && [ -d "$DATA_DIR" ] &&
      "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
    # Belt-and-braces: if pg_ctl couldn't stop it, kill by pidfile so no
    # throwaway postmaster leaks onto the test port.
    if [ -f "$DATA_DIR/postmaster.pid" ]; then
      kill "$(head -1 "$DATA_DIR/postmaster.pid")" >/dev/null 2>&1 || true
    fi
    [ -n "$DATA_DIR" ] && rm -rf "$DATA_DIR" "$SOCK_DIR" || true
  }
  trap cleanup EXIT

  echo "--- initdb throwaway native cluster ($("$PG_BIN/postgres" --version)) ---"
  local PWFILE="$SOCK_DIR/pw"
  printf '%s' "$PG_PASSWORD" > "$PWFILE"
  "$PG_BIN/initdb" -D "$DATA_DIR" -U "$PG_USER" \
    --auth=trust --pwfile="$PWFILE" >/dev/null
  rm -f "$PWFILE"

  echo "--- starting postgres on :${PG_PORT} ---"
  "$PG_BIN/pg_ctl" -D "$DATA_DIR" -w -o \
    "-p ${PG_PORT} -k ${SOCK_DIR} -c listen_addresses=localhost" \
    start >/dev/null

  for i in $(seq 1 30); do
    if "$PG_BIN/pg_isready" -h localhost -p "$PG_PORT" -U "$PG_USER" >/dev/null 2>&1; then
      break
    fi
    [ "$i" = 30 ] && { echo "postgres did not become ready" >&2; exit 1; }
    sleep 1
  done

  "$PG_BIN/createdb" -h localhost -p "$PG_PORT" -U "$PG_USER" "$PG_DB"

  run_pg_tests
}

if docker_available; then
  run_with_docker
elif command -v initdb >/dev/null 2>&1; then
  echo "--- Docker unavailable; using native throwaway Postgres cluster ---"
  run_with_native_pg
else
  echo "ERROR: need either Docker or a local PostgreSQL (initdb on PATH)." >&2
  exit 1
fi
