#!/usr/bin/env bash
# =============================================================================
# WARP-514 — Embedded Plane PM stack: restore
# =============================================================================
#
# Restores from an archive produced by pm-backup.sh. Wipes the existing
# postgres-pm + attachments before restoring so the result is a clean
# point-in-time replica, not a merge.
#
# Usage:
#   ./scripts/host/pm-restore.sh <ARCHIVE_PATH>
#
# Refuses to run unless the operator types CONFIRM at the prompt, mirroring
# scripts/factory-reset.sh's safety posture.
#
# Engineering-handbook compliance (binding):
#   - rule 1  shipping-product mindset — same restore script for every box
#   - rule 14 no host-specific defaults — restores to whichever postgres-pm
#             + pm-attachments-data volumes the local compose declares
#
# =============================================================================
set -euo pipefail

if [ "$#" -lt 1 ]; then
  printf "Usage: %s <ARCHIVE_PATH>\n" "$0" >&2
  exit 2
fi

ARCHIVE="$1"
if [ ! -f "$ARCHIVE" ]; then
  printf "Archive not found: %s\n" "$ARCHIVE" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"

if [ -f "$REPO_ROOT/scripts/lib/logging.sh" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/lib/logging.sh"
else
  log_info()    { printf "  [pm-restore] %s\n" "$*"; }
  log_success() { printf "  [pm-restore] OK: %s\n" "$*"; }
  log_warn()    { printf "  [pm-restore] WARN: %s\n" "$*" >&2; }
  log_error()   { printf "  [pm-restore] ERROR: %s\n" "$*" >&2; }
fi

# --- Confirmation --------------------------------------------------------
if [ "${PM_RESTORE_SKIP_CONFIRM:-false}" != "true" ]; then
  printf "\nThis will WIPE the current Plane DB + attachments and replace\n"
  printf "them with the contents of:\n  %s\n\nType CONFIRM to proceed: " "$ARCHIVE"
  read -r confirmation
  if [ "$confirmation" != "CONFIRM" ]; then
    log_info "Restore cancelled."
    exit 0
  fi
fi

WORK_DIR="$(mktemp -d -t pm-restore-XXXXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Phase 1: Unpack -----------------------------------------------------
log_info "Unpacking archive..."
tar -xzf "$ARCHIVE" -C "$WORK_DIR"

if [ ! -f "$WORK_DIR/manifest.json" ]; then
  log_error "archive missing manifest.json — not a pm-backup tarball?"
  exit 1
fi

log_info "Manifest:"
cat "$WORK_DIR/manifest.json" | sed 's/^/    | /'

# --- Phase 2: Bring Plane down so DB + volumes can be reset --------------
log_info "Stopping Plane containers..."
docker compose -f "$COMPOSE_FILE" stop pm-web pm-worker pm-api pm-health >/dev/null 2>&1 || true

# --- Phase 3: Wipe + reload Postgres -------------------------------------
log_info "Resetting postgres-pm contents..."
docker compose -f "$COMPOSE_FILE" up -d postgres-pm
# Healthcheck poll — short loop, no `while true` of unbounded duration.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres-pm pg_isready >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

docker compose -f "$COMPOSE_FILE" exec -T postgres-pm \
  sh -c 'dropdb -U "${POSTGRES_USER}" --if-exists "${POSTGRES_DB}" && \
         createdb -U "${POSTGRES_USER}" "${POSTGRES_DB}"'

log_info "Loading dump..."
gunzip -c "$WORK_DIR/postgres-pm/dump.sql.gz" | \
  docker compose -f "$COMPOSE_FILE" exec -T postgres-pm \
    sh -c 'psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"'

log_success "postgres-pm restored"

# --- Phase 4: Restore attachments volume ---------------------------------
ATTACH_VOLUME="${PROJECT:-droplet}_pm-attachments-data"
if [ -f "$WORK_DIR/attachments/EMPTY" ]; then
  log_info "Archive marks attachments as absent at backup time — skipping volume restore"
elif [ -f "$WORK_DIR/attachments/data.tar" ]; then
  log_info "Restoring attachments volume..."
  docker run --rm \
    -v "$ATTACH_VOLUME:/data" \
    -v "$WORK_DIR/attachments:/in:ro" \
    alpine:3.20 \
    sh -c 'rm -rf /data/* && tar -xf /in/data.tar -C /data'
  log_success "attachments volume restored"
else
  log_warn "no attachments payload in archive — skipping"
fi

# --- Phase 5: Bring Plane back up ----------------------------------------
log_info "Restarting Plane containers..."
docker compose -f "$COMPOSE_FILE" up -d pm-api pm-worker pm-web pm-health

log_success "Restore complete"
log_info "  Tail the logs: docker compose logs -f pm-api pm-web"
