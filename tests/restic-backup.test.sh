#!/usr/bin/env bash
# =============================================================================
# Integration test: restic backup + restore + restore drill (WARP-254)
#
# Exercises scripts/host/droplet-backup.sh + droplet-restore.sh +
# droplet-restore-drill.sh against a DISPOSABLE docker compose project so it
# never touches the live device stack.
#
# WARP-254 is the long-term restic home foreshadowed in device-backup.sh
# (WARP-570). It:
#   1. Statically gates the three host scripts + the shared lib + the six
#      systemd units + the setup.sh install wiring.
#   2. Verifies the restic repository password is DERIVED (HKDF-SHA256) from
#      DEVICE_SECRET_KEY with a known-answer test computed independently in
#      python3 — the derivation is a stability contract: change it and every
#      existing repo on every shipped box becomes unreadable.
#   3. With Docker + restic present: seeds a disposable Postgres + volume,
#      runs backup (daily), backup again (incremental), backup --full
#      (weekly-full tag), mutates the data, restores, and asserts recovery.
#   4. Runs the restore drill and asserts the EXPLICIT status file enum
#      (ok|failed) — including the failure path (wrong derivation key MUST
#      write status "failed" and exit non-zero).
#
# Docker-free static checks always run first, so a runner without Docker or
# restic still gates the scripts' structure. The live drill SKIPS cleanly when
# Docker or restic are unavailable.
#
# Prerequisites: Docker + restic (for the live drill). Runtime: ~60-120s.
# Env: KEEP_ARTIFACTS=1 leaves the disposable project + temp dirs for debugging.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_SCRIPT="$REPO_ROOT/scripts/host/droplet-backup.sh"
RESTORE_SCRIPT="$REPO_ROOT/scripts/host/droplet-restore.sh"
DRILL_SCRIPT="$REPO_ROOT/scripts/host/droplet-restore-drill.sh"
LIB_SCRIPT="$REPO_ROOT/scripts/host/droplet-backup-lib.sh"
INSTALL_LIB="$REPO_ROOT/scripts/lib/backup.sh"
UNIT_DIR="$REPO_ROOT/scripts/host/systemd"

FAILURES=0
TESTS=0

# --- Helpers (match tests/device-backup.test.sh convention) ---
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }
info() { printf "  \033[2m..\033[0m %s\n" "$1"; }
skip() { printf "  \033[33m○\033[0m %s (skipped)\n" "$1"; }

PROJECT="droplet-resticdrill-$$"
DISPOSABLE_COMPOSE=""
WORK_ROOT=""

echo ""
echo "  ================================================"
echo "  Restic backup + restore drill (WARP-254)"
echo "  ================================================"
echo ""

# =============================================================================
# Static checks — always run, no Docker/restic required.
# =============================================================================
echo "--- Static checks: scripts ---"

for f in "$BACKUP_SCRIPT" "$RESTORE_SCRIPT" "$DRILL_SCRIPT" "$LIB_SCRIPT"; do
  nm="$(basename "$f")"
  if [ -f "$f" ]; then pass "$nm exists"; else fail "$nm missing"; continue; fi
  bash -n "$f" && pass "$nm parses" || fail "$nm syntax error"
done

