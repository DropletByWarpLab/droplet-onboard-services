#!/usr/bin/env bash
# =============================================================================
# WARP-539 / WARP-3007 — OTA apply host helper
# =============================================================================
#
# The ONE executor behind the orchestrator's OTA apply path (WARP-539,
# apps/orchestrator/src/services/update-agent/host-compose-runner.ts). Every
# daemon operation the apply/rollback state machine needs is a FIXED
# subcommand here, invoked with an argv array (never a shell string), so a
# manifest field can never become a command.
#
# ── WHERE IT RUNS (WARP-3007) ──
# ON THE HOST, never inside the orchestrator. The orchestrator creates a
# one-shot container over its docker socket (host-exec.ts): its OWN image,
# pinned by image ID, `--network none`, `-v /:/host`, entrypoint
# `chroot /host`, argv `/bin/bash <this file> <subcommand> …`. So every
# `docker compose` below runs with the host's docker CLI and reads the host's
# `.env` — the orchestrator image has no docker CLI, and compose run inside it
# silently dropped every `env_file` (WARP-3007 a/b).
#
# WHY IT LIVES UNDER docker/: a release's configs.tar.gz is
# `git archive HEAD docker`, so this file ships inside every release
# (WARP-3007 c). Which copy runs:
#   * before stage-configs — the helper already installed on the box;
#   * from stage-configs on — the RELEASE's own helper (just unpacked);
#   * after a rollback's restore-configs — the PREVIOUS release's helper
#     (the pre-image brings it back); the self-swap rollback execs it.
# The subcommand surface is therefore a cross-version contract: an older
# orchestrator calls a newer helper. Add flags; never repurpose one.
#
# ── SECURITY POSTURE ──
# Host root. That is exactly what the orchestrator's docker socket already
# grants (docker/docker-compose.yml, orchestrator service ONLY); running here
# adds no capability, it only stops the compose CLI from running blind. The
# fence:
#   - only a cosign-verified (WARP-537) release whose configs.tar.gz sha256
#     matches the signed manifest (apply.ts) ever reaches this script;
#   - the subcommand surface is fixed — there is no passthrough `docker`;
#   - --services values are validated to be a comma list of compose service
#     names; --target is one of {release,previous} (+ grow for
#     recreate-services); nothing is eval'd;
#   - the one-shot container has no network. The only networked step is
#     pull-images' cosign verify (a nested `docker run --rm` of the same
#     pinned image, WARP-244), which must reach ghcr.io exactly as it did
#     from inside the orchestrator.
# Security review of the host-execution model: WARP-2924.
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
# ── ENVIRONMENT (set by host-exec.ts, explicit allowlist) ──
#   DROPLET_OTA_UPDATES_DIR   HOST path of the orchestrator's ota-updates
#                             volume (default /data/updates for tests).
#   DROPLET_OTA_CONFIG_ROOT   repo root (default: two levels above compose).
#   DROPLET_OTA_HOST_IMAGE    the pinned image the one-shot runs off; reused
#                             for the detached self-swap and for cosign.
#   DROPLET_OTA_GITHUB_TOKEN  pull-images only (private GHCR, pre-GA).
#   DROPLET_OTA_SELF_HEALTH_{ATTEMPTS,INTERVAL_SECONDS}  self-swap wait.
#
# ── SUBCOMMANDS (the ApplyRunner port contract) ──
#   current-image-refs  --services a,b,c
#       Print a JSON map {service: <running image ref or null>} for the box.
#   snapshot            --update-id ID --backup-dir DIR
#       Capture the host config tree pre-image + a schema-only pg_dump into
#       DIR (the runner has already written previous-refs.json, manifest.json
#       and the per-target overrides + services.txt one level up).
#   pull-images         --images REF [REF ...]
#       cosign-verify, then `docker pull`, every pinned image ref (by digest).
#   stage-configs       --update-id ID --configs-tar PATH
#       Unpack the (already sha256-verified) configs tarball over the host
#       config tree; the pre-image lives in the backup dir from `snapshot`.
#   migrate-deploy
#       `prisma migrate deploy` for this build's migrations.
#   recreate-services   --update-id ID --services a,b --target release|previous
#       `docker compose -f <base> -f override-<target>.yml up -d --no-deps
#       --no-build --pull never --force-recreate` each named service — i.e.
#       ACTUALLY pinned to the release (manifest) or previous (backup) refs.
#   recreate-services   ... --target grow
#       WARP-2970: the same loop pinned to override-grow.yml — post-commit,
#       starts release services this box enables but has no container for.
#       A service that HAS a container (even a stopped one: an operator's
#       `docker stop`) is skipped, never recreated; stdout then also carries
#       {"failed":[…],"skipped":[…]}.
#   enabled-services   [--profiles a,b]
#       `docker compose config --services`: the services the staged compose
#       file enables, one per line. WARP-2995: --profiles is the box's real
#       COMPOSE_PROFILES (from the reconcile-env report), passed as explicit
#       --profile flags plus a match-nothing sentinel.
#   reconcile-env       --update-id ID [--image REF]
#       WARP-2995: run the staged docker/ota/env-reconcile.sh (we are already
#       on the host). Additive, idempotent .env backfill + boot-unit profile
#       flags. Its one-line JSON report (key NAMES only) is printed and kept
#       as <updatesDir>/<ID>/env-reconcile.json. --image is accepted for
#       older callers and ignored.
#   restore-configs     ID
#       Restore the backed-up host config tree (rollback step 8).
#   recreate-self-detached --update-id ID --target release|previous
#       Launch a DETACHED supervisor container (DROPLET_OTA_HOST_IMAGE,
#       `chroot /host`, no network) running `self-swap-supervise`, then
#       return. It outlives the orchestrator's own recreation.
#   self-swap-supervise --update-id ID --target release|previous
#       (the detached container's program; never called by the
#       orchestrator directly) recreates the orchestrator pinned to
#       override-<target>.yml, waits BOUNDED on its container healthcheck
#       (DROPLET_OTA_SELF_HEALTH_ATTEMPTS × _INTERVAL_SECONDS, default
#       60 × 5 s — the new orchestrator's boot runs the guarded migrations
#       first), and on timeout restores the config pre-image (release target)
#       and execs the RESTORED helper's `recreate-services --target previous`
#       over services.txt. The DB verdict is written by whichever
#       orchestrator boots next (resumeInterruptedApply).
#   list-self-swap-helpers
#       Print one {"name","status","finishedAt"} JSON object per line for
#       every droplet-ota-self-swap-* helper container, running or exited
#       (WARP-1044 — the GC's read surface).
#   capture-self-swap-logs --update-id ID
#       Persist `docker logs` of the self-swap helper for ID into
#       <updatesDir>/<ID>/self-swap-helper.log — the WARP-1044 GC captures
#       BEFORE it removes, because the kept container was the only log store.
#   rm-self-swap-helper --update-id ID
#       `docker rm` (deliberately never -f) the self-swap helper container
#       for ID; the daemon itself refuses a still-running helper.
#   nc-transfer-ownership --from UID --to UID
#       WARP-3169 leaver hand-over: `occ files:transfer-ownership` inside the
#       nextcloud container, as www-data, bounded by `timeout`. Both ids are
#       checked against a strict subset of the Nextcloud user-id charset
#       ([A-Za-z0-9_.@-], never a leading `-`, at most 64) and confirmed to
#       exist (`occ user:info`) first; `--` ends occ's options so an id can
#       never be read as a flag. The only caller is the orchestrator's
#       Delete-with-hand-over path, after its own recipient checks.
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

