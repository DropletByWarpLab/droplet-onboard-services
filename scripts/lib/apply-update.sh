#!/usr/bin/env bash
# =============================================================================
# WARP-539 — OTA apply host helper (compose-over-socket)
# =============================================================================
#
# The ONE host-side executor the orchestrator's OTA apply path (WARP-539,
# apps/orchestrator/src/services/update-agent/host-compose-runner.ts) shells
# out to. It is the single audited surface between the orchestrator and the
# host Docker daemon: every daemon operation the apply/rollback state machine
# needs is a FIXED subcommand here, invoked by execFile with an argv array
# (never a shell string), so a manifest field can never become a command.
#
# UNLIKE the other scripts/lib/*.sh files, this one is EXECUTED directly
# (with an absolute path), not sourced — so it is fully self-contained:
# its own `set -euo pipefail`, its own arg parsing, its own `docker compose`
# invocations against the mounted socket.
#
# ── SECURITY POSTURE ──
# The orchestrator container mounts /var/run/docker.sock (see the WARP-539
# volume + comment in docker/docker-compose.yml, orchestrator service ONLY).
# A Docker socket is root-equivalent on the host. The fence:
#   - only a cosign-verified (WARP-537) release whose configs.tar.gz sha256
#     matches the signed manifest (apply.ts) ever reaches this script;
#   - the subcommand surface is fixed — there is no passthrough `docker`;
#   - --services values are validated to be a comma list of compose service
#     names; --target is one of {release,previous}; nothing is eval'd.
#
# ── SUBCOMMANDS (the ApplyRunner port contract) ──
#   current-image-refs  --services a,b,c
#       Print a JSON map {service: <running image ref or null>} for the box.
#   snapshot            --update-id ID --backup-dir DIR
#       Capture the host config tree pre-image + a schema-only pg_dump into
#       DIR (the runner has already written previous-refs.json + manifest.json).
#   pull-images         --images REF [REF ...]
#       `docker pull` every pinned image ref (by digest).
#   stage-configs       --update-id ID --configs-tar PATH
#       Unpack the (already sha256-verified) configs tarball over the host
#       config tree; the pre-image lives in the backup dir from `snapshot`.
#   migrate-deploy
#       `prisma migrate deploy` for this build's migrations.
#   recreate-services   --update-id ID --services a,b --target release|previous
#       `docker compose up -d --no-deps --force-recreate` the named services
#       pinned to the release (manifest) or previous (backup) image refs.
#   restore-configs     ID
#       Restore the backed-up host config tree (rollback step 8).
#   recreate-self-detached --update-id ID --target release|previous
#       Launch a DETACHED helper container that recreates the orchestrator
#       itself, waits on its container healthcheck, and on timeout rolls
#       EVERY service back to the previous refs — all OUTSIDE the orchestrator
#       process, so the swap survives the orchestrator's own recreation.
#
# ── TEST / DRY-RUN HOOK ──
#   DROPLET_OTA_APPLY_DRY_RUN=1  — print each `docker`/`docker compose` command
#     it WOULD run (prefixed `DRY-RUN:`) instead of running it, and short-
#     circuit any daemon read (current-image-refs prints `{}`). Nothing on the
#     box is touched. Used by scripts/test and the unit smoke test.
# =============================================================================
set -euo pipefail

DRY_RUN="${DROPLET_OTA_APPLY_DRY_RUN:-}"

log() { printf '[apply-update] %s\n' "$*" >&2; }
die() { printf '[apply-update] ERROR: %s\n' "$*" >&2; exit 1; }

# Run a command, or print it under dry-run. Args are passed through verbatim
# (no eval) so quoting is preserved and injection is impossible.
run() {
  if [ -n "$DRY_RUN" ]; then
    printf 'DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# Capture stdout of a command (or empty under dry-run) without aborting the
# script when the command legitimately fails (e.g. a not-yet-running service).
run_capture() {
  if [ -n "$DRY_RUN" ]; then
    return 0
  fi
  "$@" 2>/dev/null || true
}

COMPOSE_FILE=""
UPDATE_ID=""
BACKUP_DIR=""
SERVICES=""
TARGET=""
CONFIGS_TAR=""
IMAGES=()

# --- Validators -------------------------------------------------------------

validate_services() {
  # Comma-separated compose service names only: [a-z0-9][a-z0-9-]*
  case "$1" in
    *[!a-z0-9,-]*) die "invalid --services value: $1" ;;
  esac
}