if [ -f "$BACKUP_SCRIPT" ] && [ -f "$RESTORE_SCRIPT" ] && [ -f "$DRILL_SCRIPT" ] && [ -f "$LIB_SCRIPT" ]; then
  for f in "$BACKUP_SCRIPT" "$RESTORE_SCRIPT" "$DRILL_SCRIPT"; do
    nm="$(basename "$f")"
    [ -x "$f" ] && pass "$nm executable" || fail "$nm not executable"
    grep -qE 'set -euo pipefail' "$f" && pass "$nm uses strict mode" || fail "$nm missing strict mode"
  done

  # --- Derivation contract (lib) ---
  grep -q 'DEVICE_SECRET_KEY' "$LIB_SCRIPT" \
    && pass "lib derives from DEVICE_SECRET_KEY" || fail "lib does not reference DEVICE_SECRET_KEY"
  grep -qi 'hkdf' "$LIB_SCRIPT" \
    && pass "lib documents HKDF derivation" || fail "lib has no HKDF derivation"
  # The derived password must never land in a tracked file — the runtime
  # password file must live under a runtime dir default (/run/droplet).
  grep -q '/run/droplet' "$LIB_SCRIPT" \
    && pass "lib defaults the password file to a runtime path (/run/droplet)" \
    || fail "lib does not use a runtime path for the password file"

  # --- Backup script contract ---
  grep -q 'restic' "$BACKUP_SCRIPT" && pass "backup uses restic" || fail "backup never calls restic"
  grep -q 'pg_dump' "$BACKUP_SCRIPT" && pass "backup runs pg_dump" || fail "backup never calls pg_dump"
  grep -q 'DROPLET_BACKUP_TARGET' "$BACKUP_SCRIPT" \
    && pass "backup target configurable via DROPLET_BACKUP_TARGET" \
    || fail "backup has no DROPLET_BACKUP_TARGET knob"
  grep -q 'nextcloud-data' "$BACKUP_SCRIPT" \
    && pass "backup captures nextcloud-data" || fail "backup omits nextcloud-data"
  # Camera footage EXCLUDED by default, opt-in via flag (size rationale).
  grep -q 'DROPLET_BACKUP_INCLUDE_CAMERA' "$BACKUP_SCRIPT" \
    && pass "camera footage behind DROPLET_BACKUP_INCLUDE_CAMERA opt-in" \
    || fail "backup has no camera opt-in flag"
  grep -q 'nvrdata' "$BACKUP_SCRIPT" \
    && pass "backup knows the nvrdata (camera) volume" || fail "backup does not reference nvrdata"
  # Retention policy: 7 daily / 4 weekly / 6 monthly.
  grep -q -- '--keep-daily' "$BACKUP_SCRIPT" && grep -q -- '--keep-weekly' "$BACKUP_SCRIPT" \
    && grep -q -- '--keep-monthly' "$BACKUP_SCRIPT" \
    && pass "backup applies a restic forget retention policy" \
    || fail "backup has no restic forget retention policy"
  # Weekly full = restic backup --force re-read, tagged distinctly.
  grep -q 'weekly-full' "$BACKUP_SCRIPT" && pass "weekly-full tag present" || fail "no weekly-full tag"
  grep -qE 'restic.*--force|--force.*backup' "$BACKUP_SCRIPT" \
    && pass "full run re-reads with --force" || fail "full run does not use restic --force"
  # PROJECT must be derived from the compose `name:` field (WARP-570 guard).
  grep -qF "grep -E '^name:[[:space:]]'" "$BACKUP_SCRIPT" \
    && pass "backup derives PROJECT from the compose name: field" \
    || fail "backup does not derive PROJECT from the compose name: field"

  # --- Restore script contract ---
  grep -qE 'restic[^&|;]*check' "$RESTORE_SCRIPT" \
    && pass "restore runs restic check (integrity on every restore)" \
    || fail "restore never runs restic check"
  # The integrity check must come BEFORE the first destructive DROP DATABASE.
  restore_code="$(grep -vE '^[[:space:]]*#' "$RESTORE_SCRIPT")"
  check_line="$(printf '%s\n' "$restore_code" | grep -nE 'restic[^&|;]*check' | head -1 | cut -d: -f1)"
  drop_line="$(printf '%s\n' "$restore_code" | grep -n 'DROP DATABASE' | head -1 | cut -d: -f1)"
  if [ -n "$check_line" ] && [ -n "$drop_line" ] && [ "$check_line" -lt "$drop_line" ]; then
    pass "restic check precedes DROP DATABASE (stmt $check_line < $drop_line)"
  else
    fail "restic check not guaranteed before DROP DATABASE (check@${check_line:-?}, drop@${drop_line:-?})"
  fi
  grep -qE '\-\-force' "$RESTORE_SCRIPT" \
    && pass "restore confirm-gated with --force override" || fail "restore has no --force gate"

  # --- Drill script contract ---
  grep -qE 'restic[^&|;]*check' "$DRILL_SCRIPT" \
    && pass "drill runs restic check" || fail "drill never runs restic check"
  grep -q '"ok"' "$DRILL_SCRIPT" && grep -q '"failed"' "$DRILL_SCRIPT" \
    && pass "drill status enum is explicit (ok|failed)" \
    || fail "drill status enum missing ok/failed literals"
  grep -q '/var/lib/droplet/backup' "$DRILL_SCRIPT" \
    && pass "drill status file defaults under /var/lib/droplet/backup" \
    || fail "drill status file not under /var/lib/droplet/backup"
  grep -q 'logger' "$DRILL_SCRIPT" \
    && pass "drill logs loudly (logger) on failure" || fail "drill has no loud failure log"
