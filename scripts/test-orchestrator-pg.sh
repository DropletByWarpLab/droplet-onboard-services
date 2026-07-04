#!/usr/bin/env bash
# =============================================================================
# scripts/test-orchestrator-pg.sh — real-Postgres vitest lane (WARP-1026).
#
# Boots a throwaway Postgres, applies the orchestrator's full Prisma
# migration set, then runs the pg-gated vitest files (src/**/*.pg.test.ts,
# self-gated on RUN_PG_INTEGRATION=1).
#
# Backend selection:
#   * Docker present  -> throwaway `postgres:16` container (matches CI).
#   * Docker absent   -> throwaway NATIVE cluster via initdb/pg_ctl
#     (Homebrew postgresql@14+ on PATH). The concurrency behaviour under
#     test — SELECT ... FOR UPDATE vs pg_advisory_xact_lock under READ
#     COMMITTED — is identical across PG 14/16, so the proof is valid on
#     either backend. CI always uses the postgres:16 service container.
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

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

run_pg_tests() {
  echo "--- prisma migrate deploy ---"
  (cd "$REPO_ROOT/apps/orchestrator" && npx prisma migrate deploy)

  echo "--- vitest (pg-gated files) ---"
  RUN_PG_INTEGRATION=1 npm run -w @droplet/orchestrator test -- pg.test
}

# ---------------------------------------------------------------------------
# Backend A: Docker (postgres:16), matches CI.
# ---------------------------------------------------------------------------
run_with_docker() {
  local PG_CONTAINER="droplet-warp1026-pg-$SUFFIX"
  cleanup() { docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  echo "--- booting throwaway postgres:16 container on :${PG_PORT} ---"
  docker run -d --rm \
    --name "$PG_CONTAINER" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB="$PG_DB" \
    -p "${PG_PORT}:5432" \
    postgres:16 >/dev/null

  for i in $(seq 1 30); do
    if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
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

  local PG_BIN
  PG_BIN="$(dirname "$(command -v initdb)")"
  local DATA_DIR
  DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/droplet-warp1026-pgdata.XXXXXX")"
  local SOCK_DIR
  SOCK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/droplet-warp1026-pgsock.XXXXXX")"

  cleanup() {
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$DATA_DIR" "$SOCK_DIR" || true
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
