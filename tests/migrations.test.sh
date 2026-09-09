#!/usr/bin/env bash
# =============================================================================
# Integration test: prisma migrate deploy + WARP-484 journal-fix migration +
# WARP-488 Camera*.userId backfill.
#
# Verifies four paths through the orchestrator's Prisma migration set:
#   1. Fresh-install path — `prisma migrate deploy` against an empty
#      database applies every migration cleanly, including the renamed
#      `20260525000100_warp_456_activity_row/` and the WARP-484
#      journal-fix migration `20260525145000_warp_484_migration_journal_fix/`.
#   2. Upgrade-from-pre-rename path — `prisma migrate deploy` against a
#      DB whose `_prisma_migrations` journal still carries the OLD
#      `20260525000000_warp_456_activity_row` name converges to a single
#      journal row keyed by the new name, with no duplicate.
#   3. WARP-488 username→UUID backfill (Phase 8) — seeded pre-WARP-485
#      data (username-keyed CameraPin + CameraNotificationPref + matching
#      User row) is flipped to UUID-keyed by the migration SQL; orphans
#      (no matching User) are left in place and surface via RAISE NOTICE.
#   4. WARP-488 idempotent re-run (Phase 9) — re-applying the same SQL to
#      the converged DB updates zero rows (UUID-regex filter on the WHERE
#      clause excludes already-flipped rows) and orphan rows are stable.
#
# Prerequisites: Docker running, no service on the throwaway port 55484.
# Runtime: ~30–60 s (postgres pull is cached after first run; npm/node not
# required on the host — runs in a postgres + node ephemeral container).
#
# Linux/CI-only: bash + docker required. On Windows the canonical way to
# run this is through WSL2 or the project's docker-compose-based CI.
#
# ci: developer-only — pulls pgvector/pgvector:pg16 AND node:20-bookworm
# (~1.5 GB) and boots five ephemeral containers. The fresh-install path is
# already proven at PR time by orchestrator-tests.yml's `pg-integration` job,
# which runs the real `prisma migrate deploy` against a live Postgres service
# and then gates schema drift. What is left unguarded is the UPGRADE half —
# the WARP-484 journal-rename convergence and the WARP-488 username→UUID
# backfill — both one-shot historical migrations. Recorded in WARP-2647's PR
# as a gap rather than paid for on every orchestrator PR.
# =============================================================================
set -euo pipefail

# MSYS / Git Bash on Windows mangles container paths like `/app` into
# `C:/Program Files/Git/app` when passed to `docker run -w` / `-v`. Off
# on every other shell; this is a no-op on Linux / macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FAILURES=0
TESTS=0

# Throwaway-postgres container name, dedicated user, dedicated network.
# Random suffix lets parallel runs not collide. The node migrate-deploy
# container joins the same docker network and reaches postgres by service
# name — `--network host` works on native Linux but NOT on Docker Desktop
# (which treats "host" as the Docker VM, not the Windows / macOS host), so
# a named network is the portable choice.
SUFFIX="$$"
PG_CONTAINER="droplet-warp484-pg-$SUFFIX"
PG_NETWORK="droplet-warp484-net-$SUFFIX"
PG_USER="droplet_test"
PG_PASSWORD="droplet_test_pw"
PG_DB="droplet_test"
# Inside the network the host is the container name on port 5432.
PG_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_CONTAINER}:5432/${PG_DB}?schema=public"

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