fi

echo ""
echo "--- Static checks: systemd units + install wiring ---"

UNITS=(
  droplet-restic-backup.service
  droplet-restic-backup.timer
  droplet-restic-backup-full.service
  droplet-restic-backup-full.timer
  droplet-restore-drill.service
  droplet-restore-drill.timer
)
for u in "${UNITS[@]}"; do
  if [ -f "$UNIT_DIR/$u" ]; then pass "unit $u exists"; else fail "unit $u missing"; fi
done

for t in droplet-restic-backup.timer droplet-restic-backup-full.timer droplet-restore-drill.timer; do
  f="$UNIT_DIR/$t"
  [ -f "$f" ] || continue
  grep -q 'Persistent=true' "$f" && pass "$t is Persistent (missed runs fire on boot)" || fail "$t not Persistent"
  grep -q 'OnCalendar=' "$f" && pass "$t has OnCalendar" || fail "$t has no OnCalendar"
done

# Daily / weekly / monthly cadence.
if [ -f "$UNIT_DIR/droplet-restic-backup.timer" ]; then
  grep -qE 'OnCalendar=\*-\*-\* ' "$UNIT_DIR/droplet-restic-backup.timer" \
    && pass "backup timer is daily" || fail "backup timer is not daily"
fi
if [ -f "$UNIT_DIR/droplet-restic-backup-full.timer" ]; then
  grep -qE 'OnCalendar=(Sun|Mon|Tue|Wed|Thu|Fri|Sat)' "$UNIT_DIR/droplet-restic-backup-full.timer" \
    && pass "full-backup timer is weekly" || fail "full-backup timer is not weekly"
fi
if [ -f "$UNIT_DIR/droplet-restore-drill.timer" ]; then
  grep -qE 'OnCalendar=\*-\*-0?1 ' "$UNIT_DIR/droplet-restore-drill.timer" \
    && pass "restore-drill timer is monthly" || fail "restore-drill timer is not monthly"
fi

# Full service must pass --full; drill service must exec the drill script.
if [ -f "$UNIT_DIR/droplet-restic-backup-full.service" ]; then
  grep -qE 'ExecStart=.*droplet-backup\.sh --full' "$UNIT_DIR/droplet-restic-backup-full.service" \
    && pass "full service invokes droplet-backup.sh --full" || fail "full service missing --full"
fi
if [ -f "$UNIT_DIR/droplet-restore-drill.service" ]; then
  grep -qE 'ExecStart=.*droplet-restore-drill\.sh' "$UNIT_DIR/droplet-restore-drill.service" \
    && pass "drill service invokes droplet-restore-drill.sh" || fail "drill service wrong ExecStart"
fi
# Units carry the checkout path via @REPO_ROOT@ placeholder (installer sed).
for s in droplet-restic-backup.service droplet-restic-backup-full.service droplet-restore-drill.service; do
  f="$UNIT_DIR/$s"
  [ -f "$f" ] || continue
  grep -q '@REPO_ROOT@' "$f" && pass "$s parameterized via @REPO_ROOT@" || fail "$s missing @REPO_ROOT@"
done

