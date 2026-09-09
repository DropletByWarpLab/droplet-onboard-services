#!/usr/bin/env bash
# =============================================================================
# Stage a client installer ON A BOX and make /downloads actually serve it.
# =============================================================================
#
# Wrapper around stage.mjs for the one place staging has to work: a running
# appliance. It adds the three things a bare `node stage.mjs` cannot do there.
#
#   1. NODE MAY NOT EXIST ON THE HOST. setup.sh installs Docker, not Node —
#      every Node service on the box runs inside a container. So when the host
#      has no `node`, this runs the same script inside the orchestrator's own
#      image, which is already on the box. No download, no new dependency,
#      nothing that needs the internet: an air-gapped box can stage.
#
#   2. THE ORCHESTRATOR MEMOISES THE CATALOG. `store.ts` reads catalog.json
#      once per process, deliberately — the staging dir is a read-only mount
#      that "cannot change under a running container". Staging changes it
#      anyway, so without a restart the new installer is on disk and invisible
#      at /downloads, which looks exactly like the staging having failed.
#
#   3. THE MOUNT IS THE THING THAT MATTERS. Writing the host directory proves
#      nothing about what the container sees. The verify step reads
#      catalog.json back out of the RUNNING orchestrator and compares it byte
#      for byte with the host copy.
#
# Usage (from the repo root on the box):
#   ./scripts/app-downloads/stage.sh ~/Droplet_0.2.0_x64-setup.exe
#   ./scripts/app-downloads/stage.sh --min-os "Windows 10 (1809) or newer" <file>
#   ./scripts/app-downloads/stage.sh --no-restart <file>     # stage, restart later
#   ./scripts/app-downloads/stage.sh --verify-only           # is it still intact?
#
# Every other flag is passed straight through to stage.mjs (--platform,
# --version, --note, --store-url, --keep-existing, --dry-run). The staging root
# is NOT configurable here on purpose: it must be the directory docker-compose
# bind-mounts at /opt/droplet/app-downloads, or the box serves a different
# directory than the one you staged into.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAGE_ROOT="$REPO_ROOT/data/app-downloads"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker/docker-compose.yml}"
PROJECT="${COMPOSE_PROJECT_NAME:-droplet}"
ENVFILE="${ENVFILE:-$REPO_ROOT/.env}"
SERVICE="orchestrator"
# Container path from docker-compose.yml's bind mount. If that mount is ever
# repointed, this has to move with it.
CONTAINER_STAGE="/opt/droplet/app-downloads"

RESTART=1
VERIFY_ONLY=0
FLAGS=()
FILES=()

log()  { printf "stage.sh: %s\n" "$*"; }
die()  { printf "stage.sh: %s\n" "$*" >&2; exit 1; }

# Flags that take a value, so the file list stays unambiguous.
takes_value() {
  case "$1" in
    --platform|--version|--min-os|--store-url|--note) return 0 ;;
    *) return 1 ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-restart)  RESTART=0; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --dir)         die "--dir is not accepted here: the staging root must stay the compose bind-mount source ($STAGE_ROOT)" ;;
    -h|--help)     sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --*)
      if takes_value "$1"; then
        [ "$#" -ge 2 ] || die "$1 needs a value"
        FLAGS+=("$1" "$2"); shift 2
      else
        FLAGS+=("$1"); shift
      fi
      ;;
    *) FILES+=("$1"); shift ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker not found — run this on the box"

# --- how we get a node ------------------------------------------------------
# Resolved once and reported, because "it staged" and "it staged inside the
# orchestrator image" fail in different ways and the log should say which.
ORCH_IMAGE=""
resolve_container_node() {
  ORCH_IMAGE="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" images -q "$SERVICE" 2>/dev/null | head -1 || true)"
  [ -n "$ORCH_IMAGE" ] || ORCH_IMAGE="$(docker images -q "${PROJECT}-${SERVICE}" 2>/dev/null | head -1 || true)"
  [ -n "$ORCH_IMAGE" ] || die "no host node and no ${PROJECT}-${SERVICE} image to borrow one from — is the stack built?"
}