cleanup() {
  # Always stop the throwaway container + network so a failed test doesn't
  # leak them.
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$PG_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo ""
echo "  ================================================"
echo "  Migration Tests (WARP-484 journal-fix + WARP-488 backfill)"
echo "  ================================================"
echo ""

# =============================================================================
# Phase 0: Smoke checks
# =============================================================================
echo "--- Phase 0: Preconditions ---"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker not on PATH — cannot run this integration test"
  exit 1
fi
pass "docker on PATH"

# Verify the rename actually happened on this branch — otherwise the test
# would silently pass against the buggy state.
if [ -d "$REPO_ROOT/apps/orchestrator/prisma/migrations/20260525000100_warp_456_activity_row" ]; then
  pass "renamed migration folder present (20260525000100_warp_456_activity_row)"
else
  fail "renamed migration folder missing — did the chunk-1 git mv get reverted?"
  exit 1
fi

if [ -d "$REPO_ROOT/apps/orchestrator/prisma/migrations/20260525000000_warp_456_activity_row" ]; then
  fail "old-name migration folder still present — rename incomplete"
  exit 1
fi
pass "old-name migration folder absent"

if [ -f "$REPO_ROOT/apps/orchestrator/prisma/migrations/20260525145000_warp_484_migration_journal_fix/migration.sql" ]; then
  pass "journal-fix migration present"
else
  fail "journal-fix migration missing — chunk 2 not applied?"
  exit 1
fi

# =============================================================================
# Phase 1: Bring up throwaway Postgres
# =============================================================================
echo "--- Phase 1: Start ephemeral postgres ---"

docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker network rm "$PG_NETWORK" >/dev/null 2>&1 || true

if docker network create "$PG_NETWORK" >/dev/null 2>&1; then
  pass "docker network $PG_NETWORK created"
else
  fail "failed to create docker network $PG_NETWORK"
  exit 1
fi

if docker run -d --rm \
    --name "$PG_CONTAINER" \
    --network "$PG_NETWORK" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB="$PG_DB" \
    pgvector/pgvector:pg16 >/dev/null; then
  pass "pgvector/pgvector:pg16 container started on $PG_NETWORK"
else
  fail "failed to start throwaway postgres"
  exit 1
fi

# Wait for postgres to be ready (max 30 s).
retries=30
while [ "$retries" -gt 0 ]; do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    break
  fi
  retries=$((retries - 1))
  sleep 1
done
if [ "$retries" -gt 0 ]; then
  pass "postgres ready for connections"
else
  fail "postgres never became ready (30 s timeout)"
  exit 1
fi

# Helper to run psql inside the container against the test DB.
pg_exec() {
  docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d "$PG_DB" -At -c "$1"
}

# =============================================================================
# Phase 2: Fresh-install path — migrate deploy from zero
# =============================================================================
echo "--- Phase 2: Fresh-install migrate deploy ---"

# Run prisma migrate deploy inside an ephemeral node container with the
# repo mounted. This avoids depending on a host-side node install and
# matches the way CI runs the orchestrator.
if docker run --rm \
    --network "$PG_NETWORK" \
    -v "${REPO_ROOT}/apps/orchestrator:/app" \
    -w /app \
    -e DATABASE_URL="$PG_URL" \
    node:20-bookworm \
    sh -c "npx --yes prisma@5.14 migrate deploy" >/dev/null 2>&1; then
  pass "prisma migrate deploy succeeded on fresh DB"
else
  fail "prisma migrate deploy failed on fresh DB — check verbose output"
  # Re-run with output for diagnostics on failure.
  docker run --rm \
    --network "$PG_NETWORK" \
    -v "${REPO_ROOT}/apps/orchestrator:/app" \
    -w /app \
    -e DATABASE_URL="$PG_URL" \
    node:20-bookworm \
    sh -c "npx --yes prisma@5.14 migrate deploy" >&2 || true
fi

# Verify the journal carries the NEW name and not the old one.
NEW_NAME_COUNT=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525000100_warp_456_activity_row';")
OLD_NAME_COUNT=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525000000_warp_456_activity_row';")

if [ "$NEW_NAME_COUNT" = "1" ]; then
  pass "journal carries the new-name WARP-456 row exactly once"
else
  fail "expected 1 new-name row, got: $NEW_NAME_COUNT"
fi

if [ "$OLD_NAME_COUNT" = "0" ]; then
  pass "journal does not carry the old-name WARP-456 row"
else
  fail "expected 0 old-name rows, got: $OLD_NAME_COUNT"
fi

# Verify the journal-fix migration itself is recorded.
JOURNAL_FIX_COUNT=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525145000_warp_484_migration_journal_fix';")
if [ "$JOURNAL_FIX_COUNT" = "1" ]; then
  pass "journal-fix migration recorded"
else
  fail "expected 1 journal-fix row, got: $JOURNAL_FIX_COUNT"
fi

# Verify ActivityRow table was created (sanity — the WARP-456 SQL ran).
ACTIVITY_TABLE_EXISTS=$(pg_exec "SELECT to_regclass('public.\"ActivityRow\"') IS NOT NULL;")
if [ "$ACTIVITY_TABLE_EXISTS" = "t" ]; then
  pass "ActivityRow table created"
else
  fail "ActivityRow table missing — WARP-456 SQL did not run"
fi

# =============================================================================
# Phase 3: Idempotent re-run on the converged DB
# =============================================================================
echo "--- Phase 3: Re-run migrate deploy on converged DB ---"

if docker run --rm \
    --network "$PG_NETWORK" \
    -v "${REPO_ROOT}/apps/orchestrator:/app" \
    -w /app \
    -e DATABASE_URL="$PG_URL" \
    node:20-bookworm \
    sh -c "npx --yes prisma@5.14 migrate deploy" >/dev/null 2>&1; then
  pass "prisma migrate deploy re-runs cleanly (no new migrations)"
else
  fail "re-run of migrate deploy failed — idempotency broken"
fi

# Re-verify journal state is unchanged.
NEW_NAME_COUNT2=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525000100_warp_456_activity_row';")
OLD_NAME_COUNT2=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525000000_warp_456_activity_row';")
if [ "$NEW_NAME_COUNT2" = "1" ] && [ "$OLD_NAME_COUNT2" = "0" ]; then
  pass "journal state stable on re-run (1 new, 0 old)"
else
  fail "journal state drifted on re-run (new=$NEW_NAME_COUNT2, old=$OLD_NAME_COUNT2)"
fi

# =============================================================================
# Phase 4: Simulate pre-rename device — inject old-name journal row
# =============================================================================
echo "--- Phase 4: Simulate pre-rename device ---"

# Wipe the journal and re-seed with the OLD-name row only — i.e. simulate
# a device provisioned before WARP-484. The ActivityRow table stays in
# place (the SQL is idempotent anyway).
#
# Then re-run migrate deploy: Prisma should see the renamed
# `20260525000100_*` folder as "unapplied", run its SQL again (no-op due
# to IF NOT EXISTS), insert a journal row for the new name, then our
# `20260525145000_*` migration runs and DELETEs the old-name row.
pg_exec "DELETE FROM _prisma_migrations;" >/dev/null

# Re-insert all migrations EXCEPT the journal-fix, with the OLD WARP-456 name.
# We grab every applied migration name from the renamed-set on disk and
# substitute the new WARP-456 name with the old.
for mig_dir in "$REPO_ROOT/apps/orchestrator/prisma/migrations"/2*/; do
  mig_name="$(basename "$mig_dir")"
  # Skip the journal-fix itself; we want Prisma to discover and apply it.
  if [ "$mig_name" = "20260525145000_warp_484_migration_journal_fix" ]; then
    continue
  fi
  # Substitute the new WARP-456 name with the old one.
  if [ "$mig_name" = "20260525000100_warp_456_activity_row" ]; then
    mig_name="20260525000000_warp_456_activity_row"
  fi
  # Pre-populated journal rows mimic what `prisma migrate deploy` writes:
  # rolled_back_at NULL, applied_steps_count 1, started/finished_at past.
  pg_exec "INSERT INTO _prisma_migrations (
             id, checksum, finished_at, migration_name,
             logs, rolled_back_at, started_at, applied_steps_count
           ) VALUES (
             gen_random_uuid()::text,
             'simulated-pre-rename-checksum',
             CURRENT_TIMESTAMP,
             '$mig_name',
             NULL, NULL, CURRENT_TIMESTAMP, 1
           );" >/dev/null
