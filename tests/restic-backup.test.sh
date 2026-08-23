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

# WARP-1571 / WARP-1575 — readiness probe for THIS suite's disposable drill
# Postgres. The WARP-254 section below asserts the drill SCRIPT is TCP-gated;
# this suite's own throwaway stack had the same socket probe it lectures the
# drill about. Must stay TCP-gated for the same reason.
PG_HEALTHCHECK_CMD='pg_isready -h 127.0.0.1 -U droplet'

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
  # WARP-1013: the db container hosts BOTH databases. Dumping only droplet
  # while tarring the nextcloud-data blobs means a restore pairs fresh files
  # with a stale metadata DB (file cache / shares / users skew — missing or
  # ghost files after recovery). The nextcloud DB must be dumped too.
  grep -q 'nextcloud\.sql\.gz' "$BACKUP_SCRIPT" \
    && pass "backup stages the nextcloud DB dump (nextcloud.sql.gz)" \
    || fail "backup never dumps the nextcloud DB (WARP-1013)"
  # ...and a missing nextcloud DB must be an explicit existence-guarded skip
  # (legacy pgdata predating init-nextcloud-db.sh), mirroring stage_volume.
  grep -q 'pg_database' "$BACKUP_SCRIPT" \
    && pass "backup existence-guards the nextcloud DB (pg_database probe)" \
    || fail "backup has no existence guard for the nextcloud DB"
  # Camera footage EXCLUDED by default, opt-in via flag (size rationale).
  grep -q 'DROPLET_BACKUP_INCLUDE_CAMERA' "$BACKUP_SCRIPT" \
    && pass "camera footage behind DROPLET_BACKUP_INCLUDE_CAMERA opt-in" \
    || fail "backup has no camera opt-in flag"
  grep -q 'nvrdata' "$BACKUP_SCRIPT" \
    && pass "backup knows the nvrdata (camera) volume" || fail "backup does not reference nvrdata"
  # WARP-2136: footage lives in the nvrdata VOLUME or at an NVR_MEDIA_SOURCE
  # host path, and `stage_volume` can only reach the volume. A redirected box
  # used to honour the opt-in and capture nothing.
  grep -q 'droplet_backup_nvr_media_bind_path' "$BACKUP_SCRIPT" \
    && pass "backup resolves the NVR_MEDIA_SOURCE bind path (WARP-2136)" \
    || fail "backup only knows the nvrdata volume — redirected footage is silently skipped"
  # The bind path must reach restic DIRECTLY. Routing hundreds of GB through
  # the staging tar would double the nightly disk churn for bytes restic
  # already dedups.
  grep -q 'BACKUP_PATHS+=("$CAMERA_BIND_PATH")' "$BACKUP_SCRIPT" \
    && pass "bind-mounted footage is added to the restic path set directly" \
    || fail "bind-mounted footage never reaches the restic path set"
  # A configured-but-absent path must be loud, not silent: the operator has
  # opted in and would otherwise believe footage was captured.
  grep -q 'does not exist — camera footage NOT captured' "$BACKUP_SCRIPT" \
    && pass "an unmounted recordings path warns instead of passing silently" \
    || fail "a missing NVR_MEDIA_SOURCE path is swallowed"

  # --- Behavioural: the resolver itself (WARP-2136) --------------------------
  # A grep proves the wiring exists; this proves it DISCRIMINATES. The whole
  # fix turns on one question — volume name or host path — and getting it
  # wrong in either direction is a silent data-loss bug: a volume name treated
  # as a path backs up nothing, and a relative value treated as a bind archives
  # the wrong tree (compose resolves it against the compose dir, not our cwd).
  _nvr_sandbox="$(mktemp -d)"
  mkdir -p "$_nvr_sandbox/docker"
  : > "$_nvr_sandbox/docker/docker-compose.yml"
  # value -> expected resolver output
  _nvr_cases=(
    "|"
    "nvrdata|"
    "relative/path|"
    "/mnt/cameras|/mnt/cameras"
    "/mnt/droplet/mass-storage-cadf51ee/cameras|/mnt/droplet/mass-storage-cadf51ee/cameras"
    '"/mnt/cameras"|/mnt/cameras'
  )
  _nvr_resolver_ok=1
  for _case in "${_nvr_cases[@]}"; do
    _in="${_case%%|*}"; _want="${_case#*|}"
    printf 'NVR_MEDIA_SOURCE=%s\n' "$_in" > "$_nvr_sandbox/.env"
    _got="$(DROPLET_REPO_ROOT="$_nvr_sandbox" bash -c \
      'source "$1"; droplet_backup_nvr_media_bind_path' _ "$LIB_SCRIPT" 2>/dev/null || true)"
    if [ "$_got" != "$_want" ]; then
      _nvr_resolver_ok=0
      info "NVR_MEDIA_SOURCE=[$_in] resolved to [$_got], expected [$_want]"
    fi
  done
  rm -rf "$_nvr_sandbox"
  [ "$_nvr_resolver_ok" -eq 1 ] \
    && pass "bind-path resolver: absolute=bind, volume-name/relative/empty=volume" \
    || fail "the NVR_MEDIA_SOURCE resolver misclassifies a value (WARP-2136)"
  # Retention policy: 7 daily / 4 weekly / 6 monthly.
  grep -q -- '--keep-daily' "$BACKUP_SCRIPT" && grep -q -- '--keep-weekly' "$BACKUP_SCRIPT" \
    && grep -q -- '--keep-monthly' "$BACKUP_SCRIPT" \
    && pass "backup applies a restic forget retention policy" \
    || fail "backup has no restic forget retention policy"
  # Retention must be pinned with --group-by host: restic's default (host,paths)
  # grouping splits snapshots into a NEW retention group whenever the backup path
  # set changes (config candidates are existence-guarded, .env is conditional),
  # so stale groups keep their last daily/weekly/monthly snapshots forever.
  grep -q -- '--group-by' "$BACKUP_SCRIPT" \
    && pass "retention pins --group-by (stable across path-set drift)" \
    || fail "restic forget relies on the default host,paths grouping"
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
  # EVERY psql invocation in the restore path must abort on the first SQL error
  # (ON_ERROR_STOP=1). Without it psql swallows a mid-replay failure and exits 0,
  # so after DROP DATABASE a partially-failed replay is reported as
  # "Restore complete." — a corrupt restore that looks successful.
  psql_total="$(printf '%s\n' "$restore_code" | grep -cE '(^|[[:space:]])psql ' || true)"
  psql_stop="$(printf '%s\n' "$restore_code" | grep -cE '(^|[[:space:]])psql [^|]*ON_ERROR_STOP=1' || true)"
  if [ "$psql_total" -gt 0 ] && [ "$psql_total" = "$psql_stop" ]; then
    pass "every restore psql sets ON_ERROR_STOP=1 ($psql_stop/$psql_total)"
  else
    fail "restore psql without ON_ERROR_STOP=1 ($psql_stop/$psql_total set)"
  fi
  # WARP-1013: the restore must replay the nextcloud DB dump when the
  # snapshot carries one (same-snapshot pairing with the nextcloud-data tar).
  grep -q 'nextcloud\.sql\.gz' "$RESTORE_SCRIPT" \
    && pass "restore replays the nextcloud DB dump when present" \
    || fail "restore never replays the nextcloud DB (WARP-1013)"

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
  # The status file is machine-parsed (dashboard/health follow-up). The free-text
  # message and the repository path flow into JSON string values, so they must be
  # escaped or a " / \ in either would corrupt the file (JSON injection).
  grep -qE '_json_escape|json_escape' "$DRILL_SCRIPT" \
    && pass "drill status file escapes interpolated strings (JSON-safe)" \
    || fail "drill status file interpolates raw strings into JSON (injection risk)"
  # WARP-1013: the drill must prove the nextcloud DB dump replays too, and
  # record it explicitly (table count + a files-metadata sanity row).
  grep -q 'nextcloud\.sql\.gz' "$DRILL_SCRIPT" \
    && pass "drill replays the nextcloud DB dump" \
    || fail "drill ignores the nextcloud DB (WARP-1013)"
  grep -q '"nextcloud_tables"' "$DRILL_SCRIPT" \
    && pass "drill status records nextcloud_tables" \
    || fail "drill status has no nextcloud_tables field"
  grep -q '"filecache_rows"' "$DRILL_SCRIPT" \
    && pass "drill status records the oc_filecache sanity count" \
    || fail "drill status has no filecache_rows field"
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

