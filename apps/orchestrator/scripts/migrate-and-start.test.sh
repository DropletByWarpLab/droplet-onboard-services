#!/usr/bin/env bash
#
# migrate-and-start.test.sh — unit test for the guarded migration entrypoint
# (WARP-573). Pure bash; no Docker, no Postgres, no Prisma required.
#
# Strategy: put mock `psql`, `pg_dump`, `pg_restore`, and `npx` on PATH that
# append to a call log and behave per env knobs the test sets. Run
# migrate-and-start.sh in script-only mode (MIGRATE_SCRIPT_TEST=1 skips the
# final `exec node`) and assert on the call log + exit code + stderr.
#
# Usage: apps/orchestrator/scripts/migrate-and-start.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/migrate-and-start.sh"
ORCH_DIR="$(cd "$HERE/.." && pwd)"
DOCKERFILE="$ORCH_DIR/Dockerfile"

PASS=0
FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- mock harness ---------------------------------------------------------
# Each case gets a fresh sandbox: a bin dir of mocks (first on PATH), a call
# log, a snapshot dir, and env knobs read by the mocks.
make_sandbox() {
  SANDBOX="$(mktemp -d)"
  BIN="$SANDBOX/bin"
  mkdir -p "$BIN"
  CALLLOG="$SANDBOX/calls.log"
  : > "$CALLLOG"
  SNAP_DIR="$SANDBOX/snapshots"
  mkdir -p "$SNAP_DIR"

  # mock psql: models BOTH invocation styles the script uses —
  #   (a) one-shot `psql ... -c "<sql>"` for the failed-migration detection
  #       SELECT, and
  #   (b) the kept-open coproc session (`psql ... -q`, no -c) that reads SQL
  #       from stdin and holds the advisory lock for the whole migration phase.
  #
  # Crucially, the lock-lifetime is modeled with an on-disk lock file written
  # the moment pg_try_advisory_lock succeeds and removed when the session ends
  # (stdin closes / unlock). A real second connection would see LOCK_BUSY while
  # the file exists — so the mock can prove cross-process mutual exclusion that
  # the old one-shot mock could not. MOCK_LOCKFILE points all mocks at one file.
  cat > "$BIN/psql" <<'MOCK'
#!/usr/bin/env bash
echo "psql $*" >> "$MOCK_CALLLOG"
lockfile="${MOCK_LOCKFILE:-/tmp/.warp573-mock-lock}"

# The detection SELECT comes via -c; find it.
sql=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-c" ]]; then sql="$a"; fi
  prev="$a"
done

if [[ -n "$sql" ]]; then
  # one-shot mode
  case "$sql" in
    *finished_at*IS*NULL*|*_prisma_migrations*)
      if [[ -n "${MOCK_FAILED_ROW:-}" ]]; then echo "$MOCK_FAILED_ROW"; fi
      ;;
  esac
  exit 0
fi

# kept-open session mode (no -c): read SQL statements from stdin and respond.
# The session "holds" the lock by creating $lockfile, and releases it (removes
# the file) when stdin closes or on explicit unlock — modeling session-level
# advisory-lock lifetime tied to this connection.
held=""
cleanup() { [[ -n "$held" ]] && rm -f "$lockfile"; }
trap cleanup EXIT
while IFS= read -r line; do
  case "$line" in
    *pg_try_advisory_lock*)
      echo "pg_try_advisory_lock" >> "$MOCK_CALLLOG"
      if ( set -o noclobber; : > "$lockfile" ) 2>/dev/null; then
        held="yes"; echo "LOCK_ACQUIRED"
      else
        echo "LOCK_BUSY"
      fi
      ;;
    *pg_advisory_unlock*)
      echo "pg_advisory_unlock" >> "$MOCK_CALLLOG"
      [[ -n "$held" ]] && { rm -f "$lockfile"; held=""; }
      ;;
    *pg_advisory_lock*)
      # Blocking acquire: spin (bounded) until the file is free, then take it.
      echo "pg_advisory_lock" >> "$MOCK_CALLLOG"
      tries=0
      until ( set -o noclobber; : > "$lockfile" ) 2>/dev/null; do
        sleep 0.05; tries=$((tries+1)); [[ $tries -gt 200 ]] && break
      done
      held="yes"
      ;;
    *"SELECT 'LOCK_WAITED'"*)
      # psql -tA would print the literal; the script awaits this marker after
      # a successful blocking acquire.
      echo "LOCK_WAITED"
      ;;
  esac
done
exit 0
MOCK

  cat > "$BIN/pg_dump" <<'MOCK'
