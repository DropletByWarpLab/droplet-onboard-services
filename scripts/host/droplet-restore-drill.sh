#!/usr/bin/env bash
# =============================================================================
# WARP-254 — automated monthly restore drill (sandboxed, non-destructive)
# =============================================================================
#
# "A backup you have never restored is a hope, not a backup." Once a month
# (droplet-restore-drill.timer) this script proves the newest snapshot is
# actually restorable, WITHOUT touching the live stack:
#
#   1. `restic check --read-data-subset=<N>` — repository integrity, including
#      a data re-read (default 10% per drill; override with
#      DROPLET_DRILL_READ_DATA_SUBSET, the test harness uses 100%).
#   2. `restic restore latest` into a throwaway scratch dir.
#   3. gzip -t the restored Postgres dump.
#   4. Spin up a SANDBOX Postgres container (droplet-restore-drill-pg-<pid>,
#      default image pgvector/pgvector:pg16 — the stack's own db image, so a
#      dump containing `CREATE EXTENSION vector` replays cleanly and nothing
#      new is pulled), replay the dump with ON_ERROR_STOP=1.
#   5. Smoke-test the restored DB: public-schema table count must be >= 1;
#      the "User" row count is recorded when the table exists.
#   6. Write the EXPLICIT status file (enum ok|failed — never inferred from
#      timestamps or absence):
#        $DROPLET_BACKUP_STATE_DIR/restore-drill-status.json
#      { "status": "ok"|"failed", "completed_at": ..., "snapshot_id": ...,
#        "tables": N, "users": N, "message": ... }
#      written atomically (tmp + mv) so a crashed drill never leaves a
#      half-written status.
#
# On ANY failure: status file says "failed", the reason is logged LOUDLY to
# syslog (logger -p daemon.err) + stderr, and the exit code is non-zero so the
# systemd unit lands in a failed state operators can alert on.
#
# Env overrides: DROPLET_REPO_ROOT, DROPLET_BACKUP_TARGET,
#   DROPLET_BACKUP_STATE_DIR, DROPLET_BACKUP_RUNTIME_DIR,
#   DROPLET_DRILL_PG_IMAGE, DROPLET_DRILL_READ_DATA_SUBSET.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=droplet-backup-lib.sh
source "$SCRIPT_DIR/droplet-backup-lib.sh"

STATE_DIR="${DROPLET_BACKUP_STATE_DIR:-/var/lib/droplet/backup}"
STATUS_FILE="$STATE_DIR/restore-drill-status.json"
PG_IMAGE="${DROPLET_DRILL_PG_IMAGE:-pgvector/pgvector:pg16}"
READ_SUBSET="${DROPLET_DRILL_READ_DATA_SUBSET:-10%}"

SANDBOX="droplet-restore-drill-pg-$$"
WORK_DIR=""
SNAPSHOT_ID="unknown"
TABLES="null"
USERS="null"

