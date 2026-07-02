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
# ── PER-TARGET DIGEST PINNING (why recreates ride a compose OVERRIDE) ──
# The appliance compose file defines the first-party services (orchestrator,
# web-dashboard, …) as `build:`-only — NO `image:` key — so a bare
# `docker compose up --force-recreate <svc>` would reuse the LOCAL build and
# silently ignore the digests pull-images fetched: release-vs-previous would
# be a no-op. The orchestrator's snapshot step (host-compose-runner.ts)
# therefore generates, per update, under <updatesDir>/<updateId>/:
#
#   override-release.yml   — every DEPLOYED service pinned to its manifest
#                            digest ref;
#   override-previous.yml  — the same services pinned to the refs that were
#                            running (repo digest or local image ID);
#   services.txt           — the rollback walk order (one name per line,
#                            orchestrator LAST — swap-last both ways).
#
# Every recreate here runs `docker compose -f <base> -f <override>` with
# `--no-build --pull never`: the merge ADDS an `image:` key to each
# build:-only service, so compose recreates the container FROM the pinned
# ref that pull-images already fetched (release) or that is still present
# locally (previous). A missing override is a HARD ERROR — recreating
# unpinned is exactly the bug this contract exists to kill.
#
# ── SUBCOMMANDS (the ApplyRunner port contract) ──
#   current-image-refs  --services a,b,c
#       Print a JSON map {service: <running image ref or null>} for the box.
#   snapshot            --update-id ID --backup-dir DIR
#       Capture the host config tree pre-image + a schema-only pg_dump into
#       DIR (the runner has already written previous-refs.json, manifest.json
#       and the per-target overrides + services.txt one level up).
#   pull-images         --images REF [REF ...]
#       `docker pull` every pinned image ref (by digest).
#   stage-configs       --update-id ID --configs-tar PATH
#       Unpack the (already sha256-verified) configs tarball over the host
#       config tree; the pre-image lives in the backup dir from `snapshot`.
#   migrate-deploy
#       `prisma migrate deploy` for this build's migrations.
#   recreate-services   --update-id ID --services a,b --target release|previous
#       `docker compose -f <base> -f override-<target>.yml up -d --no-deps
#       --no-build --pull never --force-recreate` each named service — i.e.
#       ACTUALLY pinned to the release (manifest) or previous (backup) refs.
#   restore-configs     ID
#       Restore the backed-up host config tree (rollback step 8).
#   recreate-self-detached --update-id ID --target release|previous
#       Launch a DETACHED helper container (docker:27-cli, socket + compose
#       file + updates volume mounted) that: recreates the orchestrator
#       pinned to override-<target>.yml, waits BOUNDED on the recreated
#       container's healthcheck (DROPLET_OTA_SELF_HEALTH_ATTEMPTS ×
#       DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS, default 24 × 5s ≈ the TS
#       health-gate posture), and on timeout rolls EVERY service in
#       services.txt back to the previous refs — all OUTSIDE the orchestrator
#       process, so the swap (and its rollback) survive the orchestrator's
#       own recreation. The DB verdict is written by whichever orchestrator
#       boots next (resumeInterruptedApply).
#
# ── TEST / DRY-RUN HOOK ──
#   DROPLET_OTA_APPLY_DRY_RUN=1  — print each `docker`/`docker compose` command
#     it WOULD run (prefixed `DRY-RUN:`) instead of running it, and short-
#     circuit any daemon read (current-image-refs prints `{}`) and any
#     override/services-file existence check. Nothing on the box is touched.
#     Exercised by scripts/test/apply-update.test.sh, which also drives the
#     REAL paths through a PATH-shimmed fake `docker`.
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

validate_positive_int() {
  # $1 = flag name (for the error), $2 = value.
  case "$2" in
    '' | *[!0-9]*) die "invalid $1: $2 (expected a positive integer)" ;;
  esac
}

# --- update-dir layout (see the PER-TARGET DIGEST PINNING header note) -------

updates_dir() {
  printf '%s' "${DROPLET_OTA_UPDATES_DIR:-/data/updates}"
}

override_file() {
  # $1 = update id, $2 = target (release|previous).
  printf '%s/%s/override-%s.yml' "$(updates_dir)" "$1" "$2"
}

services_file() {
  printf '%s/%s/services.txt' "$(updates_dir)" "$1"
}

require_pin_file() {
  # A missing pin file is a HARD ERROR (never recreate unpinned) — except
  # under dry-run, where nothing is executed anyway.
  [ -f "$1" ] || [ -n "$DRY_RUN" ] || \
    die "missing $2: $1 (the orchestrator's snapshot step writes it)"
}

# --- docker compose wrappers ------------------------------------------------

dc() {
  [ -n "$COMPOSE_FILE" ] || die "--compose-file is required"
  run docker compose -f "$COMPOSE_FILE" "$@"
}