#!/usr/bin/env bash
echo "pg_dump $*" >> "$MOCK_CALLLOG"
# create the snapshot file named by --file=PATH so prune/restore see it
for a in "$@"; do
  case "$a" in
    --file=*) f="${a#--file=}"; mkdir -p "$(dirname "$f")"; echo dump > "$f" ;;
  esac
done
exit 0
MOCK

  cat > "$BIN/pg_restore" <<'MOCK'
#!/usr/bin/env bash
echo "pg_restore $*" >> "$MOCK_CALLLOG"
exit 0
MOCK

  # mock npx: handles `npx prisma migrate deploy`, `migrate resolve`,
  # `migrate status`. deploy failure controlled by MOCK_DEPLOY_FAIL.
  cat > "$BIN/npx" <<'MOCK'
#!/usr/bin/env bash
echo "npx $*" >> "$MOCK_CALLLOG"
args="$*"
case "$args" in
  *"migrate status"*)
    # pending if MOCK_PENDING set, else up-to-date (exit 0 either way; we
    # signal pending via stdout text the script greps)
    if [[ -n "${MOCK_PENDING:-}" ]]; then
      echo "Following migrations have not yet been applied:"
    else
      echo "Database schema is up to date!"
    fi
    exit 0
    ;;
  *"migrate deploy"*)
    if [[ -n "${MOCK_DEPLOY_FAIL:-}" ]]; then
      echo "P3009 migrate found failed migrations" >&2
      exit 1
    fi
    echo "All migrations applied"
    exit 0
    ;;
  *"migrate resolve"*)
    exit 0
    ;;
