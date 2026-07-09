#!/usr/bin/env bash
# =============================================================================
# WARP-1106 — SQL Anywhere mock entrypoint (TEMPLATE — needs SAP binaries)
# =============================================================================
# Creates a fresh PattersonPM.db, loads the synthetic schema + seed, runs the
# REAL provisioning script, and starts the network engine on 2638.
#
# Assumes the SQL Anywhere 17 tools (dbinit, dbisql, dbsrv17) are on PATH — that
# is what the Dockerfile installs from the SAP Developer Edition binaries you
# supply. Adjust paths to match your install layout.
set -euo pipefail

DATA=/data
DBN=PattersonPM
DB="$DATA/$DBN.db"

if [ ! -f "$DB" ]; then
  echo "[mock] initializing $DB ..."
  # -dba sets an explicit DBA credential (SA17 removed the dba/sql default).
  dbinit -dba dba,sql "$DB"

  echo "[mock] starting engine to load schema ..."
  dbsrv17 -x tcpip -n "$DBN" "$DB" &
  ENGINE_PID=$!
  # wait for it to accept connections
  until dbping -c "Host=localhost:2638;ServerName=$DBN;DBN=$DBN;UID=dba;PWD=sql" >/dev/null 2>&1; do sleep 1; done

  CONN="Host=localhost:2638;ServerName=$DBN;DBN=$DBN;UID=dba;PWD=sql"
  echo "[mock] loading schema + seed ..."
  dbisql -c "$CONN" /init/init.sql
  echo "[mock] running the REAL provision.sql (droplet_ro / droplet_rw) ..."
  # NOTE: provision.sql has <GENERATED_*_PASSWORD> placeholders — substitute dev
  # values before loading (done here with sed into a temp copy).
  sed -e "s/<GENERATED_RO_PASSWORD>/droplet_ro_dev_pw/" \
      -e "s/<GENERATED_RW_PASSWORD>/droplet_rw_dev_pw/" \
      /provision/provision.sql > /tmp/provision.dev.sql
  dbisql -c "$CONN" /tmp/provision.dev.sql

  echo "[mock] ready. stopping bootstrap engine ..."
  kill "$ENGINE_PID"; wait "$ENGINE_PID" 2>/dev/null || true
fi

echo "[mock] starting PattersonPM on tcp 2638 ..."
exec dbsrv17 -x "tcpip(port=2638)" -n "$DBN" "$DB"
