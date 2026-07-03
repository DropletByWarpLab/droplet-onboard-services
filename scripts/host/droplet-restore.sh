#!/usr/bin/env bash
# =============================================================================
# WARP-254 — restore from the restic repository into the live stack
# =============================================================================
#
# Restores a droplet-backup.sh snapshot: the orchestrator Postgres + the
# Nextcloud data volume are restored LIVE; the .env + config-dir surfaces are
# staged to an operator directory (never applied in place — overwriting the
# .env under a running stack desyncs every container mid-restore; the operator
# applies it deliberately, then runs `./scripts/setup.sh --sync-secrets`).
#
# Usage:
#   ./scripts/host/droplet-restore.sh [--force] [--snapshot ID] [--list]
#
#   --list          print the repository's snapshots and exit
#   --snapshot ID   restore a specific snapshot (default: latest)
#   --force         skip the interactive confirmation
#
# Steps:
#   1. Derive the repository password from the device identity secret
#      (droplet-backup-lib.sh — same derivation as backup).
#   2. `restic check` — INTEGRITY IS VERIFIED ON EVERY RESTORE, before any
#      destructive step, so a corrupt repository can never destroy the live
#      copy (the WARP-570 "never after DROP DATABASE" rule).
#   3. `restic restore` the snapshot to a scratch dir + gzip -t the dump.
#   4. Confirmation gate (unless --force).
#   5. Drop + recreate the orchestrator DB, replay the dump.
#   6. Wipe + untar the Nextcloud data volume.
#   7. Stage .env/config copies to $STATE_DIR/restored-config-<ts>/ (0700).
#   8. Restart affected services (skip with SKIP_SERVICE_RESTART=1).
#
# DESTRUCTIVE — overwrites the live DB and the Nextcloud data volume.
#
# Env overrides: DROPLET_REPO_ROOT, DROPLET_BACKUP_TARGET,
#   DROPLET_BACKUP_STATE_DIR, DROPLET_BACKUP_RUNTIME_DIR,
#   PROJECT / COMPOSE_FILE / DB_SERVICE / DB_USER / DB_NAME,
#   SKIP_SERVICE_RESTART=1 (drill harness).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=droplet-backup-lib.sh
source "$SCRIPT_DIR/droplet-backup-lib.sh"

FORCE=0
SNAPSHOT="latest"
LIST_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--force) FORCE=1; shift ;;
    --snapshot) SNAPSHOT="${2:?--snapshot requires an ID}"; shift 2 ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) log_error "unknown argument: $1 (see --help)"; exit 64 ;;
  esac
done

REPO_ROOT="$(droplet_backup_resolve_repo_root)"
if [ -f "$REPO_ROOT/scripts/lib/logging.sh" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/lib/logging.sh"
fi

COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker/docker-compose.yml}"
if [ -z "${PROJECT:-}" ]; then
  PROJECT="$(grep -E '^name:[[:space:]]' "$COMPOSE_FILE" 2>/dev/null | head -1 | awk '{gsub(/["\x27]/,"",$2); print $2}' || true)"
fi
PROJECT="${PROJECT:-droplet}"
DB_SERVICE="${DB_SERVICE:-db}"
STATE_DIR="${DROPLET_BACKUP_STATE_DIR:-/var/lib/droplet/backup}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

if ! command -v restic >/dev/null 2>&1; then
  log_error "restic not on PATH"
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  log_error "docker not on PATH; droplet-restore requires the compose stack"
  exit 2
fi

droplet_backup_prepare_restic_env

if [ "$LIST_ONLY" = "1" ]; then
  restic snapshots
  exit 0
fi

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# --- Integrity gate (BEFORE any destructive step) ---------------------------
log_info "Verifying repository integrity (restic check)..."
if ! restic check; then
  log_error "restic check FAILED — refusing to restore from a repository that fails integrity"
  exit 1
fi
log_success "Repository integrity verified."

# --- Restore the snapshot to scratch ----------------------------------------
WORK_DIR="$(mktemp -d -t droplet-restore-XXXXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log_info "Restoring snapshot '$SNAPSHOT' to scratch..."
restic restore "$SNAPSHOT" --target "$WORK_DIR"

# Locate the staged dump inside the restored tree (the snapshot mirrors
# absolute paths, and the staging root is configurable — find, don't guess).
DUMP="$(find "$WORK_DIR" -type f -name 'droplet.sql.gz' -path '*postgres*' 2>/dev/null | head -1 || true)"
if [ -z "$DUMP" ]; then
  log_error "no Postgres dump (postgres/droplet.sql.gz) in snapshot '$SNAPSHOT'"
  exit 1
fi
if ! gzip -t "$DUMP" 2>/dev/null; then
  log_error "restored Postgres dump fails gzip integrity — refusing to restore"
  exit 1