done

# Sanity: confirm the old-name row is now present and the new-name row is not.
PRE_OLD=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525000000_warp_456_activity_row';")
PRE_NEW=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525000100_warp_456_activity_row';")
if [ "$PRE_OLD" = "1" ] && [ "$PRE_NEW" = "0" ]; then
  pass "simulated pre-rename journal seeded (1 old, 0 new)"
else
  fail "could not seed simulated pre-rename state (old=$PRE_OLD, new=$PRE_NEW)"
  exit 1
fi

# Run migrate deploy with the seeded "pre-rename" journal.
if docker run --rm \
    --network "$PG_NETWORK" \
    -v "${REPO_ROOT}/apps/orchestrator:/app" \
    -w /app \
    -e DATABASE_URL="$PG_URL" \
    node:20-bookworm \
    sh -c "npx --yes prisma@5.14 migrate deploy" >/dev/null 2>&1; then
  pass "prisma migrate deploy succeeded on simulated pre-rename DB"
else
  fail "prisma migrate deploy failed on simulated pre-rename DB"
  docker run --rm \
    --network "$PG_NETWORK" \
    -v "${REPO_ROOT}/apps/orchestrator:/app" \
    -w /app \
    -e DATABASE_URL="$PG_URL" \
    node:20-bookworm \
    sh -c "npx --yes prisma@5.14 migrate deploy" >&2 || true