# setup.sh wiring: the install lib exists, is sourced, and is invoked.
if [ -f "$INSTALL_LIB" ]; then
  pass "scripts/lib/backup.sh exists"
  bash -n "$INSTALL_LIB" && pass "scripts/lib/backup.sh parses" || fail "scripts/lib/backup.sh syntax error"
  grep -q 'install_restic_backup' "$INSTALL_LIB" \
    && pass "install lib defines install_restic_backup" || fail "install lib missing install_restic_backup"
  # Installer must install all three scripts + the shared lib + enable timers.
  for s in droplet-backup.sh droplet-restore.sh droplet-restore-drill.sh droplet-backup-lib.sh; do
    grep -q "$s" "$INSTALL_LIB" && pass "installer installs $s" || fail "installer omits $s"
  done
  grep -q 'droplet-restic-backup.timer' "$INSTALL_LIB" \
    && grep -q 'droplet-restic-backup-full.timer' "$INSTALL_LIB" \
    && grep -q 'droplet-restore-drill.timer' "$INSTALL_LIB" \
    && pass "installer enables all three timers" || fail "installer does not enable all timers"
else
  fail "scripts/lib/backup.sh missing"
fi

SETUP="$REPO_ROOT/scripts/setup.sh"
grep -q 'lib/backup.sh' "$SETUP" && pass "setup.sh sources lib/backup.sh" || fail "setup.sh does not source lib/backup.sh"
grep -q 'install_restic_backup' "$SETUP" && pass "setup.sh calls install_restic_backup" || fail "setup.sh never calls install_restic_backup"

# =============================================================================
# Drill sandbox-readiness race (WARP-254 fix-forward) — static, no Docker.
#
# The postgres docker-entrypoint's FIRST boot runs a temporary init server
# that listens ONLY on the unix socket (listen_addresses=''), creates
# POSTGRES_DB mid-phase, stops it, then starts the real server. A unix-socket
# `docker exec pg_isready` therefore reports ready during that temp phase, and
# a replay launched in the window dies mid-boot ("database droplet does not
# exist" / "the database system is shutting down" / connection refused in the
# restart gap) — false-failing the drill with "backup is NOT restorable".
# The temp init server never binds TCP, so -h 127.0.0.1 is the gate: these
# asserts pin the TCP flag on the readiness poll AND on every psql, the
# 2-consecutive-successes requirement, and the stderr capture that stops the
# real psql error from being discarded again.
# =============================================================================
echo ""
echo "--- Drill sandbox-readiness race (WARP-254 fix-forward) ---"

if [ -f "$DRILL_SCRIPT" ]; then
  drill_code="$(grep -vE '^[[:space:]]*#' "$DRILL_SCRIPT")"

  # Readiness poll must be TCP-gated — removing -h 127.0.0.1 reopens the race.
  printf '%s\n' "$drill_code" | grep -qE 'pg_isready[[:space:]]+-h[[:space:]]+127\.0\.0\.1' \
    && pass "drill readiness poll is TCP-gated (pg_isready -h 127.0.0.1)" \
    || fail "drill readiness poll is not TCP-gated (socket pg_isready passes during the temp init server)"

  # ...and no socket-only pg_isready may remain anywhere in the drill.
  if printf '%s\n' "$drill_code" | grep 'pg_isready' | grep -vqE '\-h[[:space:]]+127\.0\.0\.1'; then
    fail "drill still has a socket-only pg_isready (passes during the temp init phase)"
  else
    pass "no socket-only pg_isready left in the drill"
  fi

  # Belt-and-braces: readiness requires 2 consecutive successful polls.
  grep -qE '\[ "\$consecutive" -ge 2 \]' "$DRILL_SCRIPT" \
    && pass "drill readiness requires 2 consecutive successful polls" \
    || fail "drill readiness accepts a single successful poll"

  # EVERY drill psql (replay + smoke queries) must go over TCP too.
  drill_psql_total="$(printf '%s\n' "$drill_code" | grep -cE '(^|[[:space:]])psql ' || true)"
  drill_psql_tcp="$(printf '%s\n' "$drill_code" | grep -cE '(^|[[:space:]])psql [^|]*-h 127\.0\.0\.1' || true)"
  if [ "$drill_psql_total" -gt 0 ] && [ "$drill_psql_total" = "$drill_psql_tcp" ]; then
    pass "every drill psql connects over TCP ($drill_psql_tcp/$drill_psql_total)"
  else
    fail "drill psql without -h 127.0.0.1 ($drill_psql_tcp/$drill_psql_total TCP)"
  fi

  # Replay stderr must be captured and surfaced on failure — the readiness
  # race was misdiagnosed for a day because psql's error was discarded.
  grep -qF '2>"$REPLAY_ERR"' "$DRILL_SCRIPT" \
    && pass "drill captures replay stderr to a file" \
    || fail "drill discards replay stderr"
  grep -qF 'cat "$REPLAY_ERR" >&2' "$DRILL_SCRIPT" \
    && pass "drill prints captured replay stderr on failure" \
    || fail "drill never surfaces the captured replay stderr"