# ── WARP-244: pull-time image signature verification ─────────────────────────
# Only images keyless-signed by THIS repo's publish-release workflow, running
# on a RELEASE BRANCH, may be pulled. cosign fetches the signature bundle from
# ghcr.io (the same
# registry the pull itself needs) and verifies it OFFLINE against the trust
# root embedded in the vendored, checksum-pinned binary (orchestrator
# Dockerfile, WARP-537) — no Rekor/TUF egress at verify time.
#
# FAIL CLOSED, and deliberately NO bypass env: the rollback path recreates
# with `--pull never` from images already on the box, so a refusal can only
# block an UPDATE, never the running stack. Break-glass is a human with host
# access pulling manually (docs/SECURITY.md). The canonical "image-verify:"
# stderr prefix is load-bearing: apply.ts classifies it as
# rejected/image_signature_failed instead of retrying.
# WARP-1670 — main (stable) and stage (stage channel) are BOTH legitimate
# publishers, so the identity accepts either. Written as an explicit
# two-branch alternation, never `refs/heads/.*`: this regexp is the whole
# supply-chain gate in front of `docker pull`, and a wildcard would let any
# pushed branch mint images the box will trust. Adding a channel means
# adding its branch here, on purpose, in a reviewed diff.
COSIGN_IDENTITY_REGEXP='^https://github\.com/DropletByWarpLab/droplet-onboard-services/\.github/workflows/publish-release\.yml@refs/heads/(main|stage)$'
COSIGN_OIDC_ISSUER='https://token.actions.githubusercontent.com'