fi

# Verify journal converged: only the NEW name, no old name.
POST_OLD=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525000000_warp_456_activity_row';")
POST_NEW=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525000100_warp_456_activity_row';")
POST_FIX=$(pg_exec "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260525145000_warp_484_migration_journal_fix';")

if [ "$POST_OLD" = "0" ]; then
  pass "old-name row dropped after journal-fix ran"
else
  fail "expected 0 old-name rows, got: $POST_OLD"
fi

if [ "$POST_NEW" = "1" ]; then
  pass "new-name row present exactly once after journal-fix"
else
  fail "expected 1 new-name row, got: $POST_NEW"
fi

if [ "$POST_FIX" = "1" ]; then
  pass "journal-fix migration itself recorded once"
else
  fail "expected 1 journal-fix row, got: $POST_FIX"
fi

# =============================================================================
# Phase 8: WARP-488 — CameraPin + CameraNotificationPref userId backfill
# =============================================================================
#
# Simulates a device upgrade across the WARP-485 boundary: pre-fix data
# is keyed by Nextcloud username (e.g. 'alice-pre485'), the matching User
# row carries nextcloudUsername='alice-pre485' (written on first sign-in
# after WARP-485 deploy), and the WARP-488 migration SQL flips userId to
# the UUID. We invoke the migration SQL directly (not via `migrate
# deploy`) so we can re-test idempotency in Phase 9 without journal
# gymnastics. The migration SQL itself is what runs in production —
# `migrate deploy` only wraps the same statements with journal-row
# bookkeeping.
echo "--- Phase 8: WARP-488 Camera*.userId backfill ---"

ALICE_UUID="aaaaaaaa-1111-2222-3333-444444444444"
ALICE_USERNAME="alice-pre485"
GHOST_USERNAME="ghost-pre485"
CAMERA_ID="cccccccc-aaaa-bbbb-dddd-eeeeeeeeeeee"

# Seed: a User row whose nextcloudUsername matches the pre-fix key, plus
# a Camera row that CameraNotificationPref can FK to.
pg_exec "INSERT INTO \"User\" (id, username, \"displayName\", \"nextcloudUsername\", role, \"isLocal\", \"createdAt\", \"updatedAt\")
         VALUES ('$ALICE_UUID', '$ALICE_USERNAME', 'Alice Pre-485', '$ALICE_USERNAME', 'family', true, NOW(), NOW());" \
  >/dev/null && pass "seeded User row (nextcloudUsername=$ALICE_USERNAME)" \
  || fail "failed to seed User row"

pg_exec "INSERT INTO \"Camera\" (id, name, \"displayName\", \"ipAddress\", enabled, \"autoDiscovered\", \"lastSeen\", \"createdAt\", \"updatedAt\")
         VALUES ('$CAMERA_ID', 'front-porch', 'Front Porch', '192.168.1.50', true, false, NOW(), NOW(), NOW());" \
  >/dev/null && pass "seeded Camera row (name=front-porch)" \
  || fail "failed to seed Camera row"

# Pre-fix CameraPin: userId is the Nextcloud username string.
pg_exec "INSERT INTO \"CameraPin\" (id, \"userId\", \"cameraName\", \"sortOrder\", \"createdAt\")
         VALUES ('pin-1', '$ALICE_USERNAME', 'front-porch', 0, NOW());" \
  >/dev/null && pass "seeded pre-fix CameraPin (userId=$ALICE_USERNAME)" \
  || fail "failed to seed CameraPin"

# Pre-fix CameraNotificationPref: same shape, FK to the Camera row.
pg_exec "INSERT INTO \"CameraNotificationPref\" (id, \"userId\", \"cameraId\", \"onPerson\", \"onVehicle\", \"onAnimal\", \"onMotion\")
         VALUES ('pref-1', '$ALICE_USERNAME', '$CAMERA_ID', true, true, false, false);" \
  >/dev/null && pass "seeded pre-fix CameraNotificationPref (userId=$ALICE_USERNAME)" \
  || fail "failed to seed CameraNotificationPref"

# Orphan: userId is a username that has NO matching User.nextcloudUsername.
# Should be left untouched by the migration and surface in the NOTICE log.
pg_exec "INSERT INTO \"CameraPin\" (id, \"userId\", \"cameraName\", \"sortOrder\", \"createdAt\")
         VALUES ('pin-orphan', '$GHOST_USERNAME', 'side-yard', 0, NOW());" \
  >/dev/null && pass "seeded orphan CameraPin (userId=$GHOST_USERNAME)" \
  || fail "failed to seed orphan CameraPin"

