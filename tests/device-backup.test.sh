#!/usr/bin/env bash
# =============================================================================
# Integration test: full-device backup + restore drill (WARP-570)
#
# Exercises scripts/host/device-backup.sh + device-restore.sh against a
# DISPOSABLE docker compose project so it never touches the live device stack.
#
# This is the WARP-570 "documented + tested restore" gate. It:
#   1. Spins up a throwaway `db` (main Postgres) + `postgres-pm` (Plane) plus
#      the data volumes device-backup captures.
#   2. Seeds known rows in BOTH databases + a known file in EACH data volume.
#   3. Runs device-backup.sh against the disposable project.
#   4. Asserts the tarball contains a restorable artifact for EACH volume +
#      BOTH database dumps, and that the archive is mode 600 (never
#      world-readable — it holds secrets + DB dumps).
#   5. Mutates the data (drops rows, deletes files).
#   6. Runs device-restore.sh --force.
#   7. Asserts the original rows + files are back in every surface.
#   8. Asserts N-rotation prunes to BACKUP_KEEP.
#
# Docker-free static checks always run first, so a runner without Docker still
# gates the scripts' structure. The live drill SKIPS cleanly when Docker is
# unavailable.
#
# Prerequisites: Docker running (for the live drill). Runtime: ~30–60s.
# Env: KEEP_ARTIFACTS=1 leaves the disposable project + temp dirs for debugging.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_SCRIPT="$REPO_ROOT/scripts/host/device-backup.sh"
RESTORE_SCRIPT="$REPO_ROOT/scripts/host/device-restore.sh"

FAILURES=0
TESTS=0

# --- Helpers (match the repo's tests/factory-reset.test.sh convention) ---
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }
info() { printf "  \033[2m..\033[0m %s\n" "$1"; }
skip() { printf "  \033[33m○\033[0m %s (skipped)\n" "$1"; }

PROJECT="droplet-devbkptest-$$"
DISPOSABLE_COMPOSE=""
WORK_ROOT=""
OUTPUT_DIR=""

# Data volumes device-backup must capture. These are the REAL top-level volume
# names from docker/docker-compose.yml — a static check below asserts that.
VOLUMES=(nextcloud-data aikeys matter-data brain-memory-data nvrdata ops-audit)

echo ""
echo "  ================================================"
echo "  Full-device backup + restore drill (WARP-570)"
echo "  ================================================"
echo ""

# =============================================================================
# Static checks — always run, no Docker required.
# =============================================================================
echo "--- Static checks ---"

if [ -f "$BACKUP_SCRIPT" ];  then pass "device-backup.sh exists";  else fail "device-backup.sh missing"; fi
if [ -f "$RESTORE_SCRIPT" ]; then pass "device-restore.sh exists"; else fail "device-restore.sh missing"; fi