fi
log_success "Snapshot restored to scratch; dump passes gzip check."

# --- Confirmation ------------------------------------------------------------
if [ "$FORCE" -ne 1 ]; then
  read -r -p "This OVERWRITES the live DB + Nextcloud data volume. Continue? [y/N] " ans
  case "$ans" in
    [yY]|[yY][eE][sS]) ;;
    *) log_info "Aborted."; exit 0 ;;
  esac
fi

# --- Restore Postgres ----------------------------------------------------------
log_info "Restoring Postgres service '$DB_SERVICE'..."
# Drop+recreate from the maintenance DB so partial prior state never lingers;
# WITH (FORCE) terminates open connections. Same override plumbing as backup.
dc exec -T -e "DROPLET_DUMP_USER=${DB_USER:-}" -e "DROPLET_DUMP_DB=${DB_NAME:-}" "$DB_SERVICE" sh -c '
  U="${DROPLET_DUMP_USER:-$POSTGRES_USER}"
  D="${DROPLET_DUMP_DB:-$POSTGRES_DB}"
  psql --username="$U" --dbname=postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$D\" WITH (FORCE);" \
    -c "CREATE DATABASE \"$D\";"'

# ON_ERROR_STOP=1 aborts the replay on the FIRST SQL error. Without it psql
# swallows a mid-replay failure and exits 0, so after the DROP/CREATE above a
# partially-failed replay would still be reported as "Postgres restored." — a
# corrupt restore that reports success. Safe to enforce: the replay user is the
# container superuser and the dump is --no-owner --no-privileges, so a healthy
# replay has no benign expected errors. (The drill already enforces this.)
gunzip -c "$DUMP" \
  | dc exec -T -e "DROPLET_DUMP_USER=${DB_USER:-}" -e "DROPLET_DUMP_DB=${DB_NAME:-}" "$DB_SERVICE" sh -c '
      psql --username="${DROPLET_DUMP_USER:-$POSTGRES_USER}" --dbname="${DROPLET_DUMP_DB:-$POSTGRES_DB}" -v ON_ERROR_STOP=1'
log_success "Postgres restored."

# --- Restore data volumes -------------------------------------------------------
# Every volumes/<name>.tar staged by droplet-backup.sh is replayed. The tar is
# streamed on stdin so no bind mount is needed (works on CI + Docker Desktop).
VOLUME_TARS="$(find "$WORK_DIR" -type f -path '*volumes/*.tar' 2>/dev/null || true)"
if [ -n "$VOLUME_TARS" ]; then
  while IFS= read -r tarfile; do
    vol="$(basename "$tarfile" .tar)"
    full="${PROJECT}_${vol}"
    log_info "Restoring volume '$full'..."
    docker run -i --rm -v "$full:/data" alpine:3.20 \
      sh -c 'rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar -xf - -C /data' < "$tarfile"
    log_success "volume '$vol' restored."
  done <<< "$VOLUME_TARS"
else
  log_warn "no volume artifacts in snapshot — volumes left untouched"
fi

# --- Stage .env + config for the operator ----------------------------------------
# Deliberately NOT applied live (see header). The restored .env surfaces at the
# TOP of the operator directory; the full snapshot tree (minus the staging
# subtree — the dump + volume tars already consumed above) is mirrored under
# tree/ with its original absolute layout.
RESTORED_CONFIG="$STATE_DIR/restored-config-$TS"
mkdir -p "$RESTORED_CONFIG/tree"
chmod 700 "$RESTORED_CONFIG"
RESTORED_ENV="$(find "$WORK_DIR" -type f -name '.env' -not -path '*/staging/*' 2>/dev/null | head -1 || true)"
if [ -n "$RESTORED_ENV" ]; then
  cp "$RESTORED_ENV" "$RESTORED_CONFIG/.env"
  chmod 600 "$RESTORED_CONFIG/.env"
else
  log_warn "snapshot carried no .env — device secrets not part of this restore"
fi
tar -cf - -C "$WORK_DIR" --exclude='*/staging' . | tar -xf - -C "$RESTORED_CONFIG/tree"
log_success "Config surfaces staged (NOT applied): $RESTORED_CONFIG"
log_info "  Review + copy .env / cert / secret files back deliberately, then:"
log_info "    ./scripts/setup.sh --sync-secrets"

# --- Restart affected services -----------------------------------------------------
if [ "${SKIP_SERVICE_RESTART:-0}" != "1" ]; then
  log_info "Restarting affected services..."
  for svc in "$DB_SERVICE" orchestrator nextcloud; do
    if dc ps --services 2>/dev/null | grep -qx "$svc"; then
      dc restart "$svc" >/dev/null 2>&1 || true
    fi
  done
fi

log_success "Restore complete (snapshot: $SNAPSHOT)."