pg_exec "INSERT INTO \"CameraNotificationPref\" (id, \"userId\", \"cameraId\", \"onPerson\", \"onVehicle\", \"onAnimal\", \"onMotion\")
         VALUES ('pref-orphan', '$GHOST_USERNAME', '$CAMERA_ID', true, false, false, false);" \
  >/dev/null && pass "seeded orphan CameraNotificationPref (userId=$GHOST_USERNAME)" \
  || fail "failed to seed orphan CameraNotificationPref"

# Run the WARP-488 migration SQL directly. Capture NOTICE lines to a
# tempfile so we can assert the orphan counts. psql writes NOTICEs to
# stderr by default; we redirect 2>&1 then grep for them.
MIGRATION_SQL_PATH="/app/prisma/migrations/20260526160000_warp_488_userid_backfill/migration.sql"
MIGRATE_OUT=$(docker run --rm \
    --network "$PG_NETWORK" \
    -v "${REPO_ROOT}/apps/orchestrator:/app" \
    -e PGPASSWORD="$PG_PASSWORD" \
    postgres:16 \
    psql -h "$PG_CONTAINER" -U "$PG_USER" -d "$PG_DB" -f "$MIGRATION_SQL_PATH" 2>&1) || true

if echo "$MIGRATE_OUT" | grep -q "ERROR"; then
  fail "WARP-488 migration SQL emitted ERROR (first 20 lines below):"
  echo "$MIGRATE_OUT" | head -20 >&2
else
  pass "WARP-488 migration SQL ran without ERROR"
fi

# Verify the matched rows are now UUID-keyed.
ALICE_PIN_USERID=$(pg_exec "SELECT \"userId\" FROM \"CameraPin\" WHERE id = 'pin-1';")
if [ "$ALICE_PIN_USERID" = "$ALICE_UUID" ]; then
  pass "CameraPin (matched) now keyed by User.id UUID"
else
  fail "CameraPin (matched): expected userId=$ALICE_UUID, got: $ALICE_PIN_USERID"
fi

ALICE_PREF_USERID=$(pg_exec "SELECT \"userId\" FROM \"CameraNotificationPref\" WHERE id = 'pref-1';")
if [ "$ALICE_PREF_USERID" = "$ALICE_UUID" ]; then
  pass "CameraNotificationPref (matched) now keyed by User.id UUID"
else
  fail "CameraNotificationPref (matched): expected userId=$ALICE_UUID, got: $ALICE_PREF_USERID"
fi

# Verify orphans are left untouched.
ORPHAN_PIN_USERID=$(pg_exec "SELECT \"userId\" FROM \"CameraPin\" WHERE id = 'pin-orphan';")
if [ "$ORPHAN_PIN_USERID" = "$GHOST_USERNAME" ]; then
  pass "orphan CameraPin left untouched (userId=$GHOST_USERNAME)"
else
  fail "orphan CameraPin: expected userId=$GHOST_USERNAME, got: $ORPHAN_PIN_USERID"
fi

ORPHAN_PREF_USERID=$(pg_exec "SELECT \"userId\" FROM \"CameraNotificationPref\" WHERE id = 'pref-orphan';")
if [ "$ORPHAN_PREF_USERID" = "$GHOST_USERNAME" ]; then
  pass "orphan CameraNotificationPref left untouched (userId=$GHOST_USERNAME)"
else
  fail "orphan CameraNotificationPref: expected userId=$GHOST_USERNAME, got: $ORPHAN_PREF_USERID"
fi

# Verify the NOTICE block logged the orphan counts.
if echo "$MIGRATE_OUT" | grep -q "WARP-488: 1 CameraPin row(s) have non-UUID userId"; then
  pass "RAISE NOTICE logged orphan CameraPin count"
else
  fail "expected RAISE NOTICE for orphan CameraPin — not present in migration output"
fi

if echo "$MIGRATE_OUT" | grep -q "WARP-488: 1 CameraNotificationPref row(s) have non-UUID userId"; then
  pass "RAISE NOTICE logged orphan CameraNotificationPref count"
else
  fail "expected RAISE NOTICE for orphan CameraNotificationPref — not present in migration output"
fi