if [ -f "$BACKUP_SCRIPT" ] && [ -f "$RESTORE_SCRIPT" ]; then
  [ -x "$BACKUP_SCRIPT" ]  && pass "device-backup.sh executable"  || fail "device-backup.sh not executable"
  [ -x "$RESTORE_SCRIPT" ] && pass "device-restore.sh executable" || fail "device-restore.sh not executable"

  bash -n "$BACKUP_SCRIPT"  && pass "device-backup.sh parses"  || fail "device-backup.sh syntax error"
  bash -n "$RESTORE_SCRIPT" && pass "device-restore.sh parses" || fail "device-restore.sh syntax error"

  grep -qE 'set -euo pipefail' "$BACKUP_SCRIPT"  && pass "backup uses strict mode"  || fail "backup missing strict mode"
  grep -qE 'set -euo pipefail' "$RESTORE_SCRIPT" && pass "restore uses strict mode" || fail "restore missing strict mode"

  # Both Postgres instances dumped.
  grep -q 'pg_dump' "$BACKUP_SCRIPT"     && pass "backup runs pg_dump"        || fail "backup never calls pg_dump"
  grep -q 'DB_SERVICE' "$BACKUP_SCRIPT"  && pass "backup targets main db svc" || fail "backup has no main db service"
  grep -q 'postgres-pm' "$BACKUP_SCRIPT" && pass "backup targets postgres-pm" || fail "backup omits postgres-pm"

  # Every data volume named in the backup script.
  for v in "${VOLUMES[@]}"; do
    grep -q "$v" "$BACKUP_SCRIPT" && pass "backup references volume $v" || fail "backup omits volume $v"
  done

  # REGRESSION GUARD (WARP-570 review blocker): every volume the backup script
  # captures MUST be a real top-level volume in docker/docker-compose.yml.
  # `docker run -v <name>:/data` auto-creates a missing volume empty, so a
  # typo'd name silently backs up nothing. This is the check that would have
  # caught the original `aikeys-data`/`matter-storage-data`/`pm-attachments-data`
  # mismatch. We parse DATA_VOLUMES straight from the script so the two can't
  # drift.
  COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
  if [ -f "$COMPOSE_FILE" ]; then
    # Extract the top-level `volumes:` block keys (2-space-indented names).
    real_volumes="$(awk '
      /^volumes:/ {invol=1; next}
      invol && /^[^[:space:]]/ {invol=0}
      invol && /^  [A-Za-z0-9_-]+:/ {gsub(/[: ]/,""); print}
    ' "$COMPOSE_FILE")"
    # Extract DATA_VOLUMES entries from the backup script itself.
    script_volumes="$(awk '
      /^DATA_VOLUMES=\(/ {inarr=1; next}
      inarr && /\)/ {inarr=0}
      inarr {gsub(/[[:space:]]/,""); if ($0 != "") print}
    ' "$BACKUP_SCRIPT")"
    while IFS= read -r v; do
      [ -z "$v" ] && continue
      if printf '%s\n' "$real_volumes" | grep -qx "$v"; then
        pass "DATA_VOLUMES '$v' is a real compose volume"
      else
        fail "DATA_VOLUMES '$v' is NOT a top-level volume in docker-compose.yml (would auto-create empty)"
      fi
    done <<< "$script_volumes"
  else
    fail "docker-compose.yml not found for volume-name cross-check"
  fi

  # REGRESSION GUARD (stale compose-project default): neither host script may
  # default PROJECT to the RETIRED pre-WARP-605 `droplet-pi-platform`. The live
  # project is `droplet`, pinned via `name:` in docker-compose.yml; Docker
  # prefixes volumes `<project>_<vol>`, so a stale default makes backup/restore
  # target nonexistent `droplet-pi-platform_*` volumes and silently capture /
  # restore NOTHING. Both must DERIVE the default from the compose `name:` field
  # (mirroring scripts/factory-reset.sh) while still honouring a PROJECT=
  # override — the same stale-naming bug class as the volume cross-check above.
  for s in "$BACKUP_SCRIPT" "$RESTORE_SCRIPT"; do
    nm="$(basename "$s")"
    grep -qF 'PROJECT:-droplet-pi-platform' "$s" \
      && fail "$nm still defaults PROJECT to retired 'droplet-pi-platform'" \
      || pass "$nm drops the retired 'droplet-pi-platform' default"
    grep -qF "grep -E '^name:[[:space:]]'" "$s" \
      && pass "$nm derives PROJECT from the compose name: field" \
      || fail "$nm does not derive PROJECT from the compose name: field"
  done

  # Secrets safety: chmod 600 on the archive.
  grep -qE 'chmod 600' "$BACKUP_SCRIPT" && pass "backup chmod 600 the archive" || fail "backup does not chmod 600 (secrets exposure)"

  # Rotation.
  grep -qE 'BACKUP_KEEP' "$BACKUP_SCRIPT" && pass "backup honours BACKUP_KEEP rotation" || fail "backup has no rotation knob"
fi