else
  skip "drill script missing — readiness-race checks"
fi

# =============================================================================
# Derivation known-answer test — no Docker needed, only bash + openssl.
# =============================================================================
echo ""
echo "--- Password derivation (HKDF-SHA256 stability contract) ---"

KAT_KEY="kat-device-secret-key-DO-NOT-CHANGE"
if [ -f "$LIB_SCRIPT" ]; then
  derived="$(
    # shellcheck disable=SC1090
    DEVICE_SECRET_KEY="$KAT_KEY" bash -c "source '$LIB_SCRIPT' && droplet_backup_derive_password" 2>/dev/null || true
  )"
  if [ -z "$derived" ]; then
    fail "droplet_backup_derive_password produced no output"
  else
    # 32-byte OKM → 64 lowercase hex chars.
    if printf '%s' "$derived" | grep -qE '^[0-9a-f]{64}$'; then
      pass "derived password is 64 lowercase hex chars"
    else
      fail "derived password malformed: '$derived'"
    fi

    # Deterministic across invocations.
    derived2="$(DEVICE_SECRET_KEY="$KAT_KEY" bash -c "source '$LIB_SCRIPT' && droplet_backup_derive_password" 2>/dev/null || true)"
    [ "$derived" = "$derived2" ] && pass "derivation is deterministic" || fail "derivation not deterministic"

    # Different key → different password.
    derived_other="$(DEVICE_SECRET_KEY="another-key" bash -c "source '$LIB_SCRIPT' && droplet_backup_derive_password" 2>/dev/null || true)"
    [ "$derived" != "$derived_other" ] && pass "distinct keys derive distinct passwords" || fail "distinct keys collided"

    # Known-answer test computed INDEPENDENTLY (python3 hmac). Pins the exact
    # HKDF-SHA256 construction: salt="droplet-restic-v1",
    # info="droplet-restic-repository-password", L=32.
    if command -v python3 >/dev/null 2>&1; then
      expected="$(python3 - "$KAT_KEY" <<'PYEOF'
import hmac, hashlib, sys
ikm = sys.argv[1].encode()
salt = b"droplet-restic-v1"
info = b"droplet-restic-repository-password"
prk = hmac.new(salt, ikm, hashlib.sha256).digest()
okm = hmac.new(prk, info + b"\x01", hashlib.sha256).hexdigest()
print(okm)
PYEOF
)"
      if [ "$derived" = "$expected" ]; then
        pass "known-answer test matches independent python3 HKDF"
      else
        fail "KAT mismatch (bash=$derived python=$expected) — derivation drift bricks every existing repo"
      fi
    else
      skip "python3 unavailable — independent KAT"
    fi

    # Empty key must be refused (never derive from an empty secret).
    if DEVICE_SECRET_KEY="" bash -c "source '$LIB_SCRIPT' && droplet_backup_derive_password" >/dev/null 2>&1; then
      fail "derivation accepted an EMPTY DEVICE_SECRET_KEY"
    else
      pass "derivation refuses an empty DEVICE_SECRET_KEY"
    fi
  fi
else
  skip "lib missing — derivation checks"
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
name: $PROJECT
services:
  db:
    image: ${DRILL_PG_IMAGE:-postgres:16-alpine}
    environment:
      POSTGRES_USER: droplet
      POSTGRES_DB: droplet
      POSTGRES_PASSWORD: disposable
    volumes:
      - nextcloud-data:/var/www/html
      - nvrdata:/data/nvr
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U droplet"]
      interval: 2s
      timeout: 3s
      retries: 40