# This suite's OWN disposable stack had the exact socket probe the asserts
# above forbid in the drill — same initdb temp-server false-positive, same
# cold-volume flake, just one layer out (WARP-1571 / WARP-1575, found while
# fixing the identical bug in tests/device-backup.test.sh).
printf '%s\n' "$PG_HEALTHCHECK_CMD" | grep -qE 'pg_isready[[:space:]]+.*-h[[:space:]]+127\.0\.0\.1' \
  && pass "suite's disposable Postgres healthcheck is TCP-gated (pg_isready -h 127.0.0.1)" \
  || fail "suite's disposable Postgres healthcheck is not TCP-gated (socket pg_isready reports healthy during the initdb temp server)"

suite_probe_lines="$(sed -n '/^make_disposable_compose()/,/^}/p' "${BASH_SOURCE[0]}" | grep -c 'pg_isready' || true)"
if [ "$suite_probe_lines" -eq 0 ]; then
  pass "suite's disposable compose has no inline pg_isready (uses \$PG_HEALTHCHECK_CMD)"
else
  fail "suite's disposable compose inlines pg_isready ($suite_probe_lines occurrence(s)) instead of using \$PG_HEALTHCHECK_CMD"
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
# Repository init-vs-use branching (WARP-2059) — bash only, stubbed restic.
#
# Regression. On a box whose DEVICE_SECRET_KEY was rotated (factory-reset.sh,
# then a fresh setup.sh) while /var/lib/droplet/restic-repo survived on the
# data disk a factory reset does NOT wipe, the derived password stops opening
# the repository. `restic cat config` then fails the same way it fails when
# there is no repository at all, so a two-state ensure_repo falls through to
# `restic init`, which dies with
#
#     Fatal: create repository at <repo> failed: config file already exists
#
# — a message about the init attempt rather than the fault. Every nightly
# backup failed for two days and the message sent the diagnosis the wrong way
# (read as missing init-detection, which was already implemented).
#
# These cases pin the THREE-state behavior. restic is stubbed, so they run on
# any runner — no Docker, no restic, no network.
# =============================================================================
echo ""
echo "--- Repository init-vs-use branching (WARP-2059) ---"

