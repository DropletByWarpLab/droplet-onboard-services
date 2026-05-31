#!/usr/bin/env bash
#
# migrate-and-start.sh — guarded migration-on-boot entrypoint for the
# orchestrator container (WARP-573).
#
# Replaces the old unguarded CMD:
#     sh -c "npx prisma migrate deploy && node dist/index.js"
#
# Why: the orchestrator runs on a single-box appliance with restart: always
# and real power-cut risk. The old chain had no concurrency guard and no
# atomicity/recovery: a power loss mid-migration leaves a failed
# `_prisma_migrations` row, `migrate deploy` then refuses to run, the `&&`
# short-circuits so the app never starts, and Docker re-runs the same failing
# command forever — a silent restart loop only diagnosable by docker-exec into
# the DB. See .superpowers/brainstorm/WARP-573.md.
#
# This script, before starting the app:
#   1. Acquires a Postgres SESSION-LEVEL advisory lock for the whole migration
#      phase so concurrent / looping starts block instead of racing. Session-
#      level is deliberate: it auto-releases when the backend disconnects, so a
#      power cut while holding it cannot permanently wedge future boots.
#   2. Takes a pg_dump --format=custom snapshot to a mounted volume BEFORE
#      applying, when (and only when) there are pending migrations. Prunes to
#      the last N. (Lightweight hook; full platform backup is WARP-570.)
#   3. Auto-recovers a prior failed migration: restore the snapshot, mark the
#      row --rolled-back (never blind --applied), re-deploy.
#   4. On unrecoverable failure, prints a loud greppable banner (snapshot path +
#      exact remediation command) and exits non-zero — a distinct, visible
#      failure state, never a silent loop, never Express on a half-migrated schema.
#   5. exec node dist/index.js (exec preserves PID 1 / signal semantics).
#
# Runtime requirements (provided by the image): postgresql-client 16
# (psql/pg_dump/pg_restore), node, npx, the generated Prisma client, and
# DATABASE_URL in the environment.
set -euo pipefail

# Fixed lock key shared by every orchestrator process; arbitrary 64-bit const.
MIGRATION_LOCK_KEY="${MIGRATION_LOCK_KEY:-4815162342}"
# Snapshot location (mounted volume in compose). Overridable for tests.
MIGRATION_SNAPSHOT_DIR="${MIGRATION_SNAPSHOT_DIR:-/data/migration-snapshots}"
# How many pre-migration snapshots to keep.
MIGRATION_SNAPSHOT_KEEP="${MIGRATION_SNAPSHOT_KEEP:-3}"
# Test hook: when set, skip the final `exec node` and emit a marker so the
# unit test can assert the app-start step was reached.
MIGRATE_SCRIPT_TEST="${MIGRATE_SCRIPT_TEST:-}"

log()  { printf '{"event":"migrate_boot","level":"info","msg":"%s"}\n' "$1"; }
warn() { printf '{"event":"migrate_boot","level":"warn","msg":"%s"}\n' "$1" >&2; }

if [[ -z "${DATABASE_URL:-}" ]]; then
  warn "DATABASE_URL is not set; cannot run guarded migrations"
  exit 2
fi

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA)

# ---------------------------------------------------------------------------
# Loud failure banner. Names the snapshot path and the exact remediation so an
# operator can recover from `docker logs` without spelunking the DB.
fail_loud() {
  local reason="$1"
  local migration="${2:-<migration_name>}"
  local snap
  snap="$(latest_snapshot || true)"
  {
    echo "=============================================================="
    echo " MIGRATION FAILED — orchestrator will NOT start"
    echo "=============================================================="
    echo " reason: $reason"
    echo " The database may be left with a failed migration row. The app"
    echo " was deliberately NOT started on a half-migrated schema."
    echo
    echo " Pre-migration snapshot (if any): ${snap:-none taken}"
    echo
    echo " Manual recovery (run on the host):"
    echo "   1. Inspect:   docker exec <orchestrator> npx prisma migrate status"
    echo "   2a. If you have the snapshot above, restore it, then:"
    echo "       docker exec <orchestrator> npx prisma migrate resolve --rolled-back $migration"
    echo "   2b. Or, if the migration actually completed, mark it applied:"
    echo "       docker exec <orchestrator> npx prisma migrate resolve --applied $migration"
    echo "   3. Then recreate the orchestrator:"
    echo "       docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate orchestrator"
    echo "=============================================================="
  } >&2
}