# --- factory-reset safeguard (static) ---
FACTORY_RESET="$REPO_ROOT/scripts/factory-reset.sh"
if [ -f "$FACTORY_RESET" ]; then
  grep -qE '\-\-no-backup' "$FACTORY_RESET" \
    && pass "factory-reset parses --no-backup flag" || fail "factory-reset missing --no-backup flag"
  grep -q 'host/device-backup.sh' "$FACTORY_RESET" \
    && pass "factory-reset invokes device-backup.sh" || fail "factory-reset does not call device-backup.sh"

  # The safety backup MUST be emitted before the destructive `down -v`.
  # Match the actual SHELL STATEMENTS, not prose: strip comment lines
  # (leading-whitespace + '#') before locating the backup invocation
  # (`"$BACKUP_SCRIPT"`) and the first real `down -v` command. Earlier this
  # grep matched a `down -v` mention inside a comment, which made the ordering
  # check spuriously fail.
  reset_code="$(grep -vE '^[[:space:]]*#' "$FACTORY_RESET")"
  backup_line="$(printf '%s\n' "$reset_code" | grep -n '"\$BACKUP_SCRIPT"' | head -1 | cut -d: -f1)"
  downv_line="$(printf '%s\n' "$reset_code" | grep -nE '(^|[^#])\bdown -v\b' | head -1 | cut -d: -f1)"
  if [ -n "$backup_line" ] && [ -n "$downv_line" ] && [ "$backup_line" -lt "$downv_line" ]; then
    pass "safety backup runs before 'down -v' (stmt $backup_line < $downv_line)"
  else
    fail "safety backup not guaranteed before 'down -v' (backup@$backup_line, down-v@$downv_line)"
  fi

  # A failed safety backup must abort the reset.
  grep -q 'Safety backup FAILED' "$FACTORY_RESET" \
    && pass "factory-reset aborts on failed backup" || fail "factory-reset does not abort on failed backup"
else
  fail "scripts/factory-reset.sh missing"
fi

# =============================================================================
# Live docker drill.
# =============================================================================
echo ""
echo "--- Live docker drill ---"

have_docker() { docker info >/dev/null 2>&1; }

cleanup() {
  if [ "${KEEP_ARTIFACTS:-0}" = "1" ]; then
    info "KEEP_ARTIFACTS=1 — leaving $PROJECT + $WORK_ROOT"
    return
  fi
  if [ -n "$DISPOSABLE_COMPOSE" ] && [ -f "$DISPOSABLE_COMPOSE" ]; then
    docker compose -p "$PROJECT" -f "$DISPOSABLE_COMPOSE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  [ -n "$WORK_ROOT" ] && rm -rf "$WORK_ROOT" 2>/dev/null || true
}

dc() { docker compose -p "$PROJECT" -f "$DISPOSABLE_COMPOSE" "$@"; }

make_disposable_compose() {
  cat > "$DISPOSABLE_COMPOSE" <<YAML
services:
  db:
    image: ${TEST_PG_IMAGE:-postgres:16-alpine}
    environment:
      POSTGRES_USER: droplet
      POSTGRES_DB: droplet
      POSTGRES_PASSWORD: testpass
    volumes:
      - aikeys:/keys
      - matter-data:/data/matter
      - brain-memory-data:/data/brain
      - nextcloud-data:/var/www/html
      - nvrdata:/data/nvr
      - ops-audit:/data/audit
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U droplet"]
      interval: 2s
      timeout: 3s
      retries: 40
  postgres-pm:
    image: ${TEST_PG_IMAGE:-postgres:16-alpine}
    environment:
      POSTGRES_USER: planeuser
      POSTGRES_DB: plane
      POSTGRES_PASSWORD: planepass
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U planeuser"]
      interval: 2s
      timeout: 3s
      retries: 40
volumes:
  aikeys:
  matter-data:
  brain-memory-data:
  nextcloud-data:
  nvrdata:
  ops-audit:
YAML
}

