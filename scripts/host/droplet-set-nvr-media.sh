#!/usr/bin/env bash
# =============================================================================
# WARP-2099 — NVR recordings-target write-back host executor
# =============================================================================
#
# `NVR_MEDIA_SOURCE` is the one key that decides where Frigate writes 24/7
# camera footage. It is consumed at exactly one seam — the compose volume line
# `- ${NVR_MEDIA_SOURCE:-nvrdata}:/media/frigate` — and until this script
# existed NOTHING anywhere WROTE it. `grep -rn NVR_MEDIA_SOURCE scripts/`
# returned zero. The value could only exist because a human hand-edited .env
# over SSH, and factory-reset.sh correctly deletes .env — so every reset or
# re-image silently reverted recordings to the boot disk with nothing to
# re-establish them.
#
# The fallback is silent BY CONSTRUCTION: `nvrdata` is a bare local named
# volume under Docker's data root on the boot disk, and `:-nvrdata` absorbs an
# unset variable without error. That is how a 2x2 TB RAID1 sat empty for a
# month while `/` climbed to 94%.
#
# This is the WRITER. It does two things and refuses loudly rather than
# guessing:
#
#   1. Validates the requested target, then idempotently writes
#      NVR_MEDIA_SOURCE=<value> into the repo .env (tmp+mv).
#   2. Recreates the frigate container, because an .env edit does NOT affect a
#      running container. Skipping this leg would be its own silent failure:
#      a successful save with no behaviour change.
#
# Repo-tracked (architecture-guard rule 20) and installed to
# /usr/local/sbin/droplet-set-nvr-media.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box. Removed by
# scripts/factory-reset.sh so a reset truly returns the box to out-of-box.
#
# Usage:
#   droplet-set-nvr-media.sh '/mnt/droplet/pool-1a2b3c4d/nvr'   # bind mount
#   droplet-set-nvr-media.sh 'nvrdata'                          # named volume
#
# ── HARD VALIDATION (reject BEFORE writing) ─────────────────────────────────
#
# Exactly two value shapes are accepted, because compose accepts exactly two:
# a compose-DECLARED volume name, or an ABSOLUTE path. Anything else makes
# `docker compose up` fail on an undefined volume, which would take the whole
# stack down rather than just the cameras.
#
# For an absolute path we do NOT merely test "is it a mountpoint", which is
# what a first reading of the hazard suggests. `/` is itself a mountpoint, and
# so is `/boot` — both would sail through that check while being precisely the
# disks footage must never land on. The invariant that actually matters is
# "does this path live on a DIFFERENT filesystem from the root filesystem",
# so that is what we test, by comparing st_dev. That is strictly stronger than
# a mountpoint test for the real hazard AND it permits the dedicated-subdir
# shape (`<pool>/nvr`) that avoids colliding with the Nextcloud external-
# storage view registered at the pool root.
#
# A non-existent path is refused outright: Docker would create an empty
# directory for a missing bind source and record onto the boot disk anyway —
# the exact silent failure this ticket exists to end.
#
# Test/dev hooks (so validation + upsert are unit-testable without root):
#   DROPLET_NVR_MEDIA_ENV_FILE=...      override the .env path (default <repo>/.env)
#   DROPLET_NVR_MEDIA_COMPOSE_FILE=...  override the compose file consulted for
#                                       declared volume names
#   DROPLET_NVR_MEDIA_ROOT_DEV=...      override the st_dev treated as "the root
#                                       filesystem" (lets a test simulate a box
#                                       without needing a second real device)
#   DROPLET_NVR_MEDIA_SKIP_RECREATE=1   write only; do not touch docker
# =============================================================================
set -euo pipefail

TARGET="${1:-}"

