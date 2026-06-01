#!/usr/bin/env bash
# =============================================================================
# WARP-570 — Full-device restore
# =============================================================================
#
# Restores a device-backup tarball produced by `device-backup.sh` into the live
# stack: BOTH Postgres instances + every captured data volume.
#
# Usage:
#   ./scripts/host/device-restore.sh [--force] <BACKUP_TARBALL>
#
# Steps:
#   1. Unpack the tarball to a scratch dir.
#   2. Validate manifest.json + presence of postgres/main.sql.gz.
#   3. Restore main Postgres: drop+recreate the DB, then psql < dump.
#   4. Restore Plane Postgres (if captured): same.
#   5. Restore each captured data volume: wipe the volume, untar into it.
#   6. Restart affected services so they pick up the restored state.
#
# DESTRUCTIVE — overwrites the live DBs and data volumes. Prompts for
# confirmation unless --force / -f is passed.
#
# Env overrides (defaults match the production compose stack; the test harness
# points these at a disposable project):
#   PROJECT, COMPOSE_FILE, DB_SERVICE, DB_USER, DB_NAME, PM_SERVICE
#   SKIP_SERVICE_RESTART=1   skip the final `compose restart` (used in tests)
#
# Engineering-handbook compliance: same rules as device-backup.sh.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROJECT="${PROJECT:-droplet-pi-platform}"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker/docker-compose.yml}"
DB_SERVICE="${DB_SERVICE:-db}"
PM_SERVICE="${PM_SERVICE:-postgres-pm}"

FORCE=0
BACKUP_TARBALL=""

# --- Arg parsing ---------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--force) FORCE=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      BACKUP_TARBALL="$1"; shift ;;
  esac
done

if [ -z "$BACKUP_TARBALL" ]; then
  echo "device-restore requires a backup tarball path" >&2
  exit 1
fi
if [ ! -f "$BACKUP_TARBALL" ]; then
  echo "backup tarball not found: $BACKUP_TARBALL" >&2
  exit 1
fi

# --- Logging -------------------------------------------------------------
if [ -f "$REPO_ROOT/scripts/lib/logging.sh" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/lib/logging.sh"
else
  log_info()    { printf "  [device-restore] %s\n" "$*"; }
  log_success() { printf "  [device-restore] OK: %s\n" "$*"; }
  log_warn()    { printf "  [device-restore] WARN: %s\n" "$*" >&2; }
  log_error()   { printf "  [device-restore] ERROR: %s\n" "$*" >&2; }
fi

if ! command -v docker >/dev/null 2>&1; then
  log_error "docker not on PATH; device-restore requires the compose stack"
  exit 2
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  log_error "compose file not found at $COMPOSE_FILE"
  exit 2
fi

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

WORK_DIR="$(mktemp -d -t device-restore-XXXXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Validate ------------------------------------------------------------
log_info "Validating backup..."
tar -xzf "$BACKUP_TARBALL" -C "$WORK_DIR"

if [ ! -f "$WORK_DIR/manifest.json" ]; then
  log_error "manifest missing — not a device-backup tarball?"
  exit 1
fi
if [ ! -f "$WORK_DIR/postgres/main.sql.gz" ]; then
  log_error "main Postgres dump missing from tarball"
  exit 1
fi

log_info "Manifest:"
cat "$WORK_DIR/manifest.json"
echo

# --- Integrity gate (BEFORE any destructive step) ------------------------
# A truncated/corrupt dump must be caught here — never after DROP DATABASE,
# which would leave an empty DB with the good copy already gone. We re-run the
# same checks device-backup.sh recorded: gzip -t every dump, and verify the
# sha256 of each artifact against the manifest when present.
log_info "Verifying backup integrity before any destructive step..."

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else echo "unavailable"; fi
}

# Read a checksum for a manifest key (relative path) without needing jq.
manifest_checksum() {
  # $1 = key like "postgres/main.sql.gz"
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[0-9a-f]*\"" "$WORK_DIR/manifest.json" 2>/dev/null \
    | grep -o '[0-9a-f]\{64\}' | head -1
}

verify_artifact() {
  # $1 = file on disk, $2 = manifest key
  local file="$1" key="$2" want got
  [ -f "$file" ] || return 0
  if [[ "$file" == *.gz ]] && ! gzip -t "$file" 2>/dev/null; then
    log_error "integrity check failed: $(basename "$file") is not a valid gzip — refusing to restore"
    exit 1
  fi
  want="$(manifest_checksum "$key")"
  if [ -n "$want" ]; then
    got="$(sha256_of "$file")"
    if [ "$got" != "unavailable" ] && [ "$got" != "$want" ]; then
      log_error "integrity check failed: $key sha256 mismatch (manifest=$want disk=$got) — refusing to restore"
      exit 1
    fi
  fi
}