wait_healthy() {
  local svc="$1" tries=60 cid status
  while [ "$tries" -gt 0 ]; do
    cid="$(dc ps -q "$svc" 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
      [ "$status" = "healthy" ] && return 0
    fi
    tries=$((tries - 1))
    sleep 1
  done
  return 1
}

seed_volume_markers() {
  dc exec -T db sh -c '
    echo AIKEY-MARKER > /keys/marker.txt
    echo MATTER-MARKER > /data/matter/marker.txt
    echo BRAIN-MARKER > /data/brain/marker.txt
    echo NEXTCLOUD-MARKER > /var/www/html/marker.txt
    echo NVR-MARKER > /data/nvr/marker.txt
    echo AUDIT-MARKER > /data/audit/marker.txt
  '
}

seed_db_rows() {
  dc exec -T db sh -c 'psql -U droplet -d droplet -c "CREATE TABLE IF NOT EXISTS t(id int); INSERT INTO t VALUES (42);"' >/dev/null
  dc exec -T postgres-pm sh -c 'psql -U planeuser -d plane -c "CREATE TABLE IF NOT EXISTS t(id int); INSERT INTO t VALUES (99);"' >/dev/null
}

db_count_main() { dc exec -T db sh -c 'psql -U droplet -d droplet -tAc "SELECT count(*) FROM t WHERE id=42;"' 2>/dev/null | tr -d '[:space:]'; }
db_count_pm()   { dc exec -T postgres-pm sh -c 'psql -U planeuser -d plane -tAc "SELECT count(*) FROM t WHERE id=99;"' 2>/dev/null | tr -d '[:space:]'; }
marker_present() { dc exec -T "$1" sh -c "[ -f '$2' ] && echo yes || echo no" 2>/dev/null | tr -d '[:space:]'; }

if ! command -v docker >/dev/null 2>&1 || ! have_docker; then
  skip "Docker not available — live drill skipped (static checks ran)"
elif [ ! -f "$BACKUP_SCRIPT" ]; then
  skip "backup script missing — live drill skipped"