if [ -f "$LIB_SCRIPT" ]; then
  ENSURE_TMP="$(mktemp -d)"
  mkdir -p "$ENSURE_TMP/bin"

  # $1 = shell body for `restic cat …`; $2 = body for `restic init`.
  # Every invocation is appended to calls.log so a test can assert that init
  # was NEVER attempted — the assertion that actually matters here.
  make_restic_stub() {
    cat > "$ENSURE_TMP/bin/restic" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$ENSURE_TMP/calls.log"
case "\$1" in
  cat)  $1 ;;
  init) $2 ;;
  *)    exit 0 ;;
esac
STUB
    chmod +x "$ENSURE_TMP/bin/restic"
    : > "$ENSURE_TMP/calls.log"
  }

  # Run under `set -euo pipefail` exactly as droplet-backup.sh does, so a
  # function that returns non-zero on a success path is caught here too.
  run_ensure() {
    ( set -euo pipefail
      PATH="$ENSURE_TMP/bin:$PATH"
      export RESTIC_REPOSITORY="$ENSURE_TMP/repo"
      # shellcheck disable=SC1090
      source "$LIB_SCRIPT"
      droplet_backup_ensure_repo
    ) >"$ENSURE_TMP/out" 2>&1
  }

  init_was_attempted() { grep -qx 'init' "$ENSURE_TMP/calls.log"; }

  # --- 1. Repository present and openable → proceed, do NOT re-init ---------
  make_restic_stub 'echo "{\"version\":2}"; exit 0' 'exit 0'
  rc=0; run_ensure || rc=$?
  if [ "$rc" -eq 0 ] && ! init_was_attempted; then
    pass "existing openable repo: proceeds without calling restic init"
  else
    fail "existing openable repo: rc=$rc init_attempted=$(init_was_attempted && echo yes || echo no)"
  fi

  # --- 2. Repository absent → init (the first-run path stays intact) -------
  make_restic_stub \
    'echo "Fatal: unable to open config file: no such file or directory