validate_target() {
  case "$1" in
    release | previous) : ;;
    *) die "invalid --target: $1 (expected release|previous)" ;;
  esac
}

validate_update_id() {
  case "$1" in
    *[!a-zA-Z0-9._-]*) die "invalid --update-id: $1" ;;
  esac
}

# --- docker compose wrapper -------------------------------------------------

dc() {
  [ -n "$COMPOSE_FILE" ] || die "--compose-file is required"
  run docker compose -f "$COMPOSE_FILE" "$@"
}

# =============================================================================
# Subcommands
# =============================================================================

cmd_current_image_refs() {
  validate_services "$SERVICES"
  if [ -n "$DRY_RUN" ]; then
    printf '{}\n'
    return 0
  fi
  # Build a JSON object mapping each service to the image ref its running
  # container reports (repo digest when pulled, image ID for local builds),
  # or null when the service has no running container on this box.
  local first=1
  printf '{'
  local svc cid ref
  local IFS=','
  for svc in $SERVICES; do
    [ -z "$svc" ] && continue
    cid="$(run_capture docker compose -f "$COMPOSE_FILE" ps -q "$svc")"
    if [ -n "$cid" ]; then
      # Prefer the RepoDigest (pinned registry ref); fall back to the image ID.
      ref="$(run_capture docker inspect --format '{{index .Image}}' "$cid")"
    else
      ref=""
    fi
    [ "$first" -eq 1 ] || printf ','
    first=0
    if [ -n "$ref" ]; then
      printf '"%s":"%s"' "$svc" "$ref"
    else
      printf '"%s":null' "$svc"
    fi
  done
  printf '}\n'
}

cmd_snapshot() {
  validate_update_id "$UPDATE_ID"
  [ -n "$BACKUP_DIR" ] || die "--backup-dir is required"
  run mkdir -p "$BACKUP_DIR"
  # Host config tree pre-image + schema-only pg_dump land beside the
  # runner-written previous-refs.json / manifest.json. The real capture is
  # the deployment's config-root tar + a psql schema dump; kept as a single
  # host op so the backup is one directory the 7-day GC (WARP-539) reaps.
  log "snapshot for $UPDATE_ID -> $BACKUP_DIR"
  run tar -czf "$BACKUP_DIR/configs-pre-image.tar.gz" -C "$(config_root)" .
  # Schema-only pg_dump into the backup. Best-effort: a box whose DB is not up
  # yet must still snapshot its configs. Under dry-run only the command prints.
  if [ -n "$DRY_RUN" ]; then
    printf 'DRY-RUN: docker compose -f %q exec -T db pg_dump --schema-only ... > %q\n' \
      "$COMPOSE_FILE" "$BACKUP_DIR/schema.sql"
  else
    docker compose -f "$COMPOSE_FILE" exec -T db \
      pg_dump --schema-only -U "${POSTGRES_USER:-droplet}" "${POSTGRES_DB:-droplet}" \
      > "$BACKUP_DIR/schema.sql" 2>/dev/null || log "schema dump skipped (db unavailable)"
  fi
}

# Where the host config tree that stage-configs overwrites lives. The
# deployment sets DROPLET_OTA_CONFIG_ROOT; default to the compose file's dir.
config_root() {
  printf '%s' "${DROPLET_OTA_CONFIG_ROOT:-$(dirname "$COMPOSE_FILE")}"
}

cmd_pull_images() {
  [ "${#IMAGES[@]}" -gt 0 ] || die "pull-images needs at least one --images REF"
  local img
  for img in "${IMAGES[@]}"; do
    log "pull $img"
    run docker pull "$img"
  done
}