else
  WORK_ROOT="$(mktemp -d -t devbkp-XXXXXXXX)"
  OUTPUT_DIR="$WORK_ROOT/backups"
  DISPOSABLE_COMPOSE="$WORK_ROOT/compose.yml"
  mkdir -p "$OUTPUT_DIR"
  trap cleanup EXIT

  make_disposable_compose
  info "bringing up disposable project $PROJECT"
  dc up -d >/dev/null 2>&1 || true

  if ! wait_healthy db || ! wait_healthy postgres-pm; then
    fail "disposable Postgres did not become healthy"
  else
    seed_db_rows
    seed_volume_markers
    pass "seeded both DBs + volume markers"

    # --- Backup -----------------------------------------------------------
    info "running device-backup.sh"
    if PROJECT="$PROJECT" COMPOSE_FILE="$DISPOSABLE_COMPOSE" \
         DB_SERVICE=db DB_USER=droplet DB_NAME=droplet \
         PM_SERVICE=postgres-pm BACKUP_KEEP=7 \
         bash "$BACKUP_SCRIPT" "$OUTPUT_DIR" >/dev/null 2>&1; then
      pass "device-backup.sh exited 0"
    else
      fail "device-backup.sh failed"
    fi

    ARCHIVE="$(ls -1t "$OUTPUT_DIR"/device-backup-*.tar.gz 2>/dev/null | head -1 || true)"
    if [ -z "$ARCHIVE" ]; then
      fail "no archive produced"
    else
      pass "archive produced"

      MODE="$(stat -c '%a' "$ARCHIVE" 2>/dev/null || stat -f '%Lp' "$ARCHIVE" 2>/dev/null || echo '')"
      [ "$MODE" = "600" ] && pass "archive mode is 600" || fail "archive mode is $MODE (expected 600)"

      LIST="$(tar -tzf "$ARCHIVE")"
      echo "$LIST" | grep -q 'postgres/main.sql.gz' && pass "main db dump in archive" || fail "main db dump missing"
      echo "$LIST" | grep -q 'postgres/pm.sql.gz'   && pass "pm db dump in archive"   || fail "pm db dump missing"
      echo "$LIST" | grep -q 'manifest.json'        && pass "manifest in archive"     || fail "manifest missing"
      for v in "${VOLUMES[@]}"; do
        echo "$LIST" | grep -q "volumes/$v/data.tar" && pass "volume artifact present: $v" || fail "volume artifact missing: $v"
      done

      # --- Mutate ---------------------------------------------------------
      dc exec -T db sh -c 'psql -U droplet -d droplet -c "DELETE FROM t;"' >/dev/null 2>&1
      dc exec -T postgres-pm sh -c 'psql -U planeuser -d plane -c "DELETE FROM t;"' >/dev/null 2>&1
      dc exec -T db sh -c 'rm -f /keys/marker.txt /data/matter/marker.txt /data/brain/marker.txt /var/www/html/marker.txt /data/nvr/marker.txt /data/audit/marker.txt' >/dev/null 2>&1
      { [ "$(db_count_main)" = "0" ] && [ "$(db_count_pm)" = "0" ]; } && pass "data mutated (rows dropped)" || fail "mutation did not take"

      # --- Restore --------------------------------------------------------
      info "running device-restore.sh --force"
      if PROJECT="$PROJECT" COMPOSE_FILE="$DISPOSABLE_COMPOSE" \
           DB_SERVICE=db DB_USER=droplet DB_NAME=droplet \
           PM_SERVICE=postgres-pm SKIP_SERVICE_RESTART=1 \
           bash "$RESTORE_SCRIPT" --force "$ARCHIVE" >/dev/null 2>&1; then
        pass "device-restore.sh exited 0"
      else
        fail "device-restore.sh failed"
      fi

      # --- Assert recovery ------------------------------------------------
      [ "$(db_count_main)" = "1" ] && pass "main db row restored" || fail "main db row NOT restored (count=$(db_count_main))"
      [ "$(db_count_pm)" = "1" ]   && pass "pm db row restored"   || fail "pm db row NOT restored (count=$(db_count_pm))"

      [ "$(marker_present db /keys/marker.txt)" = "yes" ]        && pass "aikeys volume restored"       || fail "aikeys volume NOT restored"
      [ "$(marker_present db /data/matter/marker.txt)" = "yes" ] && pass "matter volume restored"       || fail "matter volume NOT restored"
      [ "$(marker_present db /data/brain/marker.txt)" = "yes" ]  && pass "brain-memory volume restored" || fail "brain-memory volume NOT restored"
      [ "$(marker_present db /var/www/html/marker.txt)" = "yes" ] && pass "nextcloud volume restored"   || fail "nextcloud volume NOT restored"
      [ "$(marker_present db /data/nvr/marker.txt)" = "yes" ]    && pass "nvrdata volume restored"      || fail "nvrdata volume NOT restored"
      [ "$(marker_present db /data/audit/marker.txt)" = "yes" ]  && pass "ops-audit volume restored"    || fail "ops-audit volume NOT restored"

      # --- Rotation -------------------------------------------------------
      info "testing rotation (BACKUP_KEEP=2)"
      for _ in 1 2 3 4; do
        PROJECT="$PROJECT" COMPOSE_FILE="$DISPOSABLE_COMPOSE" \
          DB_SERVICE=db DB_USER=droplet DB_NAME=droplet PM_SERVICE=postgres-pm \
          BACKUP_KEEP=2 bash "$BACKUP_SCRIPT" "$OUTPUT_DIR" >/dev/null 2>&1 || true
        sleep 1
      done
      COUNT="$(ls -1 "$OUTPUT_DIR"/device-backup-*.tar.gz 2>/dev/null | wc -l | tr -d '[:space:]')"
      [ "$COUNT" = "2" ] && pass "rotation kept exactly BACKUP_KEEP=2" || fail "rotation kept $COUNT (expected 2)"
    fi
  fi
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ "$FAILURES" -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit "$FAILURES"
