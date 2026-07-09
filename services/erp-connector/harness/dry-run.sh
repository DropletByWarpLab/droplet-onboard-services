#!/usr/bin/env bash
# =============================================================================
# WARP-1106 — one-command dry setup (Postgres mock)
# =============================================================================
# Brings up the mock Eaglesoft DB, waits for it to seed, runs the smoke test,
# and leaves it running so you can poke at it. Re-runnable (fresh seed each time).
#
#   ./services/erp-connector/harness/dry-run.sh          # up + smoke, leave running
#   ./services/erp-connector/harness/dry-run.sh --down   # ... then tear it down
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.yml")

echo "[dry-run] bringing up the mock Eaglesoft DB (host port 2638) ..."
"${COMPOSE[@]}" up -d

echo "[dry-run] waiting for seed ..."
for _ in $(seq 1 40); do
  if "${COMPOSE[@]}" exec -T mock-eaglesoft \
       psql -U postgres -d pattersonpm -tAc 'select count(*) from dba.appointment' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "[dry-run] running smoke test ..."
"${COMPOSE[@]}" exec -T mock-eaglesoft \
  psql -U postgres -d pattersonpm -v ON_ERROR_STOP=0 < "$HERE/smoke.sql"

if [ "${1:-}" = "--down" ]; then
  echo "[dry-run] tearing down ..."
  "${COMPOSE[@]}" down
else
  echo "[dry-run] mock left running. Connect: postgresql://droplet_ro:droplet_ro_dev_pw@localhost:2638/pattersonpm"
  echo "[dry-run] tear down with: ${COMPOSE[*]} down"
fi