err() { printf 'droplet-set-nvr-media: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

[ -n "$TARGET" ] || die "no recordings target given"

# --- Resolve the repo root + .env target ------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${REPO_ROOT:-}" ]; then
  if [ -f "$SCRIPT_DIR/../../docker/docker-compose.yml" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  else
    REPO_ROOT="/home/droplet/edge-platform"
  fi
fi
export REPO_ROOT

ENV_FILE="${DROPLET_NVR_MEDIA_ENV_FILE:-$REPO_ROOT/.env}"
COMPOSE_FILE="${DROPLET_NVR_MEDIA_COMPOSE_FILE:-$REPO_ROOT/docker/docker-compose.yml}"

# --- Reject shell-hostile values before anything else -----------------------
# The value is interpolated into .env and later into a compose volume spec.
# Matched with bash's [[ =~ ]] (whole-string, newline-safe) rather than a
# `printf | grep -q` pipe — grep is LINE-based, so a newline-bearing arg like
# 'nvrdata<LF>KEY=evil' would pass a grep check on its first line and inject a
# second .env assignment.
if [[ "$TARGET" =~ [[:space:]] ]]; then
  die "target '${TARGET}' contains whitespace"
fi
if [ "${#TARGET}" -gt 255 ]; then
  die "target is longer than 255 characters"
fi

case "$TARGET" in
  /*)
    # ---------------- Absolute path: bind mount ----------------------------
    # A relative path is NOT a third shape — compose would read it as a
    # relative bind source against the compose file's directory, silently
    # landing footage inside the repo (i.e. the boot disk). Refused above by
    # falling through to the named-volume branch, which rejects the slash.
    [ -d "$TARGET" ] || die "target '${TARGET}' does not exist (or is not a directory) — refusing: Docker would create an empty directory for a missing bind source and record onto the boot disk anyway"

    # Canonicalize so `/mnt/pool/../..` cannot smuggle us back onto /.
    _resolved="$(readlink -f "$TARGET" 2>/dev/null || printf '%s' "$TARGET")"

    # Never the boot/ESP filesystems, whatever their st_dev says. These are
    # separate devices from / on every Droplet layout, so the st_dev test
    # below would happily accept them.
    case "$_resolved" in
      /boot|/boot/*)
        die "target '${_resolved}' is on the boot filesystem — recordings must never land there"
        ;;
    esac

    _root_dev="${DROPLET_NVR_MEDIA_ROOT_DEV:-$(stat -c %d / 2>/dev/null || echo "")}"
    _target_dev="$(stat -c %d "$_resolved" 2>/dev/null || echo "")"
    if [ -z "$_root_dev" ] || [ -z "$_target_dev" ]; then
      die "could not determine the filesystem of '${_resolved}' — refusing rather than guessing"
    fi
    if [ "$_root_dev" = "$_target_dev" ]; then
      die "target '${_resolved}' is on the ROOT filesystem — recordings there fill the boot disk and take the appliance down. Point this at a mounted pool (e.g. /mnt/droplet/<pool>/nvr)."
    fi
    TARGET="$_resolved"
    ;;
  *)
    # ---------------- Bare name: compose-declared volume -------------------
    # Docker's own volume-name grammar. Anything outside it (a slash, a colon,
    # a leading dot) is not a volume name and not an absolute path.
    if ! [[ "$TARGET" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
      die "target '${TARGET}' is neither an absolute path nor a valid volume name"
    fi
    # It must actually be DECLARED, or `docker compose up` fails on an
    # undefined volume and takes the whole stack down — a far worse outcome
    # than the misconfiguration we are fixing.
    if [ -f "$COMPOSE_FILE" ]; then
      if ! awk '
        /^volumes:/        { inv = 1; next }
        /^[A-Za-z_-]+:/    { inv = 0 }
        inv && /^  [A-Za-z0-9][A-Za-z0-9_.-]*:/ {
          name = $1; sub(/:$/, "", name); print name
        }
      ' "$COMPOSE_FILE" | grep -qxF "$TARGET"; then
        die "volume '${TARGET}' is not declared in ${COMPOSE_FILE} — 'docker compose up' would fail on an undefined volume"
      fi
    fi
    ;;
esac

# --- Idempotent .env write-back (replace-or-append, tmp+mv) -----------------
# Create the file if missing so a brand-new box can still record the choice.
[ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; chmod 0600 "$ENV_FILE"; }

_desired="NVR_MEDIA_SOURCE=${TARGET}"
_changed=true
if grep -qxF "$_desired" "$ENV_FILE"; then
  _changed=false  # already current — no rewrite (keeps re-runs byte-identical)
elif grep -qE '^[[:space:]]*#?[[:space:]]*NVR_MEDIA_SOURCE=' "$ENV_FILE"; then
  _tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  sed -E "s|^[[:space:]]*#?[[:space:]]*NVR_MEDIA_SOURCE=.*|${_desired}|" \
    "$ENV_FILE" > "$_tmp"
  # mktemp creates 0600; preserve whatever the live .env already had so we
  # never widen (or narrow) its mode as a side effect of this write.
  chmod --reference="$ENV_FILE" "$_tmp" 2>/dev/null || chmod 0600 "$_tmp"
  mv "$_tmp" "$ENV_FILE"
else
  # A file whose last line was cut mid-write would otherwise glue our key onto
  # it, corrupting BOTH — same guard as secrets.sh's writers.
  if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE")" ]; then
    printf '\n' >> "$ENV_FILE"
  fi
  printf '%s\n' "$_desired" >> "$ENV_FILE"
fi
printf 'NVR_MEDIA_SOURCE=%s persisted to %s\n' "$TARGET" "$ENV_FILE"

# --- Recreate frigate so the new target actually takes effect ---------------
# An .env edit does nothing to a running container. The orchestrator has no
# docker socket (ADR-023), which is why this leg lives here on the host.
if [ "${DROPLET_NVR_MEDIA_SKIP_RECREATE:-0}" = "1" ]; then
  printf 'skipping frigate recreate (DROPLET_NVR_MEDIA_SKIP_RECREATE=1)\n'
  exit 0
fi
if [ "$_changed" = "false" ]; then
  printf 'target unchanged — frigate left running\n'
  exit 0
fi
if ! command -v docker >/dev/null 2>&1; then
  err "docker not found — .env was written but frigate was NOT recreated; footage keeps going to the OLD target until it is"
  exit 3
fi
printf 'recreating frigate so the new recordings target takes effect...\n'
if ! docker compose -f "$COMPOSE_FILE" up -d --force-recreate frigate; then
  # Deliberately a DISTINCT non-zero code: the write succeeded, the apply did
  # not. A caller that reports plain success here would be telling the owner
  # their footage moved when it has not.
  err "frigate recreate FAILED — .env now says ${TARGET} but the running container still uses the old target"
  exit 4
fi
printf 'frigate recreated — recordings now go to %s\n' "$TARGET"

exit 0
