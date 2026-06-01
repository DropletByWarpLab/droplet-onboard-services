#!/usr/bin/env bash
# =============================================================================
# WARP-514 — Embedded Plane PM stack: backup
# =============================================================================
#
# Snapshots the two Plane data surfaces (per spec WARP-498 OQ1 resolution —
# dedicated postgres-pm + redis-pm + attachments volume) into a single
# timestamped tarball.
#
# Usage:
#   ./scripts/host/pm-backup.sh [OUTPUT_DIR]
#
# OUTPUT_DIR defaults to /var/lib/droplet/backups. The script creates one
# tarball:
#
#   <OUTPUT_DIR>/pm-backup-<YYYYMMDDTHHMMSSZ>.tar.gz
#
# Layout inside:
#   postgres-pm/dump.sql.gz       pg_dump --format=plain | gzip
#   attachments/data.tar          tar of the pm-attachments volume contents
#   manifest.json                 { taken_at, plane_image_sha, db_size_bytes }
#
# Idempotent — concurrent invocations write to distinct timestamped files.
#
# Restore via the companion `pm-restore.sh`.
#
# Engineering-handbook compliance (binding):
#   - rule 1  shipping-product mindset (no "poc" / "test" / "dev" framing)
#   - rule 9  no `while True` — script runs once per invocation; scheduling
#             comes from the existing cron-runtime, not from this file
#   - rule 14 no host-specific defaults — OUTPUT_DIR is operator-supplied or
#             falls back to a well-known FHS location, not a dev-machine path
#
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OUTPUT_DIR="${1:-/var/lib/droplet/backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# --- Source logging library if present (matches setup.sh convention) ------
if [ -f "$REPO_ROOT/scripts/lib/logging.sh" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/lib/logging.sh"
else
  log_info()    { printf "  [pm-backup] %s\n" "$*"; }
  log_success() { printf "  [pm-backup] OK: %s\n" "$*"; }
  log_warn()    { printf "  [pm-backup] WARN: %s\n" "$*" >&2; }
  log_error()   { printf "  [pm-backup] ERROR: %s\n" "$*" >&2; }
fi

# --- Pre-flight ----------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log_error "docker not on PATH; pm-backup requires the compose stack"
  exit 2
fi

COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
  log_error "compose file not found at $COMPOSE_FILE"
  exit 2
fi

mkdir -p "$OUTPUT_DIR"

WORK_DIR="$(mktemp -d -t pm-backup-XXXXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

ARCHIVE="$OUTPUT_DIR/pm-backup-$TS.tar.gz"

# --- Phase 1: Postgres dump ----------------------------------------------
log_info "Dumping postgres-pm..."
mkdir -p "$WORK_DIR/postgres-pm"

# pg_dump from inside the container so we don't need libpq on the host.
# `pg_dump --format=plain` + gzip gives a portable, restore-anywhere
# artifact; `--no-owner --no-privileges` so the restore doesn't require
# the same Plane DB user to exist on the target.
if ! docker compose -f "$COMPOSE_FILE" exec -T postgres-pm \
       sh -c 'pg_dump --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" --format=plain --no-owner --no-privileges' \
       | gzip --best > "$WORK_DIR/postgres-pm/dump.sql.gz"; then
  log_error "postgres-pm dump failed"
  exit 1
fi

DB_SIZE=$(wc -c < "$WORK_DIR/postgres-pm/dump.sql.gz")
log_success "postgres-pm dumped ($DB_SIZE bytes gzipped)"

# --- Phase 2: Attachments volume -----------------------------------------
log_info "Snapshotting Plane attachments volume..."
mkdir -p "$WORK_DIR/attachments"

# When Plane attachments live on a named volume, we tar it via a throwaway
# sibling container that mounts it read-only. Plane keeps attachments
# append-only at the file level (renames-then-replaces on edit), so a hot
# snapshot during low traffic is consistent. The spec WARP-498 OQ1 flag noted
# a brief pause-write window may be needed for high-traffic deployments; for V1
# we accept the small inconsistency risk.
#
# CURRENT STATE: there is NO `pm-attachments-data` volume in
# docker/docker-compose.yml — pm-api/pm-worker declare no `volumes:` mount, so
# the only PM-related named volumes are postgres-pm-data + redis-pm-data. Plane
# attachments therefore sit on the ephemeral container layer in this stack, and
# this phase skips. The phase is kept (guarded) so that once attachments are
# moved onto a `pm-attachments-data` volume — the durability fix the
# docs/SINGLE_BOX.md storage budget already assumes — backup picks it up with no
# further change. That deeper attachment-durability gap is tracked separately;
# this script must surface it, never paper over it.
ATTACH_VOLUME="${PROJECT:-droplet}_pm-attachments-data"
# GUARD (WARP-570 class): `docker run -v <name>:/data` AUTO-CREATES a missing
# named volume, which would silently tar an EMPTY volume and mask the fact that
# attachments aren't on a named volume at all — the exact review blocker fixed
# for device-backup.sh in PR #356. Only snapshot the volume if it genuinely
# exists; otherwise record an EMPTY marker so pm-restore.sh skips cleanly
# instead of writing back into a phantom volume.
if ! docker volume inspect "$ATTACH_VOLUME" >/dev/null 2>&1; then
  log_warn "attachments volume '$ATTACH_VOLUME' absent — skipping (Plane attachments are not on a named volume in this stack)"
  printf 'attachments-volume-absent-at-backup-time\n' > "$WORK_DIR/attachments/EMPTY"
elif ! docker run --rm \
       -v "$ATTACH_VOLUME:/data:ro" \
       -v "$WORK_DIR/attachments:/out" \
       alpine:3.20 \
       sh -c 'tar -cf /out/data.tar -C /data .'; then
  # Volume exists but the snapshot failed — refuse a partial backup (matches
  # device-backup.sh's posture) rather than emitting a misleadingly "complete"
  # archive that is silently missing attachments.
  log_error "attachments volume '$ATTACH_VOLUME' exists but tar failed"
  exit 1
fi

# --- Phase 3: Manifest ---------------------------------------------------
log_info "Writing manifest..."
PLANE_IMAGE_SHA="$(docker compose -f "$COMPOSE_FILE" config 2>/dev/null \
                    | grep -m1 'image: makeplane/plane-backend:' \
                    | sed 's/.*://')"
cat > "$WORK_DIR/manifest.json" <<MANIFEST
{
  "taken_at": "$TS",
  "plane_image_pin": "${PLANE_IMAGE_SHA:-unknown}",
  "db_size_bytes": $DB_SIZE,
  "host": "$(hostname 2>/dev/null || echo unknown)",
  "warp_ticket": "WARP-514"
}
MANIFEST

# --- Phase 4: Pack -------------------------------------------------------
log_info "Packing archive..."
if ! tar -czf "$ARCHIVE" -C "$WORK_DIR" .; then
  log_error "archive packing failed"
  exit 1
fi

chmod 600 "$ARCHIVE"

log_success "Backup written: $ARCHIVE"
log_info "  Size: $(wc -c < "$ARCHIVE") bytes"
log_info "  Mode: $(stat -c '%a' "$ARCHIVE" 2>/dev/null || stat -f '%Lp' "$ARCHIVE" 2>/dev/null || echo unknown)"
log_info "  Restore with: ./scripts/host/pm-restore.sh $ARCHIVE"
