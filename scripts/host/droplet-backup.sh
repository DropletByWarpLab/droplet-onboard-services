#!/usr/bin/env bash
# =============================================================================
# WARP-254 — restic backup with a device-identity-derived repository key
# =============================================================================
#
# The long-term backup home foreshadowed by device-backup.sh (WARP-570): an
# encrypted, deduplicated restic repository instead of standalone tarballs.
#
#   - Repository password: DERIVED (HKDF-SHA256) from DEVICE_SECRET_KEY —
#     see droplet-backup-lib.sh for the stability contract. Never stored in a
#     tracked file; materialized per-run under /run/droplet (root-only tmpfs).
#   - Repository location:  $DROPLET_BACKUP_TARGET, default
#     /var/lib/droplet/restic-repo (local path on the data disk). Off-device
#     targets (restic natively speaks sftp/S3/rest-server) are future work —
#     the env knob is already the only thing that needs to change.
#   - Daily incrementals:   droplet-restic-backup.timer runs this with no
#     args → `restic backup` (parent-snapshot incremental), tagged `daily`.
#   - Weekly fulls:         droplet-restic-backup-full.timer runs `--full` →
#     `restic backup --force` (re-reads every byte instead of trusting the
#     parent snapshot's metadata), tagged `weekly-full`. Storage stays
#     deduplicated either way; --force is the integrity re-read.
#
# What is captured:
#   staging/postgres/droplet.sql.gz   transactional pg_dump of the
#                                     orchestrator Postgres (compose `db`)
#   staging/postgres/nextcloud.sql.gz the Nextcloud metadata DB, hosted in the
#                                     SAME `db` container (WARP-1013): file
#                                     cache, shares, users, groupfolders. Must
#                                     travel with nextcloud-data.tar or a
#                                     restore pairs fresh blobs with a stale
#                                     metadata DB (missing/ghost files).
#   staging/volumes/nextcloud-data.tar  the Nextcloud data volume (user files),
#                                     snapshotted via a throwaway sibling
#                                     container so no host bind-mount or
#                                     /var/lib/docker access is needed
#   <repo>/.env                       device secrets (the repo copy is chmod
#                                     600; the restic repo itself is encrypted)
#   config dirs (existence-guarded):  docker/certs, docker/secrets,
#                                     data/secrets (audit signing key),
#                                     /etc/droplet, /etc/default/droplet-*
#
# Camera footage (the `nvrdata` volume) is EXCLUDED BY DEFAULT: 24/7 NVR
# recordings routinely run to hundreds of GB, which would dwarf every other
# surface, blow through the data-disk budget, and stretch the nightly window
# from minutes to hours. Opt in with DROPLET_BACKUP_INCLUDE_CAMERA=1.
#
# Retention (applied after every backup via `restic forget --prune`):
#   7 daily / 4 weekly / 6 monthly snapshots — a month of fine-grained
#   restore points plus half a year of monthly history, bounded on disk.
#   Override with DROPLET_BACKUP_KEEP_{DAILY,WEEKLY,MONTHLY}. Grouped
#   --group-by host so retention stays global across backup path-set changes
#   (restic's default host,paths grouping would strand stale groups forever).
#
# Usage:
#   ./scripts/host/droplet-backup.sh [--full]
#
# Env overrides (defaults match the production compose stack — the drill
# harness in tests/restic-backup.test.sh points these at a disposable project):
#   DROPLET_REPO_ROOT             checkout root (systemd units set this)
#   DROPLET_BACKUP_TARGET         restic repository (default /var/lib/droplet/restic-repo)
#   DROPLET_BACKUP_STATE_DIR      staging + cache + drill status (default /var/lib/droplet/backup)
#   DROPLET_BACKUP_RUNTIME_DIR    password-file runtime dir (default /run/droplet)
#   DROPLET_BACKUP_INCLUDE_CAMERA 1 = also capture the nvrdata volume
#   DROPLET_BACKUP_KEEP_DAILY / _WEEKLY / _MONTHLY   retention knobs (7/4/6)
#   PROJECT / COMPOSE_FILE / DB_SERVICE / DB_USER / DB_NAME  as device-backup.sh
#
# Scheduling: host systemd timers (scripts/host/systemd/droplet-restic-backup*
# — installed + enabled by setup.sh via scripts/lib/backup.sh). The
# orchestrator's in-container cron-runtime is deliberately NOT used — it can't
# pg_dump the sibling db container or write a host repository path.
#
# Restore: droplet-restore.sh. Monthly automated drill: droplet-restore-drill.sh.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=droplet-backup-lib.sh
source "$SCRIPT_DIR/droplet-backup-lib.sh"

FULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) log_error "unknown argument: $1 (see --help)"; exit 64 ;;
  esac
done

REPO_ROOT="$(droplet_backup_resolve_repo_root)"

# Source the repo logging library when present (matches device-backup.sh) —
# overrides the lib's plain fallbacks with the colored variants.
if [ -f "$REPO_ROOT/scripts/lib/logging.sh" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/lib/logging.sh"
fi

COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker/docker-compose.yml}"

# Live compose project name — DERIVE from the compose `name:` field (pinned
# `name: droplet`, WARP-187); an explicit PROJECT= override wins (the drill
# harness points it at a disposable project). Same stale-default guard as
# device-backup.sh: docker prefixes volumes `<project>_<vol>`, so a wrong
# default silently targets nonexistent volumes.
if [ -z "${PROJECT:-}" ]; then
  PROJECT="$(grep -E '^name:[[:space:]]' "$COMPOSE_FILE" 2>/dev/null | head -1 | awk '{gsub(/["\x27]/,"",$2); print $2}' || true)"
fi
PROJECT="${PROJECT:-droplet}"
DB_SERVICE="${DB_SERVICE:-db}"
STATE_DIR="${DROPLET_BACKUP_STATE_DIR:-/var/lib/droplet/backup}"
STAGING="$STATE_DIR/staging"

KEEP_DAILY="${DROPLET_BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${DROPLET_BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${DROPLET_BACKUP_KEEP_MONTHLY:-6}"

# --- Pre-flight ------------------------------------------------------------
if ! command -v restic >/dev/null 2>&1; then
  log_error "restic not on PATH — install it (setup.sh does: apt-get install -y restic)"
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  log_error "docker not on PATH; droplet-backup requires the compose stack"
  exit 2
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  log_error "compose file not found at $COMPOSE_FILE"
  exit 2
fi

droplet_backup_prepare_restic_env
droplet_backup_ensure_repo

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# --- Phase 1: stage the Postgres dumps --------------------------------------
# The staging paths are STABLE across runs (never mktemp) so restic's
# parent-snapshot change detection sees the same file identity every day.
#
# The `db` container hosts TWO databases: `droplet` (orchestrator) and
# `nextcloud` (init-nextcloud-db.sh). Both are dumped as separate explicit
# pg_dumps rather than one pg_dumpall (WARP-1013): per-DB files keep stable
# staging identities for restic's change detection, get individual gzip
# integrity checks, and restore selectively; pg_dumpall's extra surface
# (roles/globals) isn't needed — both DBs are owned by the container's
# env-created superuser, which the postgres entrypoint recreates from .env.
mkdir -p "$STAGING/postgres" "$STAGING/volumes"
chmod 700 "$STATE_DIR" "$STAGING" 2>/dev/null || true

stage_db_dump() {
  # $1 = staged file name (postgres/<name>.sql.gz); $2 = in-container DB
  #      override (empty = the container's own POSTGRES_DB)
  local name="$1" db="$2" out="$STAGING/postgres/$1.sql.gz"
  log_info "Dumping Postgres database '$name' from service '$DB_SERVICE'..."
  # Overrides ride container env (-e) with in-container fallback to the
  # container's own POSTGRES_USER/POSTGRES_DB — mirrors device-backup.sh's
  # dump_pg (avoids the fragile nested host-side expansion documented there).
  if ! dc exec -T -e "DROPLET_DUMP_USER=${DB_USER:-}" -e "DROPLET_DUMP_DB=$db" "$DB_SERVICE" \
       sh -c 'pg_dump --username="${DROPLET_DUMP_USER:-$POSTGRES_USER}" --dbname="${DROPLET_DUMP_DB:-$POSTGRES_DB}" --format=plain --no-owner --no-privileges' \
       | gzip --best > "$out"; then
    log_error "pg_dump of '$name' failed — aborting (refusing a partial backup)"
    exit 1
  fi
  # A truncated dump must never become the newest snapshot.
  if ! gzip -t "$out" 2>/dev/null; then
    log_error "staged dump of '$name' failed gzip integrity check — aborting"
    exit 1
  fi
  log_success "database '$name' dumped ($(wc -c < "$out") bytes gzipped)"
}

