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
#   1. Holds a Postgres SESSION-LEVEL advisory lock on ONE kept-open psql
#      connection for the WHOLE migration phase, so concurrent / looping starts
#      block instead of racing. Session-level is deliberate: it auto-releases
#      when that backend disconnects, so a power cut while holding it cannot
#      permanently wedge future boots. (A one-shot `psql -c` would release the
#      lock the instant it exits — see acquire_lock for why we use a coproc.)
#   2. Takes a pg_dump --format=custom snapshot to a mounted volume BEFORE
#      applying, when (and only when) there are pending migrations. Prunes to
#      the last N. (Lightweight hook; full platform backup is WARP-570.)
#   3. Auto-recovers a prior failed migration EXACTLY ONCE: restore the
#      snapshot, mark the row --rolled-back (never blind --applied), re-deploy.
#      A recovery-attempt marker keyed by migration name makes a
#      deterministically-broken migration fail loud-and-stop on the second
#      boot instead of restore→re-deploy→fail looping forever.
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
  # Capture stdout and stderr separately so a transient psql/connection error
  # (which would otherwise vanish into /dev/null and look like "no failed row")
  # is surfaced as a non-zero return instead of being silently swallowed.
  local out err_file rc
  err_file="$(mktemp)"
  out="$(
    "${PSQL[@]}" -c \
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at DESC LIMIT 1;" \
      2>"$err_file"
  )"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    warn "failed-migration probe errored: $(tr '\n' ' ' <"$err_file")"
    rm -f "$err_file"
    return 1
  fi
  rm -f "$err_file"
  head -1 <<<"$out"
}

# ---------------------------------------------------------------------------
# Recovery-attempt markers. We persist a small marker in the snapshot volume
# the first time we auto-recover a given failed migration. If we boot and find
# the SAME migration failed again with its marker already present, the
# migration is deterministically broken — restore→resolve→re-deploy would just
# loop on every restart, re-snapshotting each pass. Stop loud instead.
recovery_marker_path() {
  # Sanitize the migration name to a safe filename; we control the migration
  # naming convention (timestamp_slug) but belt-and-suspenders against odd chars.
  local safe="${1//[^A-Za-z0-9._-]/_}"
  echo "$MIGRATION_SNAPSHOT_DIR/.recovery-attempt-$safe"
}

recovery_attempted() {
  [[ -f "$(recovery_marker_path "$1")" ]]
}

mark_recovery_attempted() {
  mkdir -p "$MIGRATION_SNAPSHOT_DIR"
  : > "$(recovery_marker_path "$1")"
}

clear_recovery_marker() {
  rm -f "$(recovery_marker_path "$1")" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Advisory lock held on a SINGLE kept-open connection.
#
# A `psql -c "SELECT pg_advisory_lock(k)"` would acquire the SESSION-level lock
# and then release it the instant that one-shot connection exits — giving zero
# mutual exclusion across the snapshot/deploy steps that follow. Instead we run
# one long-lived `psql` reading SQL from a FIFO, and keep that FIFO open (on a
# dedicated fd) for the whole migration phase. The lock lives exactly as long
# as that backend connection does; closing the fd sends EOF, psql exits, and
# the session-level lock auto-releases.
#
# A FIFO (not `coproc`) is used deliberately: `coproc` requires bash 4+, but
# this entrypoint and its unit test also run under macOS's stock bash 3.2 in
# local/CI dev. FIFOs work everywhere.
LOCK_DIR=""
LOCK_HELD=""      # non-empty once the FIFO session is established
LOCK_PSQL_PID=""
# Fixed fd numbers (not bash 4's `{var}>` auto-allocation, which macOS's stock
# bash 3.2 lacks): fd 8 = write into psql stdin, fd 9 = read psql stdout.
LOCK_IN_FD=8
LOCK_OUT_FD=9

# Read lines from the session's stdout fd until we see one of the markers
# passed as args; echoes which marker matched. Returns 1 if the stream ends
# first.
_await_lock_marker() {
  local line
  while IFS= read -r line <&$LOCK_OUT_FD; do
    for m in "$@"; do
      if [[ "$line" == *"$m"* ]]; then echo "$m"; return 0; fi
    done
  done
  return 1
}

acquire_lock() {
  log "acquiring migration advisory lock (key=$MIGRATION_LOCK_KEY) on a kept-open connection"
  LOCK_DIR="$(mktemp -d)"
  local in_fifo="$LOCK_DIR/in" out_fifo="$LOCK_DIR/out"
  mkfifo "$in_fifo" "$out_fifo"

  # Start the persistent psql session: stdin <- in_fifo, stdout+stderr -> out_fifo.
  "${PSQL[@]}" -q <"$in_fifo" >"$out_fifo" 2>&1 &
  LOCK_PSQL_PID=$!

  # Hold both FIFO ends open on dedicated fds for the whole phase: the in-fd
  # keeps psql's stdin from hitting EOF between writes; the out-fd keeps a
  # single continuous read stream so no marker lines are lost between reads.
  eval "exec ${LOCK_IN_FD}>\"\$in_fifo\""
  eval "exec ${LOCK_OUT_FD}<\"\$out_fifo\""
  LOCK_HELD="yes"

  # Try to take the lock WITHOUT blocking first, so we can distinguish
  # "I got it" (winner) from "someone else is migrating" (loser short-circuits).
  printf "SELECT CASE WHEN pg_try_advisory_lock(%s) THEN 'LOCK_ACQUIRED' ELSE 'LOCK_BUSY' END;\n" \
    "$MIGRATION_LOCK_KEY" >&"$LOCK_IN_FD"

  local got=""
  case "$(_await_lock_marker LOCK_ACQUIRED LOCK_BUSY || true)" in
    LOCK_ACQUIRED) got="acquired" ;;
    LOCK_BUSY)     got="busy" ;;
  esac

  if [[ "$got" == "busy" ]]; then
    log "another orchestrator holds the migration lock; waiting for it to finish"
    # Block until the holder releases, then we own it on this SAME connection.
    printf "SELECT pg_advisory_lock(%s);\nSELECT 'LOCK_WAITED';\n" \
      "$MIGRATION_LOCK_KEY" >&"$LOCK_IN_FD"
    if [[ "$(_await_lock_marker LOCK_WAITED || true)" == "LOCK_WAITED" ]]; then
      got="waited"
    else
      got=""
    fi
  fi

  if [[ -z "$got" ]]; then
    warn "could not establish migration lock session"
    return 1
  fi
  log "migration advisory lock held (mode=$got)"
  # Tell the caller whether we had to wait (loser path → re-check pending).
  [[ "$got" == "waited" ]] && return 10
  return 0
}