volumes:
  nextcloud-data:
  nvrdata:
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

db_count() { dc exec -T db sh -c 'psql -U droplet -d droplet -tAc "SELECT count(*) FROM t WHERE id=42;"' 2>/dev/null | tr -d '[:space:]'; }
nc_marker() { dc exec -T db sh -c '[ -f /var/www/html/marker.txt ] && echo yes || echo no' 2>/dev/null | tr -d '[:space:]'; }

if ! command -v docker >/dev/null 2>&1 || ! have_docker; then
  skip "Docker not available — live drill skipped (static checks ran)"
elif ! command -v restic >/dev/null 2>&1; then
  skip "restic not on PATH — live drill skipped (static checks ran)"
elif [ ! -f "$BACKUP_SCRIPT" ]; then
  skip "backup script missing — live drill skipped"
else
  WORK_ROOT="$(mktemp -d -t resticdrill-XXXXXXXX)"
  DISPOSABLE_COMPOSE="$WORK_ROOT/compose.yml"
  FAUX_ROOT="$WORK_ROOT/faux-root"
  REPO_TARGET="$WORK_ROOT/restic-repo"
  STATE_DIR="$WORK_ROOT/state"
  RUNTIME_DIR="$WORK_ROOT/runtime"
  DRILL_KEY="drill-device-secret-key"
  trap cleanup EXIT

  # Faux checkout root: .env with the device identity secret + a config dir
  # with a marker, so the .env + config-dir surfaces are genuinely exercised.
  mkdir -p "$FAUX_ROOT/docker/certs" "$STATE_DIR" "$RUNTIME_DIR"
  printf 'DEVICE_SECRET_KEY=%s\nOTHER=1\n' "$DRILL_KEY" > "$FAUX_ROOT/.env"
  printf 'CERT-MARKER\n' > "$FAUX_ROOT/docker/certs/marker.crt"

  make_disposable_compose
  info "bringing up disposable project $PROJECT"
  dc up -d >/dev/null 2>&1 || true

  run_backup() {
    # $@ = extra args to droplet-backup.sh
    DROPLET_REPO_ROOT="$FAUX_ROOT" \
    PROJECT="$PROJECT" COMPOSE_FILE="$DISPOSABLE_COMPOSE" \
    DB_SERVICE=db DB_USER=droplet DB_NAME=droplet \
    DROPLET_BACKUP_TARGET="$REPO_TARGET" \
    DROPLET_BACKUP_STATE_DIR="$STATE_DIR" \
    DROPLET_BACKUP_RUNTIME_DIR="$RUNTIME_DIR" \
      bash "$BACKUP_SCRIPT" "$@"
  }

  if ! wait_healthy db; then
    fail "disposable Postgres did not become healthy"
  else
    dc exec -T db sh -c 'psql -U droplet -d droplet -c "CREATE TABLE IF NOT EXISTS t(id int); INSERT INTO t VALUES (42);"' >/dev/null
    dc exec -T db sh -c 'echo NEXTCLOUD-MARKER > /var/www/html/marker.txt; echo NVR-FOOTAGE > /data/nvr/footage.bin'
    pass "seeded the DB + volume markers"

    # --- Backup #1 (daily) --------------------------------------------------
    info "running droplet-backup.sh (daily)"
    if run_backup >/dev/null 2>&1; then
      pass "droplet-backup.sh exited 0"
    else
      fail "droplet-backup.sh failed"
    fi

    [ -f "$REPO_TARGET/config" ] && pass "restic repository initialized at DROPLET_BACKUP_TARGET" \
      || fail "no restic repository at $REPO_TARGET"

    # The repo password must be EXACTLY the derived one — open the repo with
    # an independently-derived password.
    DERIVED_PW="$(DEVICE_SECRET_KEY="$DRILL_KEY" bash -c "source '$LIB_SCRIPT' && droplet_backup_derive_password" 2>/dev/null || true)"
    snapshots_json="$(RESTIC_PASSWORD="$DERIVED_PW" restic -r "$REPO_TARGET" snapshots --json 2>/dev/null || true)"
    if [ -n "$snapshots_json" ] && [ "$snapshots_json" != "null" ]; then
      pass "repository opens with the DEVICE_SECRET_KEY-derived password"
    else
      fail "repository does NOT open with the derived password"
    fi
    printf '%s' "$snapshots_json" | grep -q '"daily"' \
      && pass "snapshot #1 tagged daily" || fail "snapshot #1 missing daily tag"

    # Camera footage excluded by default.
    latest_files="$(RESTIC_PASSWORD="$DERIVED_PW" restic -r "$REPO_TARGET" ls latest 2>/dev/null || true)"
    printf '%s\n' "$latest_files" | grep -q 'nextcloud-data' \
      && pass "nextcloud-data captured in snapshot" || fail "nextcloud-data missing from snapshot"
    printf '%s\n' "$latest_files" | grep -q '\.env' \
      && pass ".env captured in snapshot" || fail ".env missing from snapshot"
    printf '%s\n' "$latest_files" | grep -q 'marker.crt' \
      && pass "config dir captured in snapshot" || fail "config dir missing from snapshot"
    if printf '%s\n' "$latest_files" | grep -q 'nvrdata'; then
      fail "camera footage (nvrdata) captured WITHOUT opt-in"
    else
      pass "camera footage excluded by default"
    fi

    # --- Backup #2 (incremental) + camera opt-in ----------------------------
    info "running droplet-backup.sh again (incremental + camera opt-in)"
    if DROPLET_BACKUP_INCLUDE_CAMERA=1 run_backup >/dev/null 2>&1; then
      pass "second (incremental) backup exited 0"
    else
      fail "second backup failed"
    fi
    snap_count="$(RESTIC_PASSWORD="$DERIVED_PW" restic -r "$REPO_TARGET" snapshots --json 2>/dev/null \
      | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
    [ "$snap_count" -ge 2 ] && pass "repository holds >= 2 snapshots (incremental chain)" \
      || fail "expected >= 2 snapshots, got $snap_count"
    RESTIC_PASSWORD="$DERIVED_PW" restic -r "$REPO_TARGET" ls latest 2>/dev/null | grep -q 'nvrdata' \
      && pass "camera footage captured WITH opt-in" || fail "camera opt-in did not capture nvrdata"

    # --- Backup #3 (weekly full) ---------------------------------------------
    info "running droplet-backup.sh --full"
    if run_backup --full >/dev/null 2>&1; then
      pass "droplet-backup.sh --full exited 0"
    else
      fail "droplet-backup.sh --full failed"
    fi
    RESTIC_PASSWORD="$DERIVED_PW" restic -r "$REPO_TARGET" snapshots 2>/dev/null | grep -q 'weekly-full' \
      && pass "full snapshot tagged weekly-full" || fail "no weekly-full tagged snapshot"

    # --- Mutate --------------------------------------------------------------
    dc exec -T db sh -c 'psql -U droplet -d droplet -c "DELETE FROM t;"' >/dev/null 2>&1
    dc exec -T db sh -c 'rm -f /var/www/html/marker.txt' >/dev/null 2>&1
    [ "$(db_count)" = "0" ] && pass "data mutated (rows dropped)" || fail "mutation did not take"

    # --- Restore --------------------------------------------------------------
    info "running droplet-restore.sh --force"
    if DROPLET_REPO_ROOT="$FAUX_ROOT" \
       PROJECT="$PROJECT" COMPOSE_FILE="$DISPOSABLE_COMPOSE" \
       DB_SERVICE=db DB_USER=droplet DB_NAME=droplet \
       DROPLET_BACKUP_TARGET="$REPO_TARGET" \
       DROPLET_BACKUP_STATE_DIR="$STATE_DIR" \
       DROPLET_BACKUP_RUNTIME_DIR="$RUNTIME_DIR" \
       SKIP_SERVICE_RESTART=1 \
       bash "$RESTORE_SCRIPT" --force >/dev/null 2>&1; then
      pass "droplet-restore.sh exited 0"
    else
      fail "droplet-restore.sh failed"
    fi
    [ "$(db_count)" = "1" ] && pass "db row restored" || fail "db row NOT restored (count=$(db_count))"
    [ "$(nc_marker)" = "yes" ] && pass "nextcloud-data volume restored" || fail "nextcloud-data NOT restored"
    # Config surfaces land in a staging dir for the operator, never applied live.
    if ls "$STATE_DIR"/restored-config-*/.env >/dev/null 2>&1; then
      pass "restore staged .env + config for operator review"
    else
      fail "restore did not stage config for operator review"
    fi

    # --- Restore drill: pass path --------------------------------------------
    # The sandbox image is pinned to the disposable project's own postgres so
    # the drill never pulls the (bigger) production pgvector image in CI. On a
    # real box the default (pgvector/pgvector:pg16 — the stack's own db image,
    # already present) applies instead.
    # Drill output goes to a capture file, NOT /dev/null: when the drill
    # fails, the psql/replay stderr is the diagnosis — swallowing it left
    # the WARP-254 readiness race misdiagnosed for a day. Success stays quiet.
    info "running droplet-restore-drill.sh"
    DRILL_LOG="$WORK_ROOT/drill-output.log"
    if DROPLET_REPO_ROOT="$FAUX_ROOT" \
       DROPLET_BACKUP_TARGET="$REPO_TARGET" \
       DROPLET_BACKUP_STATE_DIR="$STATE_DIR" \
       DROPLET_BACKUP_RUNTIME_DIR="$RUNTIME_DIR" \
       DROPLET_DRILL_PG_IMAGE="${DRILL_PG_IMAGE:-postgres:16-alpine}" \
       DROPLET_DRILL_READ_DATA_SUBSET=100% \
       bash "$DRILL_SCRIPT" >"$DRILL_LOG" 2>&1; then
      pass "droplet-restore-drill.sh exited 0"
    else
      fail "droplet-restore-drill.sh failed"
      info "drill output (tail) follows:"
      tail -n 40 "$DRILL_LOG" 2>/dev/null | sed 's/^/      /'
    fi
    STATUS_FILE="$STATE_DIR/restore-drill-status.json"
    if [ -f "$STATUS_FILE" ]; then
      pass "drill wrote status file"
      grep -q '"status": *"ok"' "$STATUS_FILE" && pass "drill status is ok" || fail "drill status not ok: $(cat "$STATUS_FILE")"
      grep -q '"completed_at"' "$STATUS_FILE" && pass "drill status carries a timestamp" || fail "drill status missing timestamp"
    else
      fail "drill status file missing at $STATUS_FILE"
    fi

    # --- Restore drill: failure path (wrong key) ------------------------------
    info "running drill with the WRONG derivation key (must fail loudly)"
    DRILL_FAIL_LOG="$WORK_ROOT/drill-wrong-key-output.log"
    if DROPLET_REPO_ROOT="$FAUX_ROOT" \
       DEVICE_SECRET_KEY="the-wrong-key" \
       DROPLET_BACKUP_TARGET="$REPO_TARGET" \
       DROPLET_BACKUP_STATE_DIR="$STATE_DIR" \
       DROPLET_BACKUP_RUNTIME_DIR="$RUNTIME_DIR" \
       DROPLET_DRILL_PG_IMAGE="${DRILL_PG_IMAGE:-postgres:16-alpine}" \
       bash "$DRILL_SCRIPT" >"$DRILL_FAIL_LOG" 2>&1; then
      fail "drill with wrong key exited 0 (must fail)"
      info "drill output (tail) follows:"
      tail -n 40 "$DRILL_FAIL_LOG" 2>/dev/null | sed 's/^/      /'
    else
      pass "drill with wrong key exited non-zero"
    fi
    grep -q '"status": *"failed"' "$STATUS_FILE" \
      && pass "drill failure recorded status=failed" \
      || fail "drill failure did not record status=failed: $(cat "$STATUS_FILE" 2>/dev/null)"
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
