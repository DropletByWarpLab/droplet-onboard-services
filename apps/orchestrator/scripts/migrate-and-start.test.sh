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

  # mock psql: handles (a) the "failed migration" detection SELECT and
  # (b) the advisory lock/unlock SELECTs. Behavior driven by MOCK_FAILED_ROW.
  cat > "$BIN/psql" <<'MOCK'
#!/usr/bin/env bash
echo "psql $*" >> "$MOCK_CALLLOG"
# The SQL is passed via -c "<sql>". Find it.
sql=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-c" ]]; then sql="$a"; fi
  prev="$a"
done
case "$sql" in
  *pg_advisory_lock*)   echo "pg_advisory_lock" >> "$MOCK_CALLLOG" ;;
  *pg_advisory_unlock*) echo "pg_advisory_unlock" >> "$MOCK_CALLLOG" ;;
  *finished_at*IS*NULL*|*_prisma_migrations*)
    # detection query: emit a migration name only if MOCK_FAILED_ROW set
    if [[ -n "${MOCK_FAILED_ROW:-}" ]]; then
      echo "$MOCK_FAILED_ROW"
    fi
    ;;
esac
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
if grep -q "pg_advisory_lock" "$CALLLOG"; then ok "acquires advisory lock"; else bad "no advisory lock call"; fi
if grep -q "pg_advisory_unlock" "$CALLLOG"; then ok "releases advisory lock"; else bad "no advisory unlock call"; fi
if [[ $rc -eq 0 ]]; then ok "happy path exits 0"; else bad "happy path exit=$rc"; fi
if grep -q "APP_START_MARKER" <<<"$out"; then ok "reaches app-start step"; else bad "did not reach app-start"; fi
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

info "Case D — unrecoverable deploy failure: distinct non-zero + loud banner, app NOT started"
make_sandbox
out="$(run_script env MOCK_PENDING=1 MOCK_DEPLOY_FAIL=1 2>&1)"; rc=$?
if [[ $rc -ne 0 ]]; then ok "exits non-zero on unrecoverable failure (rc=$rc)"; else bad "exit 0 on failure"; fi
if grep -q "APP_START_MARKER" <<<"$out"; then bad "started app on half-migrated schema"; else ok "did NOT start app on failure"; fi
if grep -qi "MIGRATION FAILED" <<<"$out"; then ok "prints loud greppable failure banner"; else bad "no failure banner"; fi
if grep -q "migrate resolve" <<<"$out"; then ok "banner names the prisma migrate resolve remediation"; else bad "banner missing remediation command"; fi
if grep -qi "snapshot" <<<"$out"; then ok "banner names the snapshot path"; else bad "banner missing snapshot path"; fi
cleanup_sandbox

info "Case E — Dockerfile regression guard"
if grep -qE 'migrate deploy[[:space:]]*&&' "$DOCKERFILE"; then
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