esac
exit 0
MOCK

  chmod +x "$BIN"/*
}

run_script() {
  # run the entrypoint in script-only mode with mocks on PATH
  MOCK_CALLLOG="$CALLLOG" \
  MOCK_LOCKFILE="${MOCK_LOCKFILE:-$SANDBOX/lockfile}" \
  PATH="$BIN:$PATH" \
  MIGRATE_SCRIPT_TEST=1 \
  DATABASE_URL="postgresql://u:p@db:5432/droplet" \
  MIGRATION_SNAPSHOT_DIR="$SNAP_DIR" \
  "$@" \
  bash "$SCRIPT"
}

cleanup_sandbox() { rm -rf "$SANDBOX"; }

# =========================================================================
info "Case A — advisory lock acquired and released on happy path"
make_sandbox
out="$(run_script env MOCK_PENDING= 2>&1)"; rc=$?
if grep -q "pg_try_advisory_lock" "$CALLLOG"; then ok "acquires advisory lock (try-lock)"; else bad "no advisory lock call"; fi
if grep -q "pg_advisory_unlock" "$CALLLOG"; then ok "releases advisory lock"; else bad "no advisory unlock call"; fi
if [[ $rc -eq 0 ]]; then ok "happy path exits 0"; else bad "happy path exit=$rc"; fi
if grep -q "APP_START_MARKER" <<<"$out"; then ok "reaches app-start step"; else bad "did not reach app-start"; fi
# Session-level lock must be released (lockfile gone) once the script exits.
if [[ ! -e "$SANDBOX/lockfile" ]]; then ok "lock released after migration phase (session closed)"; else bad "lock still held after exit"; fi
cleanup_sandbox

info "Case A2 — lock is held ACROSS the whole phase (real mutual exclusion)"
# The blocker fix: a second connection attempting pg_try_advisory_lock WHILE the
# first holds it must observe LOCK_BUSY. We simulate by pre-creating the lockfile
# (a concurrent holder) and asserting the script BLOCKS (try fails → blocking
# acquire) rather than barrelling straight into deploy. We then release it and
# confirm the script proceeds. Bounded so a regression (instant acquire) is caught.
make_sandbox
LOCK="$SANDBOX/lockfile"
: > "$LOCK"   # pretend another orchestrator currently holds the migration lock
# Release the held lock shortly after the script starts blocking on it.
( sleep 0.6; rm -f "$LOCK" ) &
releaser=$!
out="$(MOCK_LOCKFILE="$LOCK" run_script env MOCK_PENDING=1 2>&1)"; rc=$?
wait "$releaser" 2>/dev/null || true
if grep -q "pg_try_advisory_lock" "$CALLLOG" && grep -q "LOCK_BUSY\|waiting for it to finish" <<<"$out"; then
  ok "observes the lock as BUSY and waits (does not race a concurrent migrator)"
else
  bad "did not block on a held lock — mutual exclusion broken"
fi
# Deploy must only have happened AFTER the lock became free.
if grep -q "migrate deploy" "$CALLLOG"; then ok "proceeds once the lock is released"; else bad "never migrated after acquiring lock"; fi
if [[ $rc -eq 0 ]]; then ok "blocked-then-acquired path exits 0"; else bad "exit=$rc"; fi
cleanup_sandbox

info "Case B — snapshot taken BEFORE migrate deploy when migrations pending"
make_sandbox
out="$(run_script env MOCK_PENDING=1 2>&1)"; rc=$?
dump_line=$(grep -n "pg_dump" "$CALLLOG" | head -1 | cut -d: -f1)
deploy_line=$(grep -n "migrate deploy" "$CALLLOG" | head -1 | cut -d: -f1)
if [[ -n "$dump_line" ]]; then ok "pg_dump ran (snapshot taken)"; else bad "no pg_dump"; fi
if [[ -n "$dump_line" && -n "$deploy_line" && "$dump_line" -lt "$deploy_line" ]]; then
  ok "snapshot precedes migrate deploy ($dump_line < $deploy_line)"
else
  bad "snapshot did not precede deploy (dump=$dump_line deploy=$deploy_line)"
fi
if [[ $rc -eq 0 ]]; then ok "exits 0 with pending migrations"; else bad "exit=$rc"; fi
cleanup_sandbox

info "Case B2 — snapshot SKIPPED when no migrations pending"
make_sandbox
out="$(run_script env MOCK_PENDING= 2>&1)"; rc=$?
if grep -q "pg_dump" "$CALLLOG"; then bad "pg_dump ran despite no pending"; else ok "no snapshot when nothing pending"; fi
cleanup_sandbox

info "Case C — auto-recovery of a prior failed migration"
make_sandbox
# pre-seed a snapshot so restore has something to use
echo dump > "$SNAP_DIR/pre-migrate-1.dump"
out="$(run_script env MOCK_PENDING=1 MOCK_FAILED_ROW=20260101000000_broken 2>&1)"; rc=$?
if grep -q "pg_restore" "$CALLLOG"; then ok "restores snapshot on failed-row detection"; else bad "no pg_restore"; fi
if grep -q "migrate resolve --rolled-back 20260101000000_broken" "$CALLLOG"; then
  ok "resolves the failed migration as rolled-back"
else
  bad "did not resolve --rolled-back the named migration"
fi
if grep -q "migrate deploy" "$CALLLOG"; then ok "re-deploys after recovery"; else bad "no re-deploy"; fi
if grep -qi "recover" <<<"$out"; then ok "logs a greppable recovery banner"; else bad "no recovery banner"; fi
if [[ $rc -eq 0 ]] && grep -q "APP_START_MARKER" <<<"$out"; then ok "recovers and reaches app-start"; else bad "did not recover (rc=$rc)"; fi
cleanup_sandbox

info "Case C2 — never blind --applied"
make_sandbox
echo dump > "$SNAP_DIR/pre-migrate-1.dump"
out="$(run_script env MOCK_PENDING=1 MOCK_FAILED_ROW=20260101000000_broken 2>&1)"
if grep -q "migrate resolve --applied" "$CALLLOG"; then bad "used blind --applied (lies about state)"; else ok "never uses --applied"; fi
cleanup_sandbox

info "Case C3 — deterministically-broken migration fails loud-and-stops, no infinite loop"
# Boot 1: failed row + a snapshot present → auto-recovers once, marker written,
# but deploy STILL fails (the migration SQL is bad) → fail loud, exit non-zero.
# Boot 2: same failed row, marker already present → must NOT restore/re-deploy
# again; must fail loud-and-stop. This is the loop the reviewer flagged.
make_sandbox
PERSIST_SNAP="$SANDBOX/persist-snapshots"   # models the persistent volume across boots
mkdir -p "$PERSIST_SNAP"
echo dump > "$PERSIST_SNAP/pre-migrate-1.dump"
# Boot 1
# shellcheck disable=SC2034  # out1 captured for symmetry / debugging; rc1 is asserted
out1="$(MIGRATION_SNAPSHOT_DIR="$PERSIST_SNAP" SNAP_DIR="$PERSIST_SNAP" \
  run_script env MIGRATION_SNAPSHOT_DIR="$PERSIST_SNAP" MOCK_PENDING=1 \
  MOCK_FAILED_ROW=20260101000000_broken MOCK_DEPLOY_FAIL=1 2>&1)"; rc1=$?
restore_count_1=$(grep -c "pg_restore" "$CALLLOG" || true)
: > "$CALLLOG"   # reset call log for boot 2
# Boot 2 — same persistent snapshot dir, marker should now exist
out2="$(MIGRATION_SNAPSHOT_DIR="$PERSIST_SNAP" SNAP_DIR="$PERSIST_SNAP" \
  run_script env MIGRATION_SNAPSHOT_DIR="$PERSIST_SNAP" MOCK_PENDING=1 \
  MOCK_FAILED_ROW=20260101000000_broken MOCK_DEPLOY_FAIL=1 2>&1)"; rc2=$?
restore_count_2=$(grep -c "pg_restore" "$CALLLOG" || true)
if [[ $rc1 -ne 0 ]]; then ok "boot 1 attempts recovery then fails non-zero"; else bad "boot 1 should fail (rc=$rc1)"; fi
if [[ "$restore_count_1" -ge 1 ]]; then ok "boot 1 DID attempt one recovery restore"; else bad "boot 1 never restored"; fi
if [[ $rc2 -ne 0 ]]; then ok "boot 2 fails non-zero"; else bad "boot 2 should fail (rc=$rc2)"; fi
if [[ "$restore_count_2" -eq 0 ]]; then ok "boot 2 does NOT re-restore/re-deploy (loop broken)"; else bad "boot 2 looped: restored again (${restore_count_2}x)"; fi
if grep -qi "deterministically broken\|already auto-recovered" <<<"$out2"; then
  ok "boot 2 banner explains the broken-migration stop"
else
  bad "boot 2 missing deterministic-break explanation"
fi
cleanup_sandbox

info "Case D — unrecoverable deploy failure: distinct non-zero + loud banner, app NOT started"
make_sandbox
out="$(run_script env MOCK_PENDING=1 MOCK_DEPLOY_FAIL=1 2>&1)"; rc=$?
if [[ $rc -ne 0 ]]; then ok "exits non-zero on unrecoverable failure (rc=$rc)"; else bad "exit 0 on failure"; fi
if grep -q "APP_START_MARKER" <<<"$out"; then bad "started app on half-migrated schema"; else ok "did NOT start app on failure"; fi
if grep -qi "MIGRATION FAILED" <<<"$out"; then ok "prints loud greppable failure banner"; else bad "no failure banner"; fi
if grep -q "migrate resolve" <<<"$out"; then ok "banner names the prisma migrate resolve remediation"; else bad "banner missing remediation command"; fi
if grep -qi "snapshot" <<<"$out"; then ok "banner names the snapshot path"; else bad "banner missing snapshot path"; fi
cleanup_sandbox

info "Case F — loser that waited on the lock skips a redundant deploy when nothing pending"
# The winner migrated while we blocked; once we acquire the lock there is
# nothing pending → we must NOT run migrate deploy again.
make_sandbox
LOCK="$SANDBOX/lockfile"
: > "$LOCK"                       # a concurrent winner holds the lock
( sleep 0.5; rm -f "$LOCK" ) &   # winner finishes and releases
releaser=$!
# After the winner releases, nothing is pending (MOCK_PENDING unset) and no failed row.
out="$(MOCK_LOCKFILE="$LOCK" run_script env MOCK_PENDING= 2>&1)"; rc=$?
wait "$releaser" 2>/dev/null || true
if grep -q "migrate deploy" "$CALLLOG"; then bad "loser re-ran migrate deploy (redundant)"; else ok "loser skips redundant migrate deploy"; fi
if grep -qi "skipping deploy\|nothing pending" <<<"$out"; then ok "loser logs the short-circuit"; else bad "no short-circuit log"; fi
if [[ $rc -eq 0 ]] && grep -q "APP_START_MARKER" <<<"$out"; then ok "loser still starts the app"; else bad "loser did not start app (rc=$rc)"; fi
cleanup_sandbox

info "Case E — Dockerfile regression guard"
# Only flag an ACTUAL directive — strip comment lines (the file legitimately
# documents the old `migrate deploy && node` chain in comments) before matching.
if grep -vE '^[[:space:]]*#' "$DOCKERFILE" | grep -qE 'migrate deploy[[:space:]]*&&'; then
  bad "Dockerfile still has inline 'migrate deploy &&' CMD"
else
  ok "Dockerfile has no inline 'migrate deploy &&' CMD"
fi
if grep -q "migrate-and-start.sh" "$DOCKERFILE"; then
  ok "Dockerfile invokes migrate-and-start.sh"
else
  bad "Dockerfile does not invoke migrate-and-start.sh"
fi

# =========================================================================
printf '\n\033[1mResults:\033[0m %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
