#!/usr/bin/env bash
# =============================================================================
# WARP-3165 — rotate the audit chain's HMAC key on a box, from its shell.
# =============================================================================
#
# For a box that exported an audit bundle before WARP-3153 (those bundles
# carry the key). The dashboard action (POST /api/activity/rotate-key, owner
# + recent MFA) does the same without a restart; use this where the
# dashboard can't (no host helper, or no owner session).
#
# What it does:
#   1. checks the running orchestrator mounts data/secrets/audit-retired (the
#      retired key must stay readable, or every row it signed stops
#      verifying at the next boot);
#   2. runs the OTA helper's `rotate-audit-key` (archive, then new key in
#      place);
#   3. restarts the orchestrator (`restart`, not a recreate: the container
#      keeps its pinned image). At boot it signs with the new key and writes
#      "Audit key rotated" (actor system) as the first new-key row.
#
# Usage (as root, from the repo root on the box):
#   scripts/rotate-audit-key.sh [--yes]
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
HELPER="$REPO_ROOT/docker/ota/apply-update.sh"

say() { printf '[rotate-audit-key] %s\n' "$*" >&2; }
die() { printf '[rotate-audit-key] ERROR: %s\n' "$*" >&2; exit 1; }

[ "${1:-}" = "--yes" ] || {
  printf 'Rotate the audit signing key and restart the orchestrator? [y/N] '
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "cancelled"
}

cid="$(docker compose -f "$COMPOSE_FILE" ps -q orchestrator)"
[ -n "$cid" ] || die "the orchestrator container isn't running"
docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$cid" \
  | grep -qx '/data/secrets/audit-retired' \
  || die "the orchestrator doesn't mount /data/secrets/audit-retired yet; apply the latest update first"

mkdir -p "$REPO_ROOT/data/secrets/audit-retired"
DROPLET_OTA_CONFIG_ROOT="$REPO_ROOT" bash "$HELPER" rotate-audit-key --compose-file "$COMPOSE_FILE"
docker compose -f "$COMPOSE_FILE" restart orchestrator
say "done: the orchestrator restarted on the new key. Check Audit log > Verify."