cleanup() {
  docker rm -f "$SANDBOX" >/dev/null 2>&1 || true
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

write_status() {
  # $1 = ok|failed (EXPLICIT enum), $2 = human message
  local status="$1" message="$2" tmp
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  tmp="$STATUS_FILE.tmp.$$"
  cat > "$tmp" <<STATUS
{
  "status": "$status",
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "warp_ticket": "WARP-254",
  "snapshot_id": "$SNAPSHOT_ID",
  "repository": "${RESTIC_REPOSITORY:-unset}",
  "tables": $TABLES,
  "users": $USERS,
  "message": "$message"
}
STATUS
  chmod 600 "$tmp"
  mv "$tmp" "$STATUS_FILE"
}

drill_fail() {
  # $1 = reason. Loud on purpose: syslog err + stderr + failed unit state.
  local reason="$1"
  write_status failed "$reason"
  log_error "RESTORE DRILL FAILED: $reason"
  log_error "Status: $STATUS_FILE"
  logger -t droplet-restore-drill -p daemon.err \
    "Droplet restore drill FAILED: $reason (status: $STATUS_FILE)" 2>/dev/null || true
  exit 1
}

if ! command -v restic >/dev/null 2>&1; then
  drill_fail "restic not on PATH"
fi
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  drill_fail "docker unavailable — the drill needs a sandbox container"
fi

droplet_backup_prepare_restic_env || drill_fail "repository password derivation failed"

# --- 1. Repository integrity -------------------------------------------------
log_info "restic check (--read-data-subset=$READ_SUBSET)..."
if ! restic check --read-data-subset="$READ_SUBSET"; then
  drill_fail "restic check failed — repository integrity is broken"
fi
log_success "Repository integrity verified."

SNAPSHOT_ID="$(restic snapshots latest --json 2>/dev/null \
  | grep -oE '"short_id"[[:space:]]*:[[:space:]]*"[0-9a-f]+"' | head -1 \
  | grep -oE '[0-9a-f]{8}' || echo unknown)"

# --- 2. Restore latest into scratch -------------------------------------------
WORK_DIR="$(mktemp -d -t droplet-drill-XXXXXXXX)"
log_info "Restoring latest snapshot ($SNAPSHOT_ID) into sandbox scratch..."
if ! restic restore latest --target "$WORK_DIR"; then
  drill_fail "restic restore of the latest snapshot failed"
fi

DUMP="$(find "$WORK_DIR" -type f -name 'droplet.sql.gz' -path '*postgres*' 2>/dev/null | head -1 || true)"
if [ -z "$DUMP" ]; then
  drill_fail "restored snapshot contains no Postgres dump (postgres/droplet.sql.gz)"
fi
if ! gzip -t "$DUMP" 2>/dev/null; then
  drill_fail "restored Postgres dump fails gzip integrity"
fi
log_success "Dump restored + gzip-verified."

# --- 3. Sandbox Postgres --------------------------------------------------------
# Throwaway container, throwaway password, no published ports — everything
# stays on the docker-internal surface and is torn down by the EXIT trap.
log_info "Starting sandbox Postgres ($PG_IMAGE)..."
SANDBOX_PW="$(openssl rand -hex 16)"
if ! docker run -d --name "$SANDBOX" \
       -e POSTGRES_USER=droplet -e POSTGRES_DB=droplet -e "POSTGRES_PASSWORD=$SANDBOX_PW" \
       "$PG_IMAGE" >/dev/null 2>&1; then
  drill_fail "sandbox Postgres container failed to start"
fi

# The postgres entrypoint's FIRST boot runs a temporary init server that
# listens ONLY on the unix socket (listen_addresses=''), creates POSTGRES_DB
# mid-phase, stops it, then starts the real server. A unix-socket pg_isready
# reports ready during that temp phase, and a replay launched in the window
# dies mid-boot ("database droplet does not exist" / "the database system is
# shutting down" / connection refused in the restart gap) — false-failing the
# drill with "backup is NOT restorable". The temp init server never binds
# TCP, so -h 127.0.0.1 can only succeed once the REAL server is up.
# Belt-and-braces: require 2 consecutive successful polls.
ready=0
consecutive=0
for _ in $(seq 1 60); do
  if docker exec "$SANDBOX" pg_isready -h 127.0.0.1 -U droplet >/dev/null 2>&1; then
    consecutive=$((consecutive + 1))
    if [ "$consecutive" -ge 2 ]; then
      ready=1
      break
    fi
  else
    consecutive=0
  fi
  sleep 1
done
[ "$ready" = "1" ] || drill_fail "sandbox Postgres never became ready"

# --- 4. Replay the dump -----------------------------------------------------------
# All psql below goes over TCP (-h 127.0.0.1) for the same reason as the
# readiness poll, with PGPASSWORD supplied in case the image's pg_hba does
# not trust localhost. Replay stderr is captured and printed on failure —
# discarding it left this drill's readiness race misdiagnosed for a day.
log_info "Replaying dump into the sandbox (ON_ERROR_STOP=1)..."
REPLAY_ERR="$WORK_DIR/replay-stderr.log"
if ! gunzip -c "$DUMP" | docker exec -i -e PGPASSWORD="$SANDBOX_PW" "$SANDBOX" \
     psql -q -h 127.0.0.1 -U droplet -d droplet -v ON_ERROR_STOP=1 >/dev/null 2>"$REPLAY_ERR"; then
  if [ -s "$REPLAY_ERR" ]; then
    log_error "psql replay stderr (why the replay failed):"
    cat "$REPLAY_ERR" >&2
  fi
  drill_fail "dump replay failed — the backup is NOT restorable"
fi

# --- 5. Smoke test ------------------------------------------------------------------
SMOKE_ERR="$WORK_DIR/smoke-stderr.log"
TABLES="$(docker exec -e PGPASSWORD="$SANDBOX_PW" "$SANDBOX" psql -h 127.0.0.1 -U droplet -d droplet -tAc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public';" 2>"$SMOKE_ERR" | tr -d '[:space:]' || echo '')"
if ! printf '%s' "$TABLES" | grep -qE '^[0-9]+$'; then
  TABLES="null"
  if [ -s "$SMOKE_ERR" ]; then
    log_error "psql smoke-query stderr:"
    cat "$SMOKE_ERR" >&2
  fi
  drill_fail "smoke query failed (could not count public tables)"
fi
if [ "$TABLES" -lt 1 ]; then
  drill_fail "restored DB has zero public tables — dump was empty"
fi

# Key-table row count when present (the orchestrator's Prisma "User" table).
# Absence is NOT a failure — a pre-onboarding box legitimately has no users
# table yet; the count is recorded for the operator either way.
USERS="$(docker exec -e PGPASSWORD="$SANDBOX_PW" "$SANDBOX" psql -h 127.0.0.1 -U droplet -d droplet -tAc \
  "SELECT CASE WHEN to_regclass('public.\"User\"') IS NULL THEN -1 ELSE (SELECT count(*) FROM public.\"User\") END;" \
  2>/dev/null | tr -d '[:space:]' || echo '')"
printf '%s' "$USERS" | grep -qE '^-?[0-9]+$' || USERS="null"

write_status ok "restored snapshot $SNAPSHOT_ID into sandbox; $TABLES public tables"
log_success "RESTORE DRILL PASSED: snapshot $SNAPSHOT_ID restorable ($TABLES tables)."
logger -t droplet-restore-drill -p daemon.info \
  "Droplet restore drill PASSED: snapshot $SNAPSHOT_ID ($TABLES tables)" 2>/dev/null || true