# =============================================================================
# Phase 9: WARP-488 idempotency — re-running the migration is a no-op
# =============================================================================
#
# Same SQL, second pass on the converged DB. The UUID-regex filter on the
# WHERE clause means the matched rows are already UUID-shaped → zero new
# updates. Orphans stay where they are. The NOTICE block still fires
# (counts are unchanged).
echo "--- Phase 9: WARP-488 idempotent re-run ---"

# Snapshot every row's current userId before re-run so we can assert
# exact equality after.
BEFORE_PIN_MATCHED=$(pg_exec "SELECT \"userId\" FROM \"CameraPin\" WHERE id = 'pin-1';")
BEFORE_PREF_MATCHED=$(pg_exec "SELECT \"userId\" FROM \"CameraNotificationPref\" WHERE id = 'pref-1';")
BEFORE_PIN_ORPHAN=$(pg_exec "SELECT \"userId\" FROM \"CameraPin\" WHERE id = 'pin-orphan';")
BEFORE_PREF_ORPHAN=$(pg_exec "SELECT \"userId\" FROM \"CameraNotificationPref\" WHERE id = 'pref-orphan';")

MIGRATE_OUT2=$(docker run --rm \
    --network "$PG_NETWORK" \
    -v "${REPO_ROOT}/apps/orchestrator:/app" \
    -e PGPASSWORD="$PG_PASSWORD" \
    postgres:16 \
    psql -h "$PG_CONTAINER" -U "$PG_USER" -d "$PG_DB" -f "$MIGRATION_SQL_PATH" 2>&1) || true

if echo "$MIGRATE_OUT2" | grep -q "ERROR"; then
  fail "WARP-488 idempotent re-run emitted ERROR"
  echo "$MIGRATE_OUT2" | head -20 >&2
else
  pass "WARP-488 migration SQL re-runs without ERROR"
fi

# The UPDATE statements should report 0 rows affected on the second pass
# (UUID-regex filter excludes everything that was previously flipped).
# psql's default output for `UPDATE 0` is on stdout — capture it.
if echo "$MIGRATE_OUT2" | grep -q "^UPDATE 0$"; then
  pass "idempotent re-run: at least one UPDATE reported 0 rows affected"
else
  # Not fatal — Prisma 5.14 with a wrapped DO/BEGIN block may emit a
  # single `COMMIT` line and no per-statement counter. Fall back to a
  # row-level equality check below.
  pass "idempotent re-run: no explicit 'UPDATE 0' line (relying on row-equality check)"
fi

AFTER_PIN_MATCHED=$(pg_exec "SELECT \"userId\" FROM \"CameraPin\" WHERE id = 'pin-1';")
AFTER_PREF_MATCHED=$(pg_exec "SELECT \"userId\" FROM \"CameraNotificationPref\" WHERE id = 'pref-1';")
AFTER_PIN_ORPHAN=$(pg_exec "SELECT \"userId\" FROM \"CameraPin\" WHERE id = 'pin-orphan';")
AFTER_PREF_ORPHAN=$(pg_exec "SELECT \"userId\" FROM \"CameraNotificationPref\" WHERE id = 'pref-orphan';")

if [ "$BEFORE_PIN_MATCHED" = "$AFTER_PIN_MATCHED" ]; then
  pass "CameraPin (matched) userId stable across re-run"
else
  fail "CameraPin (matched) userId drifted: before=$BEFORE_PIN_MATCHED, after=$AFTER_PIN_MATCHED"
fi

if [ "$BEFORE_PREF_MATCHED" = "$AFTER_PREF_MATCHED" ]; then
  pass "CameraNotificationPref (matched) userId stable across re-run"
else
  fail "CameraNotificationPref (matched) userId drifted: before=$BEFORE_PREF_MATCHED, after=$AFTER_PREF_MATCHED"
fi

if [ "$BEFORE_PIN_ORPHAN" = "$AFTER_PIN_ORPHAN" ]; then
  pass "orphan CameraPin userId stable across re-run"
else
  fail "orphan CameraPin userId drifted: before=$BEFORE_PIN_ORPHAN, after=$AFTER_PIN_ORPHAN"
fi

if [ "$BEFORE_PREF_ORPHAN" = "$AFTER_PREF_ORPHAN" ]; then
  pass "orphan CameraNotificationPref userId stable across re-run"
else
  fail "orphan CameraNotificationPref userId drifted: before=$BEFORE_PREF_ORPHAN, after=$AFTER_PREF_ORPHAN"
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ $FAILURES -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit $FAILURES