verify_artifact "$WORK_DIR/postgres/main.sql.gz" "postgres/main.sql.gz"
verify_artifact "$WORK_DIR/postgres/pm.sql.gz"   "postgres/pm.sql.gz"
if [ -d "$WORK_DIR/volumes" ]; then
  for dir in "$WORK_DIR"/volumes/*/; do
    [ -d "$dir" ] || continue
    vol="$(basename "$dir")"
    verify_artifact "$dir/data.tar" "volumes/$vol/data.tar"
  done
fi
log_success "Integrity checks passed — safe to proceed."

# --- Confirmation --------------------------------------------------------
if [ "$FORCE" -ne 1 ]; then
  read -r -p "This OVERWRITES the live DBs + data volumes. Continue? [y/N] " ans
  case "$ans" in
    [yY]|[yY][eE][sS]) ;;
    *) log_info "Aborted."; exit 0 ;;
  esac
fi

# --- Restore one Postgres instance ---------------------------------------
restore_pg() {
  # $1 = service, $2 = dump.sql.gz, $3 = user override, $4 = db override
  local svc="$1" dump="$2" user="$3" db="$4"

  log_info "Restoring Postgres service '$svc'..."
  # Drop+recreate the target DB from the maintenance 'postgres' DB so a partial
  # prior state doesn't linger. WITH (FORCE) terminates open connections. The
  # overrides are passed as container env (-e) and the in-container shell falls
  # back to the container's own $POSTGRES_USER/$POSTGRES_DB when they're empty —
  # mirroring device-backup.sh's dump_pg and avoiding the fragile nested
  # `${user:-${POSTGRES_USER}}` host-side expansion that leaked a stray `}`.
  dc exec -T -e "DROPLET_DUMP_USER=$user" -e "DROPLET_DUMP_DB=$db" "$svc" sh -c '
    U="${DROPLET_DUMP_USER:-$POSTGRES_USER}"
    D="${DROPLET_DUMP_DB:-$POSTGRES_DB}"
    psql --username="$U" --dbname=postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$D\" WITH (FORCE);" \
      -c "CREATE DATABASE \"$D\";"'

  gunzip -c "$dump" \
    | dc exec -T -e "DROPLET_DUMP_USER=$user" -e "DROPLET_DUMP_DB=$db" "$svc" sh -c '
        psql --username="${DROPLET_DUMP_USER:-$POSTGRES_USER}" --dbname="${DROPLET_DUMP_DB:-$POSTGRES_DB}"'
  log_success "'$svc' restored."
}

restore_pg "$DB_SERVICE" "$WORK_DIR/postgres/main.sql.gz" "${DB_USER:-}" "${DB_NAME:-}"

if [ -f "$WORK_DIR/postgres/pm.sql.gz" ]; then
  restore_pg "$PM_SERVICE" "$WORK_DIR/postgres/pm.sql.gz" "" ""
else
  log_warn "No Plane Postgres dump in backup — skipping pm restore."
fi

# --- Restore data volumes ------------------------------------------------
if [ -d "$WORK_DIR/volumes" ]; then
  for dir in "$WORK_DIR"/volumes/*/; do
    [ -d "$dir" ] || continue
    vol="$(basename "$dir")"
    full="${PROJECT}_${vol}"
    if [ -f "$dir/data.tar" ]; then
      log_info "Restoring volume '$full'..."
      docker run --rm \
        -v "$full:/data" \
        -v "$dir:/in:ro" \
        alpine:3.20 \
        sh -c 'rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar -xf /in/data.tar -C /data'
      log_success "volume '$vol' restored."
    else
      log_warn "volume '$vol' was absent in backup (EMPTY marker) — skipping."
    fi
  done
fi

# --- Restart affected services -------------------------------------------
if [ "${SKIP_SERVICE_RESTART:-0}" != "1" ]; then
  log_info "Restarting affected services..."
  for svc in "$DB_SERVICE" "$PM_SERVICE" orchestrator nextcloud pm-api pm-worker pm-beat pm-web; do
    if dc ps --services 2>/dev/null | grep -qx "$svc"; then
      dc restart "$svc" >/dev/null 2>&1 || true
    fi
  done
fi

log_success "Restore complete."
log_info "Services should be reachable once health checks pass."
log_info "Restored from: $BACKUP_TARBALL"