Is there a repository at the following location?" >&2; exit 1' \
    'echo "created restic repository 0a1b2c3d at $RESTIC_REPOSITORY"; exit 0'
  rc=0; run_ensure || rc=$?
  if [ "$rc" -eq 0 ] && init_was_attempted; then
    pass "absent repo: initializes on first use"
  else
    fail "absent repo: rc=$rc init_attempted=$(init_was_attempted && echo yes || echo no)"
  fi
  if grep -q "created restic repository" "$ENSURE_TMP/out"; then
    pass "absent repo: restic init output is surfaced to the journal"
  else
    fail "absent repo: init output swallowed"
  fi

  # --- 3. Repository present but NOT openable (THE regression) -------------
  # Rotated device identity. Must stop immediately, never touch init, and say
  # something the on-call operator can act on.
  make_restic_stub \
    'echo "Fatal: wrong password or no key found" >&2; exit 1' \
    'echo "Fatal: create repository at $RESTIC_REPOSITORY failed: config file already exists" >&2; exit 1'
  rc=0; run_ensure || rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "key mismatch: fails non-zero (backup must not continue)"
  else
    fail "key mismatch: returned 0 — a broken backup would report success"
  fi
  if init_was_attempted; then
    fail "key mismatch: called restic init anyway — reintroduces the misleading error"
  else
    pass "key mismatch: never attempts restic init"
  fi
  if grep -qi 'config file already exists' "$ENSURE_TMP/out"; then
    fail "key mismatch: surfaced restic's misdirecting 'config file already exists'"
  else
    pass "key mismatch: does not surface the misdirecting init error"
  fi
  if grep -qi 'DEVICE_SECRET_KEY' "$ENSURE_TMP/out" &&
     grep -qi 'does not open it' "$ENSURE_TMP/out"; then
    pass "key mismatch: names the derived-password/identity cause"
  else
    fail "key mismatch: diagnostic does not explain the cause"
  fi
  if grep -q "$ENSURE_TMP/repo" "$ENSURE_TMP/out"; then
    pass "key mismatch: names the affected repository path"
  else
    fail "key mismatch: does not name the repository path"
  fi

  # --- 4. Belt and braces: probe wording we do not recognize yet ------------
  # restic reworded the "no repository" error before. If the probe error is
  # unfamiliar we still try init, but its "already exists" must be translated
  # into the same actionable diagnostic instead of the raw Fatal.
  make_restic_stub \
    'echo "Fatal: some future restic wording" >&2; exit 1' \
    'echo "Fatal: create repository at $RESTIC_REPOSITORY failed: config file already exists" >&2; exit 1'
  rc=0; run_ensure || rc=$?
  if [ "$rc" -ne 0 ] && grep -qi 'does not open it' "$ENSURE_TMP/out"; then
    pass "unrecognized probe error + 'already exists' init: same actionable diagnostic"
  else
    fail "unrecognized probe error: rc=$rc, diagnostic missing"
  fi

  # --- 5. An unrelated init failure must NOT be misreported as key mismatch -
  make_restic_stub \
    'echo "Fatal: some future restic wording" >&2; exit 1' \
    'echo "Fatal: mkdir /var/lib/droplet: permission denied" >&2; exit 3'
  rc=0; run_ensure || rc=$?
  if [ "$rc" -eq 3 ] && ! grep -qi 'does not open it' "$ENSURE_TMP/out"; then
    pass "unrelated init failure: propagates rc, not misdiagnosed as key mismatch"
  else
    fail "unrelated init failure: rc=$rc (expected 3) or misdiagnosed"
  fi

  if [ "${KEEP_ARTIFACTS:-0}" = "1" ]; then
    info "kept ensure_repo artifacts: $ENSURE_TMP"
  else
    rm -rf "$ENSURE_TMP"
  fi