stage_db_dump droplet "${DB_NAME:-}"

# GUARD (WARP-1013): a legacy pgdata volume created before init-nextcloud-db.sh
# landed can lack the nextcloud DB (the init script only runs on first volume
# creation). Skip explicitly — mirroring stage_volume's absent-volume guard —
# instead of failing every nightly backup, and drop any stale staged dump so
# an old copy can't ride along in new snapshots forever.
if dc exec -T -e "DROPLET_DUMP_USER=${DB_USER:-}" -e "DROPLET_DUMP_DB=${DB_NAME:-}" "$DB_SERVICE" \
     sh -c 'psql --username="${DROPLET_DUMP_USER:-$POSTGRES_USER}" --dbname="${DROPLET_DUMP_DB:-$POSTGRES_DB}" -tAc "SELECT 1 FROM pg_database WHERE datname='"'"'nextcloud'"'"';"' \
     2>/dev/null | grep -q 1; then
  stage_db_dump nextcloud nextcloud
else
  log_warn "database 'nextcloud' absent — skipping its dump (legacy pgdata predating init-nextcloud-db.sh?)"
  rm -f "$STAGING/postgres/nextcloud.sql.gz"
fi

# --- Phase 2: stage data volumes --------------------------------------------
# Snapshot via a throwaway sibling container that mounts the named volume
# read-only and streams a tar — works identically on the box, in CI, and on
# dev machines (no /var/lib/docker host access, no bind mounts). restic's
# content-defined chunking dedups the unchanged regions of the tar across
# days, so storage growth stays incremental even though the tar is re-read.
stage_volume() {
  # $1 = short volume name; stages to $STAGING/volumes/<name>.tar
  local vol="$1" full="${PROJECT}_$1" out="$STAGING/volumes/$1.tar"
  # GUARD: `docker run -v name:/data` AUTO-CREATES a missing volume, silently
  # staging an empty tar (the WARP-570 review-blocker class). Only stage
  # volumes that genuinely exist.
  if ! docker volume inspect "$full" >/dev/null 2>&1; then
    log_warn "volume '$full' absent — skipping (fresh install before first stack start?)"
    rm -f "$out"
    return 0
  fi
  log_info "Snapshotting volume '$full'..."
  if docker run --rm -v "$full:/data:ro" alpine:3.20 \
       sh -c 'tar -cf - -C /data .' > "$out"; then
    log_success "volume '$vol' staged ($(wc -c < "$out") bytes)"
  else
    log_error "volume '$full' exists but tar failed — aborting (refusing a partial backup)"
    exit 1
  fi
}

stage_volume nextcloud-data

# Camera footage: EXCLUDED by default (size — see header). The stale-staging
# rm matters: without it, a box that once opted in would keep re-snapshotting
# an old nvrdata.tar forever after opting back out. Precedence: environment >
# .env (operator knob) > default off.
INCLUDE_CAMERA="${DROPLET_BACKUP_INCLUDE_CAMERA:-}"
[ -z "$INCLUDE_CAMERA" ] && INCLUDE_CAMERA="$(droplet_backup_dotenv_value DROPLET_BACKUP_INCLUDE_CAMERA)"
# WARP-2136: footage lives EITHER in the `nvrdata` named volume OR at a host
# path, depending on NVR_MEDIA_SOURCE. `stage_volume` can only reach the
# volume, so on a redirected box the opt-in used to log "volume absent —
# skipping" and produce a backup with no footage in it while still reporting
# success. A bind path goes to restic DIRECTLY rather than through a staging
# tar: recordings run to hundreds of GB, and re-tarring them every night to
# copy bytes restic would have deduped anyway doubles the disk churn and the
# window for no benefit.
CAMERA_BIND_PATH=""
if [ "${INCLUDE_CAMERA:-0}" = "1" ]; then
  _camera_media="$(droplet_backup_nvr_media_bind_path)"
  if [ -n "$_camera_media" ]; then
    if [ -d "$_camera_media" ]; then
      log_info "DROPLET_BACKUP_INCLUDE_CAMERA=1 — capturing camera footage from $_camera_media (NVR_MEDIA_SOURCE bind mount)"
      CAMERA_BIND_PATH="$_camera_media"
    else
      # Loud, not fatal: the rest of the backup is still worth taking, but
      # the operator must not believe footage was captured.
      log_warn "NVR_MEDIA_SOURCE=$_camera_media does not exist — camera footage NOT captured (is the recordings filesystem mounted?)"
    fi
    # No volume to stage on this shape; drop any tar from a pre-redirect run.
    rm -f "$STAGING/volumes/nvrdata.tar"
  else
    log_info "DROPLET_BACKUP_INCLUDE_CAMERA=1 — capturing camera footage (nvrdata volume)"
    stage_volume nvrdata
  fi