run_stage() {
  if command -v node >/dev/null 2>&1; then
    log "using host node ($(node --version))"
    node "$SCRIPT_DIR/stage.mjs" --dir "$STAGE_ROOT" "${FLAGS[@]}" "${FILES[@]}"
    return
  fi

  resolve_container_node
  log "no host node — running inside the $SERVICE image ($ORCH_IMAGE)"

  # Each source file is mounted individually rather than mounting its parent:
  # the installers usually sit in the operator's home, and there is no reason
  # to expose the rest of it to the container.
  local mounts=() cfiles=() abs base
  for f in "${FILES[@]}"; do
    abs="$(readlink -f "$f")" || die "cannot resolve $f"
    [ -f "$abs" ] || die "not a file: $f"
    base="$(basename "$abs")"
    mounts+=(-v "$abs:/src/$base:ro")
    cfiles+=("/src/$base")
  done

  # --user keeps the staged files owned by the operator instead of root, so a
  # later stage (or a factory-reset script running as droplet) can still
  # replace them.
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$SCRIPT_DIR:/tool:ro" \
    -v "$STAGE_ROOT:/stage" \
    "${mounts[@]}" \
    --entrypoint node "$ORCH_IMAGE" \
    /tool/stage.mjs --dir /stage "${FLAGS[@]}" "${cfiles[@]}"
}

# --- talking to the running service -----------------------------------------
# By container ID, not `docker compose exec`. Compose has to parse the whole
# compose file and interpolate every ${VAR} from an env file to do anything at
# all, and on a real box that resolution is a known source of surprises (the
# docker/.env symlink drifting from the repo-root .env, WARP-1908). Restarting
# one container needs none of that. `docker compose ps -q` is still how we FIND
# it, so a renamed project or a scaled service resolves correctly; the
# name-shaped fallback only runs if that fails.
orch_container() {
  local id
  id="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENVFILE" ps -q "$SERVICE" 2>/dev/null | head -1 || true)"
  [ -n "$id" ] || id="$(docker ps -q --filter "name=^${PROJECT}-${SERVICE}-" | head -1 || true)"
  [ -n "$id" ] || die "cannot find a running $SERVICE container — is the stack up?"
  printf '%s' "$id"
}

# --- verify: what does the RUNNING container see? ---------------------------
verify() {
  [ -f "$STAGE_ROOT/catalog.json" ] || die "nothing staged: no $STAGE_ROOT/catalog.json"
  local cid
  cid="$(orch_container)"

  if ! docker exec "$cid" cat "$CONTAINER_STAGE/catalog.json" 2>/dev/null \
        | cmp -s - "$STAGE_ROOT/catalog.json"; then
    die "the $SERVICE container does NOT see the staged catalog — check the bind mount in $COMPOSE_FILE"
  fi
  log "verified: $SERVICE serves the staged catalog"

  # Name what a browser will actually be offered. A catalog that parses but
  # whose primary is last month's build is the failure this reports.
  docker exec "$cid" node -e "
      const c = JSON.parse(require('fs').readFileSync('$CONTAINER_STAGE/catalog.json','utf8'));
      for (const p of c.platforms) {
        console.log('stage.sh: ' + p.platform + ' v' + p.version + ' -> ' + (p.primary || '(no installer)'));
      }" 2>/dev/null || true
}

if [ "$VERIFY_ONLY" = "1" ]; then
  verify
  exit 0
fi

[ "${#FILES[@]}" -gt 0 ] || die "no installer given (try --help)"

run_stage

# --dry-run touched nothing, so there is nothing to restart or verify.
# Written as an if rather than `[ … ] && exit 0`: under `set -e` a loop whose
# last command is a failed test takes the exit status of that test, and the
# script would quietly stop here on every NON-dry run.
DRY=0
for f in "${FLAGS[@]:-}"; do
  if [ "$f" = "--dry-run" ]; then DRY=1; fi
done
if [ "$DRY" = "1" ]; then exit 0; fi

if [ "$RESTART" = "1" ]; then
  CID="$(orch_container)"
  log "restarting $SERVICE so it re-reads the catalog"
  docker restart "$CID" >/dev/null
  # Verifying against a container that is still booting reports a failure that
  # is really a race. Measured ~40 s to healthy on a single-box after a plain
  # restart, so wait for the healthcheck rather than sleeping a guess.
  for _ in $(seq 1 45); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null)" = "healthy" ] && break
    sleep 2
  done
  log "$SERVICE is $(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null || echo unknown)"
  verify
else
  log "--no-restart: staged on disk, but /downloads will not show it until $SERVICE restarts"
fi
