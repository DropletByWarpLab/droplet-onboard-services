#!/usr/bin/env bash
# =============================================================================
# scripts/test-erp-sql-bridge.sh — real-database lane for services/erp-sql-bridge.
#
# The bridge's whole job is unixODBC + pyodbc I/O, so mocking pyodbc would test
# nothing that can break. It is driven here against a REAL database instead.
#
# WHY POSTGRES AND NOT SQL ANYWHERE
# ---------------------------------
# The SAP SQL Anywhere client (libdbodbc17_r.so) is license-gated and
# account-walled — it cannot be downloaded in CI, or by an agent, and it is
# x86_64-only. But the bridge talks to it through unixODBC, which is
# driver-agnostic: the connection string is assembled per driver
# (db.py:build_connection_string) and everything after `pyodbc.connect` is
# identical. Pointing ERP_ODBC_DRIVER at psqlODBC exercises the pool, the `?`
# binding, the row normalization, the read/write route split, the guards, and
# the error mapping against a live server. What it does NOT cover is the SAP
# connection string itself — that branch is unit-tested, and its first real
# proof is an install with the client present.
#
# The schema is the same synthetic PattersonPM stand-in the SQL-track harness
# uses (services/erp-connector/harness/init/), including its least-privilege
# grants — so `droplet_ro` really is SELECT-only here, and a write attempted on
# a read connection really is refused by the server rather than by a Python
# `if`.
#
# Prerequisites: PostgreSQL server binaries (initdb/pg_ctl), unixODBC + the
# psqlODBC driver ("PostgreSQL Unicode"), Python 3.12+. Runtime: ~20 s.
#
#   Debian/Ubuntu: apt-get install postgresql unixodbc odbc-postgresql
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BRIDGE_DIR="$REPO_ROOT/services/erp-sql-bridge"
HARNESS_INIT="$REPO_ROOT/services/erp-connector/harness/init"

PG_PORT="${ERP_BRIDGE_PG_PORT:-55433}"
PG_SUPERUSER="erpbridge_test"
PG_DB="pattersonpm_mock"

# The harness's own dev credentials, read out of the provisioning script that
# creates the roles rather than copied — so they cannot drift, and so this file
# carries no password literal. They exist only inside a throwaway cluster that
# is destroyed when this script exits.
role_password() {
  sed -n "s/.*CREATE ROLE $1 LOGIN PASSWORD '\([^']*\)'.*/\1/p" "$HARNESS_INIT/03-provision.sql"
}
RO_PASSWORD="$(role_password droplet_ro)"
RW_PASSWORD="$(role_password droplet_rw)"
[ -n "$RO_PASSWORD" ] && [ -n "$RW_PASSWORD" ] || {
  echo "ERROR: could not read the harness role passwords from 03-provision.sql." >&2
  exit 1
}

PG_BIN="$(dirname "$(command -v initdb 2>/dev/null || echo /usr/lib/postgresql/16/bin/initdb)")"
[ -x "$PG_BIN/initdb" ] || { echo "ERROR: initdb not found (install postgresql)." >&2; exit 1; }

# A postmaster refuses to run as root, so under root (containers, this repo's
# agent sandbox) everything postgres-side is dropped to an unprivileged user.
# On a normal dev box / CI runner the script is already unprivileged and these
# collapse to running the command directly.
PG_OWNER="${ERP_BRIDGE_PG_OWNER:-erpbridge}"
if [ "$(id -u)" -eq 0 ]; then
  id -u "$PG_OWNER" >/dev/null 2>&1 || useradd -m "$PG_OWNER"
  RUN_DIR="$(eval echo "~$PG_OWNER")/erp-bridge-test.$$"
  as_pg() { su "$PG_OWNER" -s /bin/bash -c "$*"; }
else
  RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/erp-bridge-test.XXXXXX")"
  as_pg() { bash -c "$*"; }
fi
DATA_DIR="$RUN_DIR/pgdata"
SOCK_DIR="$RUN_DIR/sock"

cleanup() {
  as_pg "'$PG_BIN/pg_ctl' -D '$DATA_DIR' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR" || true
}
trap cleanup EXIT