# Ephemeral registry auth for BOTH cosign (in-process HTTPS to ghcr.io) and
# `docker pull` (the CLI forwards credentials from DOCKER_CONFIG to the
# daemon per pull): GHCR packages are private pre-GA. No token env → no-op
# (anonymous works if/when the packages go public).
REGISTRY_AUTH_DIR=""
cleanup_registry_auth() {
  [ -n "$REGISTRY_AUTH_DIR" ] && rm -rf "$REGISTRY_AUTH_DIR"
}
setup_registry_auth() {
  [ -n "${DROPLET_OTA_GITHUB_TOKEN:-}" ] || return 0
  REGISTRY_AUTH_DIR="$(mktemp -d)"
  chmod 0700 "$REGISTRY_AUTH_DIR"
  trap cleanup_registry_auth EXIT
  printf '{"auths":{"ghcr.io":{"auth":"%s"}}}\n' \
    "$(printf 'x-access-token:%s' "$DROPLET_OTA_GITHUB_TOKEN" | base64 | tr -d '\n')" \
    > "$REGISTRY_AUTH_DIR/config.json"
  chmod 0600 "$REGISTRY_AUTH_DIR/config.json"
  export DOCKER_CONFIG="$REGISTRY_AUTH_DIR"
}

# The cosign argv prefix. The host has no cosign; the orchestrator image
# vendors a checksum-pinned one (WARP-537), so run THAT in a throwaway
# container off the same pinned image. It is the one networked step (the
# signature bundle lives on ghcr.io). DROPLET_COSIGN_BIN (tests, dev) runs a
# local binary instead.
COSIGN=()
cosign_cmd() {
  if [ -n "${DROPLET_COSIGN_BIN:-}" ]; then
    COSIGN=("$DROPLET_COSIGN_BIN")
    return 0
  fi
  host_image
  COSIGN=(docker run --rm --entrypoint /usr/local/bin/cosign)
  if [ -n "$REGISTRY_AUTH_DIR" ]; then
    COSIGN+=(-v "$REGISTRY_AUTH_DIR:/ota-registry-auth:ro" -e DOCKER_CONFIG=/ota-registry-auth)
  fi
  COSIGN+=("$HOST_IMAGE")
}

verify_image_signature() {
  local img="$1"
  log "verify $img"
  # Under dry-run the `run` helper only PRINTS the command it would execute
  # (to stdout, prefixed DRY-RUN:) — keep that line visible. On the real
  # path cosign's verification bundle (JSON) is noise, so drop its stdout.
  if [ -n "$DRY_RUN" ]; then
    run "${COSIGN[@]}" verify \
      --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
      --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
      --offline=true \
      "$img"
    return 0
  fi
  if ! run "${COSIGN[@]}" verify \
      --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
      --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
      --offline=true \
      "$img" >/dev/null; then
    die "image-verify: cosign rejected $img — only images signed by the publish-release workflow may be pulled (WARP-244, docs/SECURITY.md)"
  fi
}

# The image the host-exec one-shot runs off (host-exec.ts pins it by image
# ID). The detached self-swap and the cosign container reuse it, so nothing
# here ever pulls an unpinned image (the old supervisor pulled docker:27-cli).
HOST_IMAGE=""
host_image() {
  HOST_IMAGE="${DROPLET_OTA_HOST_IMAGE:-}"
  [ -n "$HOST_IMAGE" ] || die "DROPLET_OTA_HOST_IMAGE is not set (host-exec.ts pins it)"
  case "$HOST_IMAGE" in
    *[!A-Za-z0-9._:@/-]*) die "invalid DROPLET_OTA_HOST_IMAGE: $HOST_IMAGE" ;;
  esac
}

COMPOSE_FILE=""
UPDATE_ID=""
BACKUP_DIR=""
SERVICES=""
TARGET=""
CONFIGS_TAR=""
IMAGES=()
IMAGE=""
PROFILES=""
PROFILES_SET=
NC_FROM=""
NC_TO=""

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

validate_profiles() {
  # Comma list of compose profile names; empty is valid (no profiles).
  case "$1" in
    *[!a-z0-9,_-]*) die "invalid --profiles value: $1" ;;
  esac
}

validate_image_ref() {
  # One digest-pinned registry ref, the shape the signed manifest carries.
  case "$1" in
    *@sha256:*) : ;;
    *) die "invalid --image: $1 (expected a digest-pinned ref)" ;;
  esac
  case "$1" in
    *[!A-Za-z0-9._:@/-]*) die "invalid --image: $1" ;;
  esac
}