# Base compose + a per-target override — the ONLY way this script ever
# recreates a service, so nothing can come up unpinned.
dc_pinned() {
  local override="$1"
  shift
  [ -n "$COMPOSE_FILE" ] || die "--compose-file is required"
  run docker compose -f "$COMPOSE_FILE" -f "$override" "$@"
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
  local override
  override="$(override_file "$UPDATE_ID" "$TARGET")"
  require_pin_file "$override" "per-target override"
  log "recreate-services [$SERVICES] target=$TARGET override=$override"
  local svc
  local IFS=','
  for svc in $SERVICES; do
    [ -z "$svc" ] && continue
    # --no-deps: recreate ONLY this service (its deps are already up);
    # --no-build: NEVER fall back to the local build — the override's image:
    #   pin is the whole point (build:-only services would otherwise reuse
    #   whatever was built on the box and ignore the pulled digest);
    # --pull never: the release refs were pulled in step 2, the previous
    #   refs are already present — a pull here could only surprise us;
    # --force-recreate: swap even when compose thinks nothing changed.
    dc_pinned "$override" up -d --no-deps --no-build --pull never --force-recreate "$svc"
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

# The POSIX-sh supervisor program the detached self-swap helper container
# runs (docker:27-cli is Alpine/busybox — NO bash, so this must stay POSIX).
# Single-quoted ON PURPOSE: every $VAR expands INSIDE the helper from the
# `-e` environment the launch below pins, never in this shell. Behaviour:
#   1. recreate the orchestrator pinned to the target override;
#   2. wait BOUNDED on the recreated container's healthcheck;
#   3. healthy   → exit; the new orchestrator's resume hook commits;
#      timeout   → roll EVERY service in services.txt back to the previous
#                  refs; the resumed OLD orchestrator writes the verdict.
readonly SELF_SWAP_SUPERVISOR='
set -eu
say() { echo "[ota-self-swap] $*"; }
say "recreating the orchestrator (override: $DROPLET_OTA_TARGET_OVERRIDE)"
docker compose -f "$DROPLET_OTA_COMPOSE_FILE" -f "$DROPLET_OTA_TARGET_OVERRIDE" \
  up -d --no-deps --no-build --pull never --force-recreate orchestrator
attempt=0
while [ "$attempt" -lt "$DROPLET_OTA_SELF_HEALTH_ATTEMPTS" ]; do
  cid="$(docker compose -f "$DROPLET_OTA_COMPOSE_FILE" ps -q orchestrator 2>/dev/null || true)"
  if [ -n "$cid" ]; then
    health="$(docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}" "$cid" 2>/dev/null || echo unknown)"
    if [ "$health" = "healthy" ]; then
      say "orchestrator healthy on the recreated image — swap holds"
      exit 0
    fi
  fi
  attempt=$((attempt + 1))
  sleep "$DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS"
done
say "orchestrator never went healthy — rolling EVERY service back to the previous refs"
rc=0
while IFS= read -r svc; do
  [ -n "$svc" ] || continue
  say "rollback: recreating $svc on the previous ref"
  docker compose -f "$DROPLET_OTA_COMPOSE_FILE" -f "$DROPLET_OTA_PREVIOUS_OVERRIDE" \
    up -d --no-deps --no-build --pull never --force-recreate "$svc" || rc=1
done < "$DROPLET_OTA_SERVICES_FILE"
exit "$rc"
'

cmd_recreate_self_detached() {
  validate_update_id "$UPDATE_ID"
  validate_target "$TARGET"
  local attempts="${DROPLET_OTA_SELF_HEALTH_ATTEMPTS:-24}"
  local interval="${DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS:-5}"
  validate_positive_int "DROPLET_OTA_SELF_HEALTH_ATTEMPTS" "$attempts"
  validate_positive_int "DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS" "$interval"

  # The helper must be ABLE to roll back before it is allowed to swap:
  # refuse to launch without the target override, the previous override,
  # and the rollback services list.
  local target_override previous_override svc_file
  target_override="$(override_file "$UPDATE_ID" "$TARGET")"
  previous_override="$(override_file "$UPDATE_ID" previous)"
  svc_file="$(services_file "$UPDATE_ID")"
  require_pin_file "$target_override" "target override"
  require_pin_file "$previous_override" "previous override"
  require_pin_file "$svc_file" "rollback services list"

  # The helper outlives THIS container, so it cannot read the overrides
  # through our filesystem — it needs the updates volume mounted itself.
  # Resolve whatever backs $(updates_dir) on this container (named volume
  # preferred; bind-mount source as the fallback) via the socket.
  local updates_src="ota-updates"
  if [ -z "$DRY_RUN" ]; then
    local self_cid
    self_cid="$(run_capture docker compose -f "$COMPOSE_FILE" ps -q orchestrator)"
    [ -n "$self_cid" ] || die "cannot resolve the orchestrator's own container id"
    updates_src="$(run_capture docker inspect \
      --format '{{range .Mounts}}{{.Name}}|{{.Source}}|{{.Destination}}{{printf "\n"}}{{end}}' \
      "$self_cid" \
      | awk -F'|' -v dest="$(updates_dir)" \
          '$3 == dest { if ($1 != "") { print $1 } else { print $2 }; exit }')"
    [ -n "$updates_src" ] || die "cannot resolve the volume behind $(updates_dir)"
  fi

  log "recreate-self-detached $UPDATE_ID target=$TARGET (launching detached helper)"
  # A detached helper container (docker:cli image, socket mounted) runs the
  # SELF_SWAP_SUPERVISOR above. It MUST outlive this process AND the
  # orchestrator's own recreation, so it runs as its own `docker run -d`
  # against the host daemon — not a compose service. The DB verdict is
  # written later by whichever orchestrator boots (resumeInterruptedApply).
  local helper_name="droplet-ota-self-swap-$UPDATE_ID"
  run docker run -d --rm \
    --name "$helper_name" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$COMPOSE_FILE:$COMPOSE_FILE:ro" \
    -v "$updates_src:$(updates_dir):ro" \
    -e "DROPLET_OTA_COMPOSE_FILE=$COMPOSE_FILE" \
    -e "DROPLET_OTA_TARGET_OVERRIDE=$target_override" \
    -e "DROPLET_OTA_PREVIOUS_OVERRIDE=$previous_override" \
    -e "DROPLET_OTA_SERVICES_FILE=$svc_file" \
    -e "DROPLET_OTA_SELF_HEALTH_ATTEMPTS=$attempts" \
    -e "DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS=$interval" \
    docker:27-cli \
    /bin/sh -c "$SELF_SWAP_SUPERVISOR"
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