else
  skip "lib missing — ensure_repo branching checks"
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
      # WARP-1571: TCP-gated on purpose — a socket probe reports healthy
      # during the initdb temp server. Never inline a socket probe here.
      test: ["CMD-SHELL", "$PG_HEALTHCHECK_CMD"]
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
nc_db_count() { dc exec -T db sh -c 'psql -U droplet -d nextcloud -tAc "SELECT count(*) FROM oc_filecache WHERE fileid=1;"' 2>/dev/null | tr -d '[:space:]'; }
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
    # Second database in the SAME container, like the live stack's
    # init-nextcloud-db.sh, with an oc_filecache-shaped sanity table (WARP-1013).
    dc exec -T db sh -c 'psql -U droplet -d droplet -tAc "SELECT 1 FROM pg_database WHERE datname='"'"'nextcloud'"'"';" | grep -q 1 || psql -U droplet -d droplet -c "CREATE DATABASE nextcloud;"' >/dev/null
    dc exec -T db sh -c 'psql -U droplet -d nextcloud -c "CREATE TABLE IF NOT EXISTS oc_filecache(fileid int); INSERT INTO oc_filecache VALUES (1);"' >/dev/null
    dc exec -T db sh -c 'echo NEXTCLOUD-MARKER > /var/www/html/marker.txt; echo NVR-FOOTAGE > /data/nvr/footage.bin'
    pass "seeded both DBs + volume markers"

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
    printf '%s\n' "$latest_files" | grep -q 'nextcloud\.sql\.gz' \
      && pass "nextcloud DB dump captured in snapshot" \
      || fail "nextcloud DB dump missing from snapshot (WARP-1013)"
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
    # Snapshot listing captured to a variable (same pattern as latest_files):
    # piping restic straight into grep -q SIGPIPEs restic on first match,
    # which can leave a stale repo lock behind for the next command.
    full_snaps="$(RESTIC_PASSWORD="$DERIVED_PW" restic -r "$REPO_TARGET" snapshots 2>&1 || true)"
    if printf '%s\n' "$full_snaps" | grep -q 'weekly-full'; then
      pass "full snapshot tagged weekly-full"
    else
      fail "no weekly-full tagged snapshot"
      printf '%s\n' "$full_snaps" | tail -n 5 | sed 's/^/      /'
    fi

    # --- Mutate --------------------------------------------------------------
    dc exec -T db sh -c 'psql -U droplet -d droplet -c "DELETE FROM t;"' >/dev/null 2>&1
    dc exec -T db sh -c 'psql -U droplet -d nextcloud -c "DELETE FROM oc_filecache;"' >/dev/null 2>&1
    dc exec -T db sh -c 'rm -f /var/www/html/marker.txt' >/dev/null 2>&1
    [ "$(db_count)" = "0" ] && pass "data mutated (rows dropped)" || fail "mutation did not take"
    [ "$(nc_db_count)" = "0" ] && pass "nextcloud DB mutated (rows dropped)" || fail "nextcloud mutation did not take"

    # --- Restore --------------------------------------------------------------
    # Restore output goes to a capture file, NOT /dev/null — same lesson as
    # the drill below: on failure the restic/psql stderr IS the diagnosis.
    info "running droplet-restore.sh --force"
    RESTORE_LOG="$WORK_ROOT/restore-output.log"
    if DROPLET_REPO_ROOT="$FAUX_ROOT" \
       PROJECT="$PROJECT" COMPOSE_FILE="$DISPOSABLE_COMPOSE" \
       DB_SERVICE=db DB_USER=droplet DB_NAME=droplet \
       DROPLET_BACKUP_TARGET="$REPO_TARGET" \
       DROPLET_BACKUP_STATE_DIR="$STATE_DIR" \
       DROPLET_BACKUP_RUNTIME_DIR="$RUNTIME_DIR" \
       SKIP_SERVICE_RESTART=1 \
       bash "$RESTORE_SCRIPT" --force >"$RESTORE_LOG" 2>&1; then
      pass "droplet-restore.sh exited 0"
    else
      fail "droplet-restore.sh failed"
      info "restore output (tail) follows:"
      tail -n 20 "$RESTORE_LOG" 2>/dev/null | sed 's/^/      /'
    fi
    [ "$(db_count)" = "1" ] && pass "db row restored" || fail "db row NOT restored (count=$(db_count))"
    [ "$(nc_db_count)" = "1" ] && pass "nextcloud DB row restored (WARP-1013 round-trip)" \
      || fail "nextcloud DB NOT restored (count=$(nc_db_count))"
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
      grep -qE '"nextcloud_tables": *[1-9]' "$STATUS_FILE" \
        && pass "drill replayed the nextcloud DB (nextcloud_tables >= 1)" \
        || fail "drill did not replay the nextcloud DB: $(cat "$STATUS_FILE")"
      grep -qE '"filecache_rows": *[0-9]' "$STATUS_FILE" \
        && pass "drill recorded the oc_filecache sanity row count" \
        || fail "drill status missing filecache_rows: $(cat "$STATUS_FILE")"
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