echo "--- initdb throwaway cluster ($("$PG_BIN/postgres" --version)) ---"
as_pg "mkdir -p '$RUN_DIR' '$SOCK_DIR'"
as_pg "'$PG_BIN/initdb' -D '$DATA_DIR' -U '$PG_SUPERUSER' --auth=trust" >/dev/null

echo "--- starting postgres on :${PG_PORT} ---"
as_pg "'$PG_BIN/pg_ctl' -D '$DATA_DIR' -w -o '-p ${PG_PORT} -k ${SOCK_DIR} -c listen_addresses=127.0.0.1' start" >/dev/null

for i in $(seq 1 30); do
  "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_SUPERUSER" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "postgres did not become ready" >&2; exit 1; }
  sleep 1
done

echo "--- applying the mock PattersonPM schema + least-privilege grants ---"
psql_super() { "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_SUPERUSER" -v ON_ERROR_STOP=1 "$@"; }
psql_super -d postgres -q -c "CREATE DATABASE $PG_DB"
for f in 01-schema.sql 02-seed.sql 03-provision.sql; do
  psql_super -d "$PG_DB" -q -f "$HARNESS_INIT/$f"
done
# 03-provision.sql grants SELECT on the mapped tables but cannot grant CONNECT
# on a database it does not know the name of. Postgres defaults CONNECT to
# PUBLIC, so nothing more is needed for the accounts to log in.

# Every psqlODBC package registers one of these names in /etc/odbcinst.ini.
ODBC_DRIVER="${ERP_ODBC_DRIVER:-}"
if [ -z "$ODBC_DRIVER" ]; then
  for candidate in "PostgreSQL Unicode" "PostgreSQL ANSI" "PostgreSQL"; do
    if odbcinst -q -d 2>/dev/null | tr -d '[]' | grep -qx "$candidate"; then
      ODBC_DRIVER="$candidate"
      break
    fi
  done
fi
[ -n "$ODBC_DRIVER" ] || {
  echo "ERROR: no PostgreSQL ODBC driver registered (install odbc-postgresql)." >&2
  exit 1
}
echo "--- using ODBC driver: $ODBC_DRIVER ---"

export ERP_ODBC_DRIVER="$ODBC_DRIVER"
export ERP_DB_HOST=127.0.0.1
export ERP_DB_PORT="$PG_PORT"
export ERP_DB_NAME="$PG_DB"
export ERP_DB_SERVER_NAME="$PG_DB"
export ERP_DB_RO_USER=droplet_ro
export ERP_DB_RO_PASSWORD="$RO_PASSWORD"
export ERP_DB_RW_USER=droplet_rw
export ERP_DB_RW_PASSWORD="$RW_PASSWORD"

echo "--- pytest (services/erp-sql-bridge, live database) ---"
(cd "$BRIDGE_DIR" && ERP_BRIDGE_LIVE_DB=1 python -m pytest "$@")

# ---------------------------------------------------------------------------
# The lane that matters most: the TypeScript connector driving the REAL
# registry SQL through the running bridge into the database. pytest above
# covers the bridge's own behaviour with stand-in statements; this covers the
# statements that actually ship.
# ---------------------------------------------------------------------------
BRIDGE_PORT="${ERP_BRIDGE_PORT:-9391}"
BRIDGE_LOG="$RUN_DIR/bridge.log"

echo "--- starting the bridge on :${BRIDGE_PORT} ---"
(cd "$BRIDGE_DIR" && python -m uvicorn main:app --host 127.0.0.1 --port "$BRIDGE_PORT" --log-level warning >"$BRIDGE_LOG" 2>&1) &
BRIDGE_PID=$!

bridge_cleanup() {
  kill "$BRIDGE_PID" >/dev/null 2>&1 || true
  cleanup
}
trap bridge_cleanup EXIT

for i in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1 && break
  kill -0 "$BRIDGE_PID" 2>/dev/null || { echo "bridge exited:"; cat "$BRIDGE_LOG"; exit 1; }
  [ "$i" = 40 ] && { echo "bridge did not become ready:"; cat "$BRIDGE_LOG"; exit 1; }
  sleep 0.5
done

echo "--- vitest (erp-connector -> bridge -> database) ---"
cd "$REPO_ROOT"
ERP_BRIDGE_LIVE_URL="http://127.0.0.1:${BRIDGE_PORT}" \
  npm run -w @droplet/erp-connector test -- sql-bridge.live