release_lock() {
  # Send an explicit unlock, then close both FIFO fds: psql sees EOF, the
  # session ends, and the session-level lock auto-releases with it.
  if [[ -n "$LOCK_HELD" ]]; then
    { printf "SELECT pg_advisory_unlock(%s);\n" "$MIGRATION_LOCK_KEY" >&"$LOCK_IN_FD"; } 2>/dev/null || true
    eval "exec ${LOCK_IN_FD}>&-" 2>/dev/null || true
    eval "exec ${LOCK_OUT_FD}<&-" 2>/dev/null || true
    LOCK_HELD=""
  fi
  if [[ -n "$LOCK_PSQL_PID" ]]; then
    wait "$LOCK_PSQL_PID" 2>/dev/null || true
    LOCK_PSQL_PID=""
  fi
  if [[ -n "$LOCK_DIR" ]]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    LOCK_DIR=""
  fi
}

# ---------------------------------------------------------------------------
# The migration phase. Returns 0 on success (app may start), non-zero on
# unrecoverable failure (app must NOT start). $1 == "waited" when we are the
# loser that blocked on the lock, in which case we re-check pending and skip
# a redundant deploy.
run_migrations() {
  local lock_mode="${1:-acquired}"

  local pending="no"
  if has_pending_migrations; then
    pending="yes"
  fi

  # Loser path: the winner already migrated while we blocked on the lock. If
  # nothing is pending now there is nothing for us to do — skip deploy entirely
  # rather than re-running migrate deploy against a freshly-migrated schema.
  if [[ "$lock_mode" == "waited" && "$pending" == "no" ]]; then
    local failed_check
    failed_check="$(failed_migration_name || true)"
    if [[ -z "$failed_check" ]]; then
      log "lock winner already applied all migrations; nothing pending — skipping deploy"
      return 0
    fi
  fi

  # Auto-recovery: if a prior failed migration row exists, restore the latest
  # snapshot and mark it rolled-back BEFORE re-deploying. resolve only ever
  # runs against known-good restored state — never a blind --applied.
  local failed
  failed="$(failed_migration_name || true)"
  if [[ -n "$failed" ]]; then
    # Guard against an infinite restore→re-deploy→fail loop: if we already
    # auto-recovered THIS migration on a previous boot and it failed again,
    # it is deterministically broken. Stop loud instead of looping.
    if recovery_attempted "$failed"; then
      fail_loud "failed migration '$failed' already auto-recovered once and failed again — deterministically broken, not retrying" "$failed"
      return 1
    fi
    warn "recovery: detected failed migration row '$failed' — auto-recovering (once)"
    local snap
    snap="$(latest_snapshot || true)"
    if [[ -z "$snap" ]]; then
      fail_loud "failed migration '$failed' detected but no snapshot to restore from" "$failed"
      return 1
    fi
    # Record the attempt BEFORE acting, so a crash mid-recovery still counts as
    # an attempt and the next boot won't loop.
    mark_recovery_attempted "$failed"
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
  # Clean recovery markers for migrations that are now applied — a future
  # genuinely-new failure of the same name (unlikely; names are unique) should
  # get its one auto-recovery attempt.
  if [[ -n "$failed" ]]; then
    clear_recovery_marker "$failed"
  fi
  log "migrations up to date"
  return 0
}

# ---------------------------------------------------------------------------
main() {
  local lock_mode="acquired" rc
  acquire_lock || rc=$?
  rc="${rc:-0}"
  if [[ "$rc" == "10" ]]; then
    lock_mode="waited"
  elif [[ "$rc" != "0" ]]; then
    warn "failed to acquire migration lock; refusing to start"
    release_lock
    exit 1
  fi
  # Release the lock no matter how we leave the migration phase.
  trap release_lock EXIT

  if ! run_migrations "$lock_mode"; then
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