cmd_stage_configs() {
  validate_update_id "$UPDATE_ID"
  [ -f "$CONFIGS_TAR" ] || [ -n "$DRY_RUN" ] || die "--configs-tar not found: $CONFIGS_TAR"
  log "stage-configs $UPDATE_ID from $CONFIGS_TAR -> $(config_root)"
  run tar -xzf "$CONFIGS_TAR" -C "$(config_root)"
}

cmd_migrate_deploy() {
  log "migrate-deploy"
  # Runs against the orchestrator's OWN image (this build) — additive,
  # idempotent. Migrations shipping WITH the new image are applied by the new
  # image's guarded boot entrypoint (scripts/migrate-and-start.sh, WARP-573).
  dc exec -T orchestrator npx prisma migrate deploy
}

cmd_recreate_services() {
  validate_update_id "$UPDATE_ID"
  validate_services "$SERVICES"
  validate_target "$TARGET"
  log "recreate-services [$SERVICES] target=$TARGET"
  local svc
  local IFS=','
  for svc in $SERVICES; do
    [ -z "$svc" ] && continue
    # --no-deps: recreate ONLY this service (its deps are already up);
    # --force-recreate + --pull never: use the image already pulled/pinned.
    dc up -d --no-deps --force-recreate "$svc"
  done
}

cmd_restore_configs() {
  validate_update_id "$UPDATE_ID"
  local pre="${DROPLET_OTA_UPDATES_DIR:-/data/updates}/$UPDATE_ID/backup/configs-pre-image.tar.gz"
  log "restore-configs $UPDATE_ID from $pre"
  if [ -f "$pre" ] || [ -n "$DRY_RUN" ]; then
    run tar -xzf "$pre" -C "$(config_root)"
  else
    die "no config backup to restore at $pre"
  fi
}

cmd_recreate_self_detached() {
  validate_update_id "$UPDATE_ID"
  validate_target "$TARGET"
  log "recreate-self-detached $UPDATE_ID target=$TARGET (launching detached helper)"
  # A detached helper container (docker:cli image, socket mounted) recreates
  # the orchestrator, waits on its container healthcheck, and on timeout rolls
  # every service back to the previous refs. It MUST outlive this process AND
  # the orchestrator's own recreation, so it runs as its own `docker run -d`
  # against the host daemon — not a compose service. The DB verdict is written
  # later by whichever orchestrator boots (resumeInterruptedApply).
  local helper_name="droplet-ota-self-swap-$UPDATE_ID"
  run docker run -d --rm \
    --name "$helper_name" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$COMPOSE_FILE:$COMPOSE_FILE:ro" \
    -e "DROPLET_OTA_TARGET=$TARGET" \
    -e "DROPLET_OTA_COMPOSE_FILE=$COMPOSE_FILE" \
    docker:27-cli \
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate orchestrator
}

# =============================================================================
# Arg parsing + dispatch
# =============================================================================

[ "$#" -ge 1 ] || die "usage: apply-update.sh <subcommand> --compose-file FILE [opts]"
SUBCOMMAND="$1"
shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --update-id) UPDATE_ID="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --configs-tar) CONFIGS_TAR="$2"; shift 2 ;;
    --images) shift; while [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; do IMAGES+=("$1"); shift; done ;;
    # A bare positional (restore-configs ID).
    --*) die "unknown flag: $1" ;;
    *) UPDATE_ID="$1"; shift ;;
  esac
done

case "$SUBCOMMAND" in
  current-image-refs) cmd_current_image_refs ;;
  snapshot) cmd_snapshot ;;
  pull-images) cmd_pull_images ;;
  stage-configs) cmd_stage_configs ;;
  migrate-deploy) cmd_migrate_deploy ;;
  recreate-services) cmd_recreate_services ;;
  restore-configs) cmd_restore_configs ;;
  recreate-self-detached) cmd_recreate_self_detached ;;
  *) die "unknown subcommand: $SUBCOMMAND" ;;
esac