validate_nc_user() {
  # $1 = flag name (for the error), $2 = value. A strict subset of the
  # Nextcloud user-id charset: no space or quote (both legal in Nextcloud),
  # never a leading `-` (it would read as an occ option), at most 64 chars.
  case "$2" in
    '' | -* | *[!A-Za-z0-9_.@-]*) die "invalid $1: $2" ;;
  esac
  [ "${#2}" -le 64 ] || die "invalid $1: too long"
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

# Resolve the image ref a running container should be PINNED to for rollback.
# imageRefMatchesDigest (apply.ts) compares this against the manifest's
# `sha256:<hex>` digest, so it MUST resolve to a registry digest — NOT the
# local image ID `{{index .Image}}` reports, which never equals a release
# digest and would make every successful self-swap look like "still on the
# old image" (bogus rollback) or let a real sabotage go undetected.
#
# Order of preference:
#   1. a RepoDigest (`repo@sha256:<hex>`) — the pinned registry ref. When the
#      image carries SEVERAL RepoDigests (multiple tags/mirrors of the same
#      pushed image) any of them is a valid pin; we take the first, and its
#      `@sha256:` matches the manifest digest via imageRefMatchesDigest.
#   2. the local image ID (`sha256:<hex>` from `.Id`) — the DOCUMENTED
#      fallback for a locally-built, never-pushed image with ZERO RepoDigests.
#      This never matches a release digest (by design — that IS the resume
#      signal), but it is still the correct `previous`-target rollback pin.
image_ref_for_cid() {
  # $1 = container id. Prints the RepoDigest ref, else the image ID, else "".
  local cid="$1" repo_digests image_id
  # First RepoDigest, if any (newline-joined; take the first non-empty line).
  repo_digests="$(run_capture docker inspect \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' "$cid")"
  local ref
  ref="$(printf '%s\n' "$repo_digests" | awk 'NF { print; exit }')"
  if [ -n "$ref" ]; then
    printf '%s' "$ref"
    return 0
  fi
  # Zero RepoDigests → locally-built, never-pushed: fall back to the image ID.
  image_id="$(run_capture docker inspect --format '{{.Id}}' "$cid")"
  printf '%s' "$image_id"
}