# ---------------------------------------------------------------------------
# List snapshots newest-first. We own the filenames (pre-migrate-<epoch>.dump,
# no spaces/newlines), so the SC2012 `ls`-parsing caveat doesn't apply and
# `ls -t` is the simplest correct mtime sort.
latest_snapshot() {
  # shellcheck disable=SC2012  # filenames are controlled; mtime sort via ls -t
  ls -1t "$MIGRATION_SNAPSHOT_DIR"/pre-migrate-*.dump 2>/dev/null | head -1
}

prune_snapshots() {
  local keep="$MIGRATION_SNAPSHOT_KEEP"
  # Delete all but the newest $keep snapshots.
  # shellcheck disable=SC2012  # filenames are controlled; mtime sort via ls -t
  ls -1t "$MIGRATION_SNAPSHOT_DIR"/pre-migrate-*.dump 2>/dev/null \
    | tail -n +"$((keep + 1))" \
    | while IFS= read -r old; do rm -f "$old"; done
}

take_snapshot() {
  mkdir -p "$MIGRATION_SNAPSHOT_DIR"
  local f
  f="$MIGRATION_SNAPSHOT_DIR/pre-migrate-$(date +%s).dump"
  log "taking pre-migration snapshot: $f"
  if pg_dump --format=custom --file="$f" "$DATABASE_URL"; then
    prune_snapshots
    echo "$f"
    return 0
  fi
  warn "pg_dump snapshot failed; continuing is unsafe"
  return 1
}

has_pending_migrations() {
  # `prisma migrate status` exits non-zero in several states; we key off its
  # text instead. "not yet been applied" => pending.
  local out
  out="$(npx prisma migrate status 2>&1 || true)"
  grep -qiE "have not yet been applied|following migration" <<<"$out"
}

failed_migration_name() {
  # A genuine failed migration row: started but neither finished nor rolled back.
  "${PSQL[@]}" -c \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at DESC LIMIT 1;" \
    2>/dev/null | head -1
}

acquire_lock() {
  log "acquiring migration advisory lock (key=$MIGRATION_LOCK_KEY)"
  "${PSQL[@]}" -c "SELECT pg_advisory_lock($MIGRATION_LOCK_KEY);" >/dev/null
}

release_lock() {
  "${PSQL[@]}" -c "SELECT pg_advisory_unlock($MIGRATION_LOCK_KEY);" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
run_migrations() {
  # Held under the advisory lock by the caller.
  local pending="no"
  if has_pending_migrations; then
    pending="yes"
  fi

  # Auto-recovery: if a prior failed migration row exists, restore the latest
  # snapshot and mark it rolled-back BEFORE re-deploying. resolve only ever
  # runs against known-good restored state — never a blind --applied.
  local failed
  failed="$(failed_migration_name || true)"
  if [[ -n "$failed" ]]; then
    warn "recovery: detected failed migration row '$failed' — auto-recovering"
    local snap
    snap="$(latest_snapshot || true)"
    if [[ -z "$snap" ]]; then
      fail_loud "failed migration '$failed' detected but no snapshot to restore from" "$failed"
      return 1
    fi
    log "recovery: restoring snapshot $snap"
    if ! pg_restore --clean --if-exists --dbname="$DATABASE_URL" "$snap"; then
      fail_loud "snapshot restore failed during recovery" "$failed"
      return 1
    fi
    log "recovery: marking '$failed' as rolled-back"
    if ! npx prisma migrate resolve --rolled-back "$failed"; then
      fail_loud "prisma migrate resolve --rolled-back failed during recovery" "$failed"
      return 1
    fi
    # After restore the schema matches the snapshot, so the just-rolled-back
    # migration is pending again.
    pending="yes"
  fi

  if [[ "$pending" == "yes" ]]; then
    if ! take_snapshot >/dev/null; then
      fail_loud "could not take pre-migration snapshot"
      return 1
    fi
  else
    log "no pending migrations; skipping snapshot"
  fi

  log "running prisma migrate deploy"
  if ! npx prisma migrate deploy; then
    local nm
    nm="$(failed_migration_name || true)"
    fail_loud "prisma migrate deploy failed" "${nm:-<migration_name>}"
    return 1
  fi
  log "migrations up to date"
  return 0
}

# ---------------------------------------------------------------------------
main() {
  acquire_lock
  # Release the lock no matter how we leave the migration phase.
  trap release_lock EXIT

  if ! run_migrations; then
    release_lock
    trap - EXIT
    exit 1
  fi

  release_lock
  trap - EXIT

  if [[ -n "$MIGRATE_SCRIPT_TEST" ]]; then
    # Test mode: prove we reached the app-start step without launching node.
    echo "APP_START_MARKER"
    return 0
  fi

  log "starting orchestrator"
  exec node dist/index.js
}

main "$@"