else
  rm -f "$STAGING/volumes/nvrdata.tar"
fi

# --- Phase 3: assemble the backup path set ----------------------------------
BACKUP_PATHS=("$STAGING")

if [ -f "$REPO_ROOT/.env" ]; then
  BACKUP_PATHS+=("$REPO_ROOT/.env")
else
  log_warn "$REPO_ROOT/.env absent — device secrets not captured this run"
fi

# Config dirs/files — only those present on this box/shape.
CONFIG_CANDIDATES=(
  "$REPO_ROOT/docker/certs"
  "$REPO_ROOT/docker/secrets"
  "$REPO_ROOT/data/secrets"
  /etc/droplet
  /etc/default/droplet-openwrt-attach
  /etc/default/droplet-host-net
)
for c in "${CONFIG_CANDIDATES[@]}"; do
  [ -e "$c" ] && BACKUP_PATHS+=("$c")
done

# WARP-2136: bind-mounted footage is a real host path, so restic takes it
# directly (the volume shape went through $STAGING above). Added last so the
# staged surfaces are captured even if this tree is huge.
if [ -n "$CAMERA_BIND_PATH" ]; then
  BACKUP_PATHS+=("$CAMERA_BIND_PATH")
fi

# --- Phase 4: restic backup --------------------------------------------------
TAG="daily"
EXTRA_FLAGS=()
if [ "$FULL" = "1" ]; then
  TAG="weekly-full"
  # --force re-reads every file instead of trusting parent-snapshot metadata —
  # the weekly "full" in restic terms (storage stays deduplicated).
  EXTRA_FLAGS+=(--force)
fi

log_info "restic backup (tag: $TAG) → $RESTIC_REPOSITORY"
# WARP-242: the doc-KEK master keyfile must NEVER enter a snapshot. Every
# snapshot already carries .env + the pg_dump (wrapped per-document DEKs);
# adding the KEK would make snapshots self-decrypting and crypto-shredding a
# DEK would no longer hold against backups. Excluding it means a restore
# onto NEW hardware cannot decrypt brain chunks (documented trade-off:
# docs/security/at-rest-encryption.md).
restic backup --tag "$TAG" \
  --exclude "$REPO_ROOT/data/secrets/doc-kek.key" \
  "${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}" "${BACKUP_PATHS[@]}"
log_success "snapshot created (tag: $TAG)"

# --- Phase 5: retention -------------------------------------------------------
log_info "Applying retention: ${KEEP_DAILY} daily / ${KEEP_WEEKLY} weekly / ${KEEP_MONTHLY} monthly"
# --group-by host (not restic's host,paths default): the backup path set changes
# over the box's lifetime — config-dir candidates are existence-guarded and .env
# presence is conditional — and per-path-set groups would each retain their last
# daily/weekly/monthly snapshots forever. Grouping by host keeps retention global.
restic forget --prune \
  --group-by host \
  --keep-daily "$KEEP_DAILY" \
  --keep-weekly "$KEEP_WEEKLY" \
  --keep-monthly "$KEEP_MONTHLY"

log_success "Backup complete."
log_info "  Repository: $RESTIC_REPOSITORY"
log_info "  Restore:    ./scripts/host/droplet-restore.sh   (monthly drill: droplet-restore-drill.sh)"