cmd_current_image_refs() {
  validate_services "$SERVICES"
  if [ -n "$DRY_RUN" ]; then
    printf '{}\n'
    return 0
  fi
  # Build a JSON object mapping each service to the image ref its running
  # container reports (registry RepoDigest when pulled/pushed, image ID for a
  # locally-built image), or null when the service has no running container.
  local first=1
  printf '{'
  local svc cid ref
  local IFS=','
  for svc in $SERVICES; do
    [ -z "$svc" ] && continue
    cid="$(run_capture docker compose -f "$COMPOSE_FILE" ps -q "$svc")"
    if [ -n "$cid" ]; then
      ref="$(image_ref_for_cid "$cid")"
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
  # Scoped to the config subdir so the pre-image mirrors the layout of the
  # release's own configs.tar.gz — restore-configs untars either one into
  # config_root and gets the same tree back (WARP-1669).
  run tar -czf "$BACKUP_DIR/configs-pre-image.tar.gz" \
    -C "$(config_root)" "$(config_subdir)"
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

# Where the host config tree that stage-configs overwrites lives.
#
# WARP-1669: this is the REPO ROOT, not the compose file's own directory.
# CI packs configs with `git archive HEAD docker` (publish-release.yml), so
# every entry in configs.tar.gz is prefixed `docker/`. Extracting that into
# the compose dir — the old default — produced `…/docker/docker/…` on every
# deployment, silently: tar happily creates the nested tree and the running
# stack keeps reading the real one, so the update looks applied and changes
# nothing.
#
# DROPLET_OTA_CONFIG_ROOT still overrides for layouts that don't put the
# compose file one level below the packed root.
config_root() {
  printf '%s' "${DROPLET_OTA_CONFIG_ROOT:-$(dirname "$(dirname "$COMPOSE_FILE")")}"
}

# The single subdirectory of config_root that a release's configs.tar.gz
# owns — `docker`, matching what CI packs. Snapshot/restore are scoped to
# it: `tar -C "$(config_root)" .` would otherwise pack the ENTIRE repo
# (node_modules, data/, every volume-backed file under it) into a backup
# taken on the critical path of every update.
config_subdir() {
  printf '%s' "$(basename "$(dirname "$COMPOSE_FILE")")"
}

cmd_pull_images() {
  [ "${#IMAGES[@]}" -gt 0 ] || die "pull-images needs at least one --images REF"
  setup_registry_auth
  cosign_cmd
  local img
  for img in "${IMAGES[@]}"; do
    # WARP-244: verify-then-pull. The ref is digest-pinned (manifest schema
    # enforces …@sha256:<64hex>), so the verified ref and the pulled bytes
    # are the same content by construction.
    verify_image_signature "$img"
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
  # `grow` (WARP-2970) is recreate-services-only: never a self-swap target.
  [ "$TARGET" = "grow" ] || validate_target "$TARGET"
  local override
  override="$(override_file "$UPDATE_ID" "$TARGET")"
  require_pin_file "$override" "per-target override"
  log "recreate-services [$SERVICES] target=$TARGET override=$override"
  # Capture failures PER SERVICE instead of aborting the loop on the first
  # one. Under `set -e` a single failing `docker compose up` would abort here,
  # leaving the services BEFORE it on the new digest and the ones AFTER it on
  # the old digest — an unobservable mixed-version state. Instead we attempt
  # EVERY service, collect the ones that failed, and return the list to the
  # caller (JSON on stdout + non-zero exit) so the outcome is actionable.
  local svc rc=0
  local failed=() skipped=()
  local IFS=','
  for svc in $SERVICES; do
    [ -z "$svc" ] && continue
    # grow starts only a service that has NEVER had a container here. The
    # orchestrator's "not running" (current-image-refs, `ps -q`) also covers
    # a container someone stopped on purpose; `ps -a -q` tells them apart.
    if [ "$TARGET" = "grow" ] && \
       [ -n "$(run_capture docker compose -f "$COMPOSE_FILE" ps -a -q "$svc")" ]; then
      log "grow: $svc already has a container (stopped?) — leaving it as it is"
      skipped+=("$svc")
      continue
    fi
    # --no-deps: recreate ONLY this service (its deps are already up);
    # --no-build: NEVER fall back to the local build — the override's image:
    #   pin is the whole point (build:-only services would otherwise reuse
    #   whatever was built on the box and ignore the pulled digest);
    # --pull never: the release refs were pulled in step 2, the previous
    #   refs are already present — a pull here could only surprise us;
    # --force-recreate: swap even when compose thinks nothing changed.
    # `|| { … }` keeps a failing recreate from tripping `set -e` so the loop
    # walks every remaining service before we report.
    if ! dc_pinned "$override" up -d --no-deps --no-build --pull never --force-recreate "$svc"; then
      log "recreate FAILED for $svc (target=$TARGET) — continuing to the next service"
      failed+=("$svc")
      rc=1
    fi
  done
  # Structured, observable outcome: {"failed":["svcA",…]} on stdout. The
  # runner (host-compose-runner.ts) parses this and surfaces a typed error
  # naming the services that did not swap, instead of a bare mid-loop abort.
  unset IFS
  local joined=""
  local f
  for f in ${failed[@]+"${failed[@]}"}; do
    [ -z "$joined" ] && joined="\"$f\"" || joined="$joined,\"$f\""
  done
  if [ "$TARGET" = "grow" ]; then
    local sk=""
    for f in ${skipped[@]+"${skipped[@]}"}; do
      [ -z "$sk" ] && sk="\"$f\"" || sk="$sk,\"$f\""
    done
    printf '{"failed":[%s],"skipped":[%s]}\n' "$joined" "$sk"
  else
    printf '{"failed":[%s]}\n' "$joined"
  fi
  return "$rc"
}

# WARP-2970 — read-only. Lets the post-commit step tell "not running because
# its profile is off here" from "not running because it is new to the default
# set". Fails loudly (non-zero) rather than printing an empty set.
cmd_enabled_services() {
  local flags=()
  if [ -n "$PROFILES_SET" ]; then
    validate_profiles "$PROFILES"
    # The sentinel makes "no profiles" explicit too: a --profile flag always
    # beats COMPOSE_PROFILES from this container's environment.
    flags=(--profile droplet-ota-no-profile)
    local p
    local IFS=','
    for p in $PROFILES; do [ -n "$p" ] && flags+=(--profile "$p"); done
    unset IFS
  fi
  [ -n "$DRY_RUN" ] && { run docker compose -f "$COMPOSE_FILE" ${flags[@]+"${flags[@]}"} config --services; return 0; }
  dc ${flags[@]+"${flags[@]}"} config --services
}

# WARP-2995 — the host-side .env reconcile. The script comes from the STAGED
# config tree (stage-configs already unpacked this release's docker/), so the
# release that needs a key ships the code that adds it. This helper already
# runs on the host (WARP-3007), so it just runs it — no nested container.
# Fails loudly: apply.ts refuses the update (before any swap) on non-zero.
cmd_reconcile_env() {
  validate_update_id "$UPDATE_ID"
  # --image is what an older orchestrator passes; still refuse a bad one.
  [ -z "$IMAGE" ] || validate_image_ref "$IMAGE"
  local root report
  root="$(config_root)"
  report="$(updates_dir)/$UPDATE_ID/env-reconcile.json"
  log "reconcile-env $UPDATE_ID (host .env under $root)"
  if [ -n "$DRY_RUN" ]; then
    run /bin/sh "$root/docker/ota/env-reconcile.sh" "$root" "$UPDATE_ID"
    return 0
  fi
  local out
  out="$(/bin/sh "$root/docker/ota/env-reconcile.sh" "$root" "$UPDATE_ID")" \
    || die "env-reconcile failed on the host for $UPDATE_ID"
  mkdir -p "$(dirname "$report")"
  printf '%s\n' "$out" > "$report"
  printf '%s\n' "$out"
}

cmd_restore_configs() {
  validate_update_id "$UPDATE_ID"
  local pre="${DROPLET_OTA_UPDATES_DIR:-/data/updates}/$UPDATE_ID/backup/configs-pre-image.tar.gz"
  log "restore-configs $UPDATE_ID from $pre"
  # WARP-2995 (#2320 review): undo this update's .env + boot-unit changes
  # FIRST, with the release's own env-reconcile.sh (it made the backups, and
  # the pre-image unpacked below may carry an older copy). No backups → no-op.
  # A failure is logged, not fatal: the config + image rollback matter more.
  local reconcile
  reconcile="$(config_root)/docker/ota/env-reconcile.sh"
  if [ -f "$reconcile" ] || [ -n "$DRY_RUN" ]; then
    run /bin/sh "$reconcile" --restore "$(config_root)" "$UPDATE_ID" >&2 \
      || log "restore-configs: .env / boot-unit restore FAILED for $UPDATE_ID — continuing"
  fi
  if [ -f "$pre" ] || [ -n "$DRY_RUN" ]; then
    run tar -xzf "$pre" -C "$(config_root)"
  else
    die "no config backup to restore at $pre"
  fi
}

# Self-swap bounded-wait knobs. 60 × 5 s by default (WARP-3017): the
# recreated orchestrator runs the WARP-573 guarded migrations (with a
# pre-migrate pg_dump) before it can listen, and its container healthcheck
# only flips to healthy after it listens.
self_health_knobs() {
  SELF_ATTEMPTS="${DROPLET_OTA_SELF_HEALTH_ATTEMPTS:-60}"
  SELF_INTERVAL="${DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS:-5}"
  validate_positive_int "DROPLET_OTA_SELF_HEALTH_ATTEMPTS" "$SELF_ATTEMPTS"
  validate_positive_int "DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS" "$SELF_INTERVAL"
}

# The helper must be ABLE to roll back before it is allowed to swap: refuse
# without the target override, the previous override and services.txt.
require_self_swap_material() {
  require_pin_file "$(override_file "$UPDATE_ID" "$TARGET")" "target override"
  require_pin_file "$(override_file "$UPDATE_ID" previous)" "previous override"
  require_pin_file "$(services_file "$UPDATE_ID")" "rollback services list"
}

cmd_recreate_self_detached() {
  validate_update_id "$UPDATE_ID"
  validate_target "$TARGET"
  self_health_knobs
  require_self_swap_material
  host_image

  # This file's own HOST path — the supervisor runs the same subcommand
  # surface. For target=release that is the staged release helper.
  local self
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

  log "recreate-self-detached $UPDATE_ID target=$TARGET (launching detached supervisor)"
  local helper_name="droplet-ota-self-swap-$UPDATE_ID"

  # Collision guard: a retried apply for the SAME update id would hit a name
  # clash on the still-present (see below) previous helper. Remove any prior
  # helper of this name first — force so a stuck one doesn't block the retry.
  # Best-effort: no prior helper is the normal case.
  run_capture docker rm -f "$helper_name"

  # NOTE: intentionally NOT `--rm`. On an unattended fleet the helper's own
  # logs are the ONLY forensic trail if the ROLLBACK itself fails. Helpers
  # from OLDER update ids are GC'd by the orchestrator's daily purge cron once
  # past backup retention, logs captured first (WARP-1044,
  # purge-self-swap-helpers.ts).
  #
  # WARP-3007: the supervisor runs ON THE HOST like this one-shot does —
  # `chroot /host` off the same pinned image, no network — so its compose
  # calls read the host .env, and the host path of the updates volume is just
  # a path (no mount resolution, no docker:cli image to pull).
  run docker run -d \
    --name "$helper_name" \
    --network none \
    --user 0:0 \
    --entrypoint chroot \
    -v /:/host \
    -e "DROPLET_OTA_UPDATES_DIR=$(updates_dir)" \
    -e "DROPLET_OTA_CONFIG_ROOT=$(config_root)" \
    -e "DROPLET_OTA_HOST_IMAGE=$HOST_IMAGE" \
    -e "DROPLET_OTA_SELF_HEALTH_ATTEMPTS=$SELF_ATTEMPTS" \
    -e "DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS=$SELF_INTERVAL" \
    "$HOST_IMAGE" \
    /host /bin/bash "$self" self-swap-supervise \
    --compose-file "$COMPOSE_FILE" --update-id "$UPDATE_ID" --target "$TARGET"
}

# The detached supervisor's program (never called by the orchestrator):
#   1. recreate the orchestrator pinned to the target override;
#   2. wait BOUNDED on the recreated container's healthcheck;
#   3. healthy → exit; the new orchestrator's resume hook commits;
#      timeout → restore the config pre-image (release target — a previous
#      target was already restored by the resume that launched us), then
#      exec the RESTORED helper's recreate-services --target previous over
#      services.txt: the rollback runs with the previous release's own code.
cmd_self_swap_supervise() {
  validate_update_id "$UPDATE_ID"
  validate_target "$TARGET"
  self_health_knobs
  require_self_swap_material
  local self
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

  log "self-swap: recreating the orchestrator (target=$TARGET)"
  if dc_pinned "$(override_file "$UPDATE_ID" "$TARGET")" \
      up -d --no-deps --no-build --pull never --force-recreate orchestrator; then
    local attempt=0 cid health
    while [ "$attempt" -lt "$SELF_ATTEMPTS" ]; do
      cid="$(run_capture docker compose -f "$COMPOSE_FILE" ps -q orchestrator)"
      if [ -n "$cid" ]; then
        health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$cid" 2>/dev/null || echo unknown)"
        if [ "$health" = "healthy" ]; then
          log "self-swap: orchestrator healthy on the $TARGET image — swap holds"
          return 0
        fi
      fi
      attempt=$((attempt + 1))
      sleep "$SELF_INTERVAL"
    done
    log "self-swap: orchestrator never went healthy — rolling EVERY service back"
  else
    log "self-swap: recreating the orchestrator failed — rolling EVERY service back"
  fi
  # A failed restore must not stop the image rollback (die exits, hence the
  # subshell): previous images on the release configs beat a half-swapped box.
  if [ "$TARGET" = "release" ]; then
    ( cmd_restore_configs ) || log "self-swap: config restore FAILED — rolling images back anyway"
  fi
  local csv
  csv="$(awk 'NF { printf "%s%s", sep, $1; sep = "," }' "$(services_file "$UPDATE_ID")")"
  # exec: the restored file is read fresh (tar replaced the inode we run from).
  exec bash "$self" recreate-services --compose-file "$COMPOSE_FILE" \
    --update-id "$UPDATE_ID" --services "$csv" --target previous
}

# ── WARP-1044: GC surface for exited self-swap helper containers ─────────────
# The helper above launches WITHOUT --rm and the collision guard only reaps
# the previous helper for the SAME update id — so every applied update leaves
# one exited droplet-ota-self-swap-<id> container behind forever. The
# orchestrator's daily purge cron (purge-self-swap-helpers.ts) drives the
# three subcommands below to remove helpers past the backup-retention window,
# capturing their logs into the update's state dir first. ALL decision logic
# (retention window, running / in-flight-update exclusions, skip-if-already-
# captured) lives in the TS caller — this surface stays fixed and dumb, same
# posture as every other subcommand here.

cmd_list_self_swap_helpers() {
  # Read-only: one {"name":…,"status":…,"finishedAt":…} JSON object per line
  # for EVERY droplet-ota-self-swap-* container, running or exited. The
  # {{json …}} template functions guarantee valid JSON whatever the daemon
  # reports.
  if [ -n "$DRY_RUN" ]; then
    run docker ps -a --filter name=droplet-ota-self-swap- --format '{{.ID}}'
    return 0
  fi
  local ids
  ids="$(docker ps -a --filter name=droplet-ota-self-swap- --format '{{.ID}}' 2>/dev/null || true)"
  [ -n "$ids" ] || return 0
  # A container vanishing between ps and inspect (manual rm mid-sweep) must
  # not fail the listing — inspect still prints the ones it found. $ids is
  # unquoted ON PURPOSE: a newline list of daemon-issued hex ids to split.
  # shellcheck disable=SC2086
  docker inspect \
    --format '{"name":{{json .Name}},"status":{{json .State.Status}},"finishedAt":{{json .State.FinishedAt}}}' \
    $ids || true
}

cmd_capture_self_swap_logs() {
  validate_update_id "$UPDATE_ID"
  local name="droplet-ota-self-swap-$UPDATE_ID"
  local dir logfile
  dir="$(updates_dir)/$UPDATE_ID"
  logfile="$dir/self-swap-helper.log"
  log "capture-self-swap-logs $name -> $logfile"
  if [ -n "$DRY_RUN" ]; then
    run docker logs "$name"
    return 0
  fi
  mkdir -p "$dir"
  # Both streams — the supervisor's `say` lines ride stdout, compose noise
  # rides stderr, and a post-mortem wants both. Atomic (tmp + mv): an
  # EXISTING self-swap-helper.log tells the GC caller the capture is done,
  # so a failed `docker logs` (daemon hiccup) must leave nothing behind —
  # a poisoned partial file would skip the real capture forever.
  if docker logs "$name" > "$logfile.tmp" 2>&1; then
    mv "$logfile.tmp" "$logfile"
  else
    rm -f "$logfile.tmp"
    die "docker logs $name failed — nothing persisted, capture left for the next sweep"
  fi
}

cmd_rm_self_swap_helper() {
  validate_update_id "$UPDATE_ID"
  local name="droplet-ota-self-swap-$UPDATE_ID"
  log "rm-self-swap-helper $name"
  # Deliberately NOT `rm -f`: the daemon refuses to remove a RUNNING
  # container, so even if a helper for this id relaunched between the
  # caller's listing and this removal, an in-flight swap/rollback can never
  # be killed from here.
  run docker rm "$name"
}

# --- WARP-3169: leaver hand-over --------------------------------------------

# Seconds the transfer may run inside the container. The orchestrator's own
# exec timeout sits a little above this, so the in-container `timeout` is what
# normally fires.
NC_TRANSFER_TIMEOUT_SECONDS="${DROPLET_NC_TRANSFER_TIMEOUT_SECONDS:-600}"

occ() {
  dc exec -T -u www-data nextcloud "$@"
}

nc_user_exists() {
  [ -n "$DRY_RUN" ] && return 0
  occ php occ user:info --output=json -- "$1" >/dev/null 2>&1
}

cmd_nc_transfer_ownership() {
  validate_nc_user --from "$NC_FROM"
  validate_nc_user --to "$NC_TO"
  validate_positive_int DROPLET_NC_TRANSFER_TIMEOUT_SECONDS "$NC_TRANSFER_TIMEOUT_SECONDS"
  [ "$NC_FROM" != "$NC_TO" ] || die "--from and --to are the same user"
  nc_user_exists "$NC_FROM" || die "unknown Nextcloud user: $NC_FROM"
  nc_user_exists "$NC_TO" || die "unknown Nextcloud user: $NC_TO"
  log "nc-transfer-ownership $NC_FROM -> $NC_TO"
  occ timeout "$NC_TRANSFER_TIMEOUT_SECONDS" \
    php occ files:transfer-ownership -- "$NC_FROM" "$NC_TO"
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
    --image) IMAGE="$2"; shift 2 ;;
    --profiles) PROFILES="$2"; PROFILES_SET=1; shift 2 ;;
    --from) NC_FROM="${2-}"; shift 2 || die "--from needs a value" ;;
    --to) NC_TO="${2-}"; shift 2 || die "--to needs a value" ;;
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
  enabled-services) cmd_enabled_services ;;
  reconcile-env) cmd_reconcile_env ;;
  restore-configs) cmd_restore_configs ;;
  recreate-self-detached) cmd_recreate_self_detached ;;
  self-swap-supervise) cmd_self_swap_supervise ;;
  list-self-swap-helpers) cmd_list_self_swap_helpers ;;
  capture-self-swap-logs) cmd_capture_self_swap_logs ;;
  rm-self-swap-helper) cmd_rm_self_swap_helper ;;
  nc-transfer-ownership) cmd_nc_transfer_ownership ;;
  *) die "unknown subcommand: $SUBCOMMAND" ;;
esac
