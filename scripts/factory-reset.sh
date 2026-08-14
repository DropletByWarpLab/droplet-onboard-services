#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — Factory Reset
# =============================================================================
#
# Wipes ALL user data, credentials, and configuration — returning the device
# to a fresh out-of-the-box state. After reset, run setup.sh to re-provision.
#
# Usage:
#   ./scripts/factory-reset.sh [OPTIONS]
#
# A reset means a FACTORY-NEW box: by default nothing is saved and nothing
# stale survives — including previously accumulated device-backup tarballs
# (operator directive 2026-07-16). Pass --backup to emit a final full-device
# backup (WARP-570 semantics: the backup gate aborts the reset on failure).
#
# Options:
#   --yes            Skip interactive confirmation (for automation)
#   --reinstall      After wiping, automatically run setup.sh to re-provision
#   --purge-images   Also remove built Docker images + dangling images/networks
#   --backup         Emit a pre-reset full-device backup and KEEP the backups
#                    dir (WARP-570 gate; aborts the reset if the backup fails)
#   --no-backup      DEPRECATED no-op — no backup is already the default
#   --decommission   Fully DEREGISTER the device at HQ (delete it from the fleet
#                    registry). DEFAULT (without this flag): RELEASE only — the
#                    device stays registered/trusted and self-heals (WARP-980).
#   -h, --help       Show this help message
#
# WARP-980 (AMENDS ADR-023 reset behavior — reset ≠ deregister): a factory-reset
# now RELEASES the box's HQ name + revokes its cert but KEEPS the device
# REGISTERED and trusted (its durable TPM key stays authoritative), so the box
# self-heals: after re-provisioning, renaming in setup re-claims a name via
# device-auth proof-of-possession with NO token. Pass --decommission to instead
# fully deregister (delete the device from the fleet registry) — a permanent
# retirement, after which the box needs a fresh first-factory enroll token.
#
# Every reset reclaims the Docker build cache (the largest rebuildable disk
# consumer; `down --rmi all` leaves it behind) so the box returns to a clean
# out-of-box disk footprint. --purge-images additionally reclaims dangling
# images + unused networks (scoped — never a daemon-wide prune, so sibling
# project images such as Ollama survive). Trade-off: the next setup.sh rebuild
# is a cold build.
#
# =============================================================================
set -euo pipefail

# --- Resolve paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT

# --- Parse arguments ---
SKIP_CONFIRM=false
REINSTALL=false
PURGE_IMAGES=false
FORCE_REMOVE=false
# A reset means a factory-new box (operator directive 2026-07-16): the
# WARP-570 pre-reset backup is now OPT-IN via --backup. When it IS requested,
# the original fail-safe stands — a failed backup aborts the reset.
DO_BACKUP=false
# WARP-980 — default reset RELEASES the HQ name (device stays registered +
# self-heals). --decommission does the full ADR-023 deregister (deletes the
# device from the fleet registry).
DECOMMISSION=false

usage() {
  cat << 'USAGE'
Usage: ./scripts/factory-reset.sh [OPTIONS]

Wipes ALL user data, credentials, and configuration.
The device will be returned to a fresh out-of-the-box state.

Options:
  --yes            Skip interactive confirmation (for automation)
  --reinstall      After wiping, automatically run setup.sh to re-provision
  --purge-images   Also remove built Docker images + dangling images/networks
  --force          Restart Docker if volumes cannot be removed (stuck references)
  --backup         Emit a pre-reset full-device safety backup and KEEP the
                   backups dir (WARP-570 gate: a failed backup aborts the reset)
  --no-backup      DEPRECATED no-op — no backup is already the default
  --decommission   Fully DEREGISTER the device at HQ (delete it from the fleet
                   registry). DEFAULT: RELEASE only — the device stays
                   registered/trusted and self-heals (WARP-980).
  -h, --help       Show this help message

What gets deleted:
  - All Docker volumes (database, files, AI keys, Matter fabric state)
  - The Docker build cache (always reclaimed — largest rebuildable consumer)
  - Generated secrets (.env)
  - TLS certificates
  - Internal-CA service TLS bundles + legacy MQTT password file
  - Setup logs
  - Accumulated device-backup tarballs (unless --backup is passed)

What is preserved:
  - Source code and git history
  - Docker images (unless --purge-images)
  - Docker engine and system packages

Note: reclaiming the build cache means the next setup.sh is a cold (slower)
rebuild. This is intentional — it stops the OS drive from filling over time.
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes)            SKIP_CONFIRM=true; shift ;;
    --reinstall)      REINSTALL=true; shift ;;
    --purge-images)   PURGE_IMAGES=true; shift ;;
    --force)          FORCE_REMOVE=true; shift ;;
    --backup)         DO_BACKUP=true; shift ;;
    --no-backup)      shift ;;  # deprecated no-op — kept so existing automation doesn't break
    --decommission)   DECOMMISSION=true; shift ;;
    -h|--help)        usage ;;
    *)                echo "Unknown option: $1"; usage ;;
  esac
done

# --- Source logging library ---
source "$SCRIPT_DIR/lib/logging.sh"

# --- Sanity check ---
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
  log_error "docker-compose.yml not found at $COMPOSE_FILE"
  log_error "Are you running this from the correct repository?"
  exit 1
fi

# --- Detect docker compose command ---
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  log_error "Docker Compose not found. Is Docker installed?"
  exit 1
fi

# =============================================================================
# Warning & Confirmation
# =============================================================================

log_divider
printf "\n"
printf "  ${_RED}${_BOLD}Droplet Edge Platform — Factory Reset${_RESET}\n"
printf "\n"
printf "  ${_YELLOW}WARNING: This will permanently delete ALL data:${_RESET}\n"
printf "\n"
printf "    ${_RED}•${_RESET} User accounts and credentials\n"
printf "    ${_RED}•${_RESET} Chat sessions and message history\n"
printf "    ${_RED}•${_RESET} All uploaded files\n"
printf "    ${_RED}•${_RESET} LLM provider API keys\n"
printf "    ${_RED}•${_RESET} Smart home configuration and history\n"
printf "    ${_RED}•${_RESET} Sync targets and file metadata\n"
printf "    ${_RED}•${_RESET} TLS certificates and device secrets\n"
printf "\n"
printf "  ${_DIM}This action cannot be undone.${_RESET}\n"
printf "\n"
log_divider

if [ "$SKIP_CONFIRM" != "true" ]; then
  printf "\n"
  printf "  Type ${_BOLD}RESET${_RESET} to confirm: "
  read -r confirmation
  printf "\n"

  if [ "$confirmation" != "RESET" ]; then
    log_info "Factory reset cancelled."
    exit 0
  fi
fi

# =============================================================================
# Phase 0: Safety backup (WARP-570)
# =============================================================================
# OPT-IN (--backup) since 2026-07-16: the default reset is a full-erasure
# factory-new box with nothing saved. When --backup IS passed, the original
# WARP-570 fail-safe stands: the backup runs BEFORE any destructive step (the
# `down -v` in Phase 1 already removes volumes, so this gate MUST run before
# it), and a failed backup ABORTS the reset — never wipe data we said we'd
# protect.

BACKUP_SCRIPT="$SCRIPT_DIR/host/device-backup.sh"
if [ "$DO_BACKUP" != "true" ]; then
  log_info "No pre-reset backup (default: a reset leaves nothing on the box) — pass --backup to emit one"
elif [ ! -f "$BACKUP_SCRIPT" ]; then
  log_warn "device-backup.sh not found — skipping safety backup"
elif ! command -v docker >/dev/null 2>&1; then
  log_warn "docker not available — skipping safety backup (nothing running to back up)"
else
  log_step 0 4 "Emitting a final safety backup before wipe"
  if "$BACKUP_SCRIPT"; then
    log_success "Safety backup complete (default dir: /var/lib/droplet/backups)"
    # Be explicit about what the wipe destroys that the backup does NOT
    # capture (caches / rebuildable state). The backup manifest's `excluded`
    # array is the machine-readable source of truth; this is the operator-
    # facing heads-up so nobody assumes "backup taken" == "everything saved".
    log_warn "NOT in the safety backup (rebuilt on reinstall): frigate-config,"
    log_warn "  rag-eval output, whisper/piper/ollama model caches, openwrt"
    log_warn "  config/overlay. See manifest 'excluded' for the list."
  else
    log_error "Safety backup FAILED — aborting factory reset."
    log_error "Fix the backup, or re-run WITHOUT --backup to reset anyway (DATA WILL BE LOST)."
    exit 1
  fi
  log_divider
fi

# =============================================================================
# Phase 0b: Release the split-horizon FQDN + HQ name (ADR-023 C3 / WARP-980)
# =============================================================================
# MUST run BEFORE Phase 1 stops the stack (the routing service has to be up to
# accept the DELETE) AND before Phase 3 wipes .env (we read DROPLET_PUBLIC_FQDN
# + DROPLET_DEVICE_ID from it). Every step is BEST-EFFORT and non-fatal: a reset
# must complete even if HQ or the router is unreachable.
#
# WARP-980 (AMENDS ADR-023 reset behavior — reset ≠ deregister): the DEFAULT HQ
# step below is now a RELEASE (frees the name, keeps the device registered so it
# self-heals). --decommission switches it to the full deregister (deletes the
# device from the fleet registry). The split-horizon DNS legs are unchanged.

_DEREGISTER_FQDN=""
_DEREGISTER_DEVICE_ID=""
if [ -f "$REPO_ROOT/.env" ]; then
  # Read the two keys without sourcing the whole .env (avoids executing it).
  _DEREGISTER_FQDN="$(grep -E '^DROPLET_PUBLIC_FQDN=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  _DEREGISTER_DEVICE_ID="$(grep -E '^DROPLET_DEVICE_ID=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
fi

# Gate on the FQDN *or* the device id: a zero-touch box (ADR-023 PR-1) issues a
# cert + learns its FQDN lazily, so DROPLET_PUBLIC_FQDN can still be empty while
# the box is already REGISTERED at HQ under DROPLET_DEVICE_ID. Gating on the FQDN
# alone (the old behaviour) skipped the HQ step on exactly those boxes.
if [ -n "$_DEREGISTER_FQDN" ] || [ -n "$_DEREGISTER_DEVICE_ID" ]; then
  if [ "$DECOMMISSION" = "true" ]; then
    _hq_step_label="Deregistering public-FQDN DNS + deleting HQ registration"
  else
    _hq_step_label="Releasing public-FQDN DNS + HQ name (device stays registered)"
  fi
  log_step 0 4 "${_hq_step_label} (${_DEREGISTER_FQDN:-${_DEREGISTER_DEVICE_ID}})"

  # The split-horizon DNS legs (router + host dnsmasq) are FQDN-keyed, so only
  # run them when we actually have a learned FQDN. The HQ deregistration below
  # is keyed on the device id and runs even on a zero-touch box that never
  # populated DROPLET_PUBLIC_FQDN.
  if [ -n "$_DEREGISTER_FQDN" ]; then
    # 1. Remove the split-horizon host-record from the OpenWrt dnsmasq (routing).
    _routing_url="${ROUTING_SERVICE_URL:-http://localhost:8080}"
    _routing_token="${ROUTING_SERVICE_TOKEN:-}"
    _routing_auth=()
    [ -n "$_routing_token" ] && _routing_auth=(-H "Authorization: Bearer ${_routing_token}")
    if curl -sf --max-time 5 "${_routing_url}/health" >/dev/null 2>&1; then
      curl -sS --max-time 10 -X DELETE \
        "${_routing_url}/dhcp/hostnames/${_DEREGISTER_FQDN}" \
        "${_routing_auth[@]}" >/dev/null 2>&1 \
        && log_success "Removed router DNS host-record for ${_DEREGISTER_FQDN}" \
        || log_warn "Could not remove router DNS host-record (non-fatal)"
    else
      log_warn "Routing service unreachable — skipping router DNS deregistration (non-fatal)"
    fi

    # 2. Remove the managed host-record line from the host dnsmasq config
    #    (ADR-018-transitional leg). Best-effort; the file is wiped/regenerated on
    #    re-provision anyway, but stripping it now keeps a not-reinstalled box clean.
    _host_dnsmasq_conf="/etc/droplet-host-net/lan-dhcp.conf"
    if [ -f "$_host_dnsmasq_conf" ]; then
      _tmp_dns="$(mktemp -t droplet-hostdns-rm.XXXXXX 2>/dev/null || mktemp)"
      sudo grep -vF "# ADR-023 managed host-record" "$_host_dnsmasq_conf" 2>/dev/null \
        | grep -vE '^host-record=.*\.devices\.warp-lab\.ai,' > "$_tmp_dns" || true
      sudo cp "$_tmp_dns" "$_host_dnsmasq_conf" 2>/dev/null || true
      rm -f "$_tmp_dns"
      sudo systemctl reload droplet-host-net.service 2>/dev/null \
        || sudo systemctl restart droplet-host-net.service 2>/dev/null || true
      log_success "Removed host dnsmasq host-record (ADR-018-transitional)"
    fi
  fi

  # 3. Signed HQ release OR deregistration (WARP-980, AMENDS ADR-023 PR-3). The
  #    box CAN prove possession of its device identity: the orchestrator signs a
  #    FRESH HQ challenge with the device-identity sidecar (the SAME PoP the order
  #    flow uses) and POSTs the required body {nonce, signature, sig_alg,
  #    key_fingerprint} (device_id in the query).
  #
  #    DEFAULT (release, WARP-980): `tls-release` → POST /api/issuance/release.
  #    HQ frees the NAME + revokes the cert but KEEPS the device REGISTERED +
  #    trusted, so the box SELF-HEALS — its durable TPM key stays authoritative
  #    and the next rename re-claims a name via device-auth PoP with no token.
  #    A factory-reset is NOT a deregister.
  #
  #    --decommission (deregister, ADR-023 PR-3): `tls-deregister` → DELETE
  #    /api/issuance/registration. HQ DELETES the device from the fleet registry
  #    (permanent retirement); re-provisioning then needs a fresh first-factory
  #    enroll token (WARP-983). The deployed Worker REQUIRES the signed body — the
  #    old bodyless curl 422'd, so HQ never unbound the device.
  #
  #    We run this HERE, in Phase 0b, *while the stack is still UP* (Phase 1
  #    `down -v` comes later) so the orchestrator can reach the sidecar. Both CLIs
  #    always exit 0 and no-op when HQ_ISSUANCE_URL is unset; this whole step is
  #    best-effort + NON-FATAL — a reset must complete even if HQ or the sidecar
  #    is down (HQ also reaps stale names/registrations server-side).
  #    GUARD (ADR-023 PR-3): require BOTH a live HQ url AND a real (non-default)
  #    device id before we ever sign the call. config.DROPLET_DEVICE_ID has a Zod
  #    default of "droplet" (apps/orchestrator/src/config.ts), so a partially
  #    provisioned / ID-less box with HQ_ISSUANCE_URL set must NOT be able to send
  #    a signed release/DELETE for device_id="droplet" to HQ.
  #    `_DEREGISTER_REAL_DEVICE_ID` is non-empty only when .env carries a genuine,
  #    non-default id. The inner service provisioning guard is the suspender.
  _hq_url="${HQ_ISSUANCE_URL:-$(grep -E '^HQ_ISSUANCE_URL=' "$REPO_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)}"
  _DEREGISTER_REAL_DEVICE_ID=""
  if [ -n "$_DEREGISTER_DEVICE_ID" ] && [ "$_DEREGISTER_DEVICE_ID" != "droplet" ]; then
    _DEREGISTER_REAL_DEVICE_ID="$_DEREGISTER_DEVICE_ID"
  fi
  if [ -n "$_hq_url" ] && [ -n "$_DEREGISTER_REAL_DEVICE_ID" ]; then
    _dereg_env_flag_args=()
    [ -f "$REPO_ROOT/.env" ] && _dereg_env_flag_args=(--env-file "$REPO_ROOT/.env")
    # Select the HQ path: RELEASE by default (self-heal), DEREGISTER only when the
    # operator asked to fully retire the box with --decommission.
    if [ "$DECOMMISSION" = "true" ]; then
      _hq_reset_cmd="tls-deregister"
      _hq_reset_verb="deregistration (full — device deleted from the fleet registry)"
    else
      _hq_reset_cmd="tls-release"
      _hq_reset_verb="release (name freed, cert revoked, device STAYS registered — self-heals)"
    fi
    # Bound the whole exec with a shell `timeout` (re-establishing the bound the
    # old `curl --max-time 10` had): the `docker compose exec` has no shell-level
    # deadline, and the underlying gRPC calls to the device-identity sidecar can
    # hang if the sidecar is present-but-wedged — without this, factory-reset
    # blocks forever here and never reaches Phase 1 `down -v`. A `timeout` exit
    # of 124 (deadline hit) is treated exactly like any other failure: log a warn
    # and PROCEED to the wipe. The whole step stays best-effort + NON-FATAL.
    # WARP-1040 — capture the CLI output instead of discarding it. The
    # tls-release CLI ALWAYS exits 0 (reset-must-complete contract), so its exit
    # code says nothing about whether HQ actually freed the name; it prints a
    # machine-readable "tls-release: result=ok|skipped|failed" sentinel instead
    # and we branch the operator log on THAT. Still strictly NON-FATAL: the
    # capture swallows the exit code (`|| _hq_reset_status=$?`), captured stderr
    # goes into the variable (never the terminal's error path), and a missing /
    # unparseable sentinel simply logs the warn — nothing here can abort a reset.
    _hq_reset_status=0
    _hq_reset_output="$(timeout 90 $DC -f "$COMPOSE_FILE" "${_dereg_env_flag_args[@]}" exec -T orchestrator \
         npm run -s "$_hq_reset_cmd" 2>&1)" || _hq_reset_status=$?
    if [ "$_hq_reset_cmd" = "tls-release" ]; then
      # here-string, NOT a `printf | grep -q` pipeline — under `set -o pipefail`
      # an early-exiting grep can SIGPIPE the writer into a false negative.
      # Sentinels are ^-anchored: the captured output also carries pino JSON
      # logs (which serialize HQ error bodies), so an unanchored match could
      # false-positive on an HQ error message that merely CONTAINS the text.
      # The CLI always writes the sentinel at column 0.
      if grep -q '^tls-release: result=ok' <<< "$_hq_reset_output"; then
        log_success "HQ confirmed the signed name ${_hq_reset_verb} for ${_DEREGISTER_REAL_DEVICE_ID}"
      elif grep -q '^tls-release: result=skipped' <<< "$_hq_reset_output"; then
        # HQ_ISSUANCE_URL was unset INSIDE the container even though the
        # host-side _hq_url guard passed (e.g. shell-env-only config with an
        # .env lacking the var). There is no HQ to hold the name — do not
        # print the misleading "may still be reserved" hint.
        log_warn "HQ release skipped — HQ_ISSUANCE_URL is not configured inside the orchestrator container (nothing to release at HQ; non-fatal, the reset continues)"
      else
        _reserved_box_name="$(grep -E '^DROPLET_BOX_NAME=' "$REPO_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
        log_warn "HQ did NOT confirm the name release (non-fatal — timed out, HQ/sidecar down, or HQ rejected it; the reset continues)"
        log_warn "The box name${_reserved_box_name:+ '${_reserved_box_name}'} may still be reserved at HQ — it frees when this box re-claims a name, or via an HQ admin release"
      fi
    elif [ "$_hq_reset_status" -eq 0 ]; then
      log_success "Sent signed HQ ${_hq_reset_verb} for ${_DEREGISTER_REAL_DEVICE_ID}"
    else
      log_warn "Could not run signed HQ ${_hq_reset_cmd} (non-fatal — timed out or HQ/sidecar down; HQ reaps stale state server-side)"
    fi
  fi

  log_divider
fi

# =============================================================================
# Phase 1: Stop the stack
# =============================================================================

log_step 1 4 "Stopping all services"

# Use "down -v" to atomically stop containers AND remove named volumes.
# This is critical — "down" without "-v" leaves volumes intact, which causes
# credential mismatches on re-setup (new .env passwords vs old volume data).
#
# The compose file has no ${VAR:?error} patterns, so this always works
# regardless of .env state. Pass --env-file only when .env exists.
env_flag=""
if [ -f "$REPO_ROOT/.env" ]; then
  env_flag="--env-file $REPO_ROOT/.env"
fi

# Live compose project name. The compose file PINS it via `name:` (WARP-187, to
# avoid colliding with the sibling droplet-local-LLM repo, which auto-derives
# `docker` from its own docker/ dir). DERIVE it — never guess from the directory
# basename: the old Phase 2 used `basename $(dirname compose.yml)` = "docker",
# so its remove + verify loops targeted nonexistent "docker_*" volumes and
# silently "succeeded" while the real droplet_pgdata survived. That stale DB
# (old role password vs a freshly-rotated POSTGRES_PASSWORD) is the
# orchestrator/file-indexer crash-loop this fix prevents.
# `|| true` so a compose file without a `name:` line (grep exits 1) does not trip
# `set -euo pipefail` and abort the reset before the `:-droplet` fallback applies.
PRIMARY_PROJECT=$(grep -E '^name:[[:space:]]' "$COMPOSE_FILE" | head -1 | awk '{gsub(/["\x27]/,"",$2); print $2}' || true)
PRIMARY_PROJECT="${PRIMARY_PROJECT:-droplet}"

# The brick-safe reflash keeps the OLD stack UP while it builds the new images,
# so a target volume can still be mounted when factory-reset runs. Tear the
# stack down FIRST so the volumes are free; Phase 2 then removes them and
# VERIFIES they are gone, so a swallowed `down` can no longer hide a surviving
# DB. stderr is NOT sent to /dev/null — run_with_spinner already captures output
# to the log; `|| true` continues because Phase 2's verify is the real gate.
if [ "$PURGE_IMAGES" = "true" ]; then
  run_with_spinner "Stopping stack, removing volumes and images" \
    $DC -f "$COMPOSE_FILE" $env_flag down -v --rmi all --remove-orphans || true
else
  run_with_spinner "Stopping stack and removing volumes" \
    $DC -f "$COMPOSE_FILE" $env_flag down -v --remove-orphans || true
fi

# Tear the retired pre-WARP-605 `droplet-pi-platform` namespace down too so its
# containers release any mount before Phase 2 sweeps the orphaned volumes.
$DC -f "$COMPOSE_FILE" $env_flag -p droplet-pi-platform down -v --remove-orphans \
  >/dev/null 2>&1 || true
log_success "All services stopped"

# --- Reclaim the Docker build cache (disk hygiene) ---
# The build cache is the largest rebuildable disk consumer and the one thing
# `docker compose down --rmi all` does NOT remove. It grows unbounded across
# rebuilds (observed: 57 GB of ACTIVE=0 cache on a long-lived single-box,
# enough to fill the OS NVMe) yet is pure build-accelerator state — never user
# data. A factory reset returns the box to a clean out-of-box *disk footprint*,
# so it must reclaim the cache. Done on EVERY reset — NOT gated behind
# --purge-images — because the dashboard Danger Zone reset runs without that
# flag, and an appliance reset that leaves tens of GB behind isn't "clean".
# Trade-off: the next setup.sh rebuild is a cold build (a few minutes slower);
# acceptable for an infrequent reset, and it stops the drive from silently
# filling. --purge-images extends the reclaim to dangling (untagged) images +
# unused networks too — but it is deliberately SCOPED, not a daemon-wide
# `docker system prune -af`: the `-a` there removes every image without a
# running container, which at reset time (all containers just stopped) would
# sweep the sibling droplet-local-LLM / Ollama images that deploy alongside
# this project on the single-box inference host, leaving AI inference broken
# until they are re-pulled. This project's own built images are already gone
# via `down --rmi all` above. Named volumes are Phase 2's job, so no --volumes.
if [ "$PURGE_IMAGES" = "true" ]; then
  # Scoped on purpose (see block comment above): build cache + dangling
  # (untagged) images + unused networks. NOT `docker system prune -af` — the
  # `-a` would also delete tagged sibling-project images (e.g. Ollama).
  run_with_spinner "Reclaiming build cache, dangling images, and networks" \
    sh -c 'docker builder prune -af; docker image prune -f; docker network prune -f' \
    2>/dev/null || true
else
  run_with_spinner "Reclaiming Docker build cache" \
    docker builder prune -af 2>/dev/null || true
fi
log_success "Docker build cache reclaimed"

log_divider

# =============================================================================
# Phase 2: Remove Docker volumes
# =============================================================================

log_step 2 4 "Removing Docker volumes"

# WARP-234: a bind-mounted *.config.php inside a named volume (nextcloud
# redis-TLS config) leaves a STALE bind-mount after `down -v` that Docker
# does not clean up, so `docker volume rm droplet_nextcloud-data` fails
# with "device or resource busy" and the reset aborts. Lazy-umount any
# lingering submounts under our droplet_ volumes before the removal loop.
for _stale in $(awk '$2 ~ /\/var\/lib\/docker\/volumes\/droplet_.*\/_data\// {print $2}' /proc/mounts 2>/dev/null); do
  sudo umount -l "$_stale" 2>/dev/null || true
done

# Project prefixes whose volumes we OWN and may remove. PRIMARY_PROJECT is the
# live name derived from the compose `name:` in Phase 1; droplet-pi-platform is
# the retired pre-WARP-605 name whose volumes still linger on long-lived boxes.
# Deliberately EXCLUDES the bare `docker` project — that belongs to the sibling
# droplet-local-LLM repo (its compose auto-derives `docker` from its own docker/
# dir, the collision we pinned `name: droplet` to avoid). Sweeping docker_* here
# would nuke the sibling's Ollama model cache.
OWNED_PREFIXES=("$PRIMARY_PROJECT" "droplet-pi-platform")
# This list is the belt-and-suspenders fallback for when `down -v` is swallowed
# (brick-safe reflash, volume still in use). It MUST mirror every named volume in
# docker/docker-compose.yml — a "factory reset" that leaves any of them behind is
# data remanence. It is kept in lock-step with scripts/host/device-backup.sh: the
# DATA_VOLUMES it captures + the EXCLUDED_VOLUMES it intentionally drops + the
# pg_dump'd DBs == this list. Listed unconditionally; `docker volume rm` of a
# volume that a given profile never created is a soft fail the loop below handles.
VOLUMES=(
  # --- Customer / operator data (device-backup.sh DATA_VOLUMES captures these
  #     before a backed-up reset; omitting any from this fallback would let a
  #     swallowed `down -v` leave personal data on the box). ---
  "pgdata"               # orchestrator Postgres (also pg_dump'd by device-backup)
  "nextcloud-data"
  "aikeys"
  "matter-data"
  "brain-memory-data"    # assistant memory: extracted text + embeddings of personal files
  "nvrdata"
  "ops-audit"            # WARP-337 append-only audit trail
  # WARP-573: pre-migration DB snapshots from the orchestrator's guarded boot
  # entrypoint. Wiped on reset so factory-reset truly returns to out-of-box.
  "migration-snapshots"
  # --- Rebuildable caches / regenerated state (device-backup.sh EXCLUDED_VOLUMES:
  #     wiped but intentionally not backed up — regenerated on reinstall). ---
  "frigate-config"
  "rag-eval-data"
  "whisper-models"
  "piper-voices"
  # WARP-1055: voice-io's applied mic-calibration record (small JSON, mounted
  # at /data). docker-compose.yml declares this named volume so a container
  # recreate never silently reverts the tuned gain/threshold; the reset must
  # wipe it so factory-reset truly returns to §6.4 "Not calibrated yet".
  "voice-calibration"
  "ollama-data"
  # WARP-1772: DMR's OCI model store (dark `dmr` profile today, the serving
  # store after the WARP-1749 flip). Same classification as ollama-data —
  # model blobs are re-pulled, never customer data — and it must be in this
  # list BEFORE the flip ships, or a factory reset on a flipped box would
  # wipe the standby store and keep the serving one.
  "dmr-models"
  "openwrt-config"
  "openwrt-overlay"
  "switch-state"         # managed-switch state — re-provisioned by setup, like openwrt-*
  # INFRA-004: both are declared in docker-compose.yml but were missing here —
  # in the swallowed-`down -v` scenario this fallback exists for, they SURVIVED
  # a "factory reset" AND the verify gate (built from this same list) read clean.
  # fleet-agent-state holds identity.json + the portal ingest token (credential
  # remanence on a resold box); ota-updates holds per-update rollback backups +
  # staged configs.tar.gz.
  "ota-updates"
  "fleet-agent-state"
)

# Free any container still mounting a target volume so the removals below are
# clean. Phase 1's `down --remove-orphans` handles the compose-managed case;
# this catches a stray or half-stopped container outside the projects.
for prefix in "${OWNED_PREFIXES[@]}"; do
  for vol in "${VOLUMES[@]}"; do
    holders=$(docker ps -aq --filter "volume=${prefix}_${vol}" 2>/dev/null || true)
    if [ -n "$holders" ]; then
      log_warn "Stopping container(s) holding ${prefix}_${vol} before removal"
      # shellcheck disable=SC2086  # word-splitting the id list is intended
      docker rm -f $holders >/dev/null 2>&1 || true
    fi
  done
done

# Remove every owned volume that exists. A failure here is NOT swallowed as
# success — the authoritative `docker volume ls` gate below turns any surviving
# volume into a hard abort (the stale-Postgres crash-loop this fix prevents).
removed=0
for prefix in "${OWNED_PREFIXES[@]}"; do
  for vol in "${VOLUMES[@]}"; do
    full_name="${prefix}_${vol}"
    docker volume inspect "$full_name" >/dev/null 2>&1 || continue
    if docker volume rm "$full_name" >/dev/null 2>&1; then
      log_success "Removed volume: $full_name"
      removed=$((removed + 1))
    else
      log_warn "Failed to remove volume: $full_name (re-checked by the verify gate)"
    fi
  done
done

# Bare-named volumes (custom naming, no project prefix).
for vol in "${VOLUMES[@]}"; do
  docker volume inspect "$vol" >/dev/null 2>&1 || continue
  if docker volume rm "$vol" >/dev/null 2>&1; then
    log_success "Removed volume: $vol"
    removed=$((removed + 1))
  else
    log_warn "Failed to remove volume: $vol (re-checked by the verify gate)"
  fi
done

# Sweep ALL volumes still under the retired pre-WARP-605 `droplet-pi-platform`
# project — even ones not in VOLUMES — since that name is dead and anything
# under it is orphaned. (We never blanket-sweep PRIMARY_PROJECT_*: a future
# volume not yet in VOLUMES could still be legitimately in use.)
while IFS= read -r orphan; do
  [ -n "$orphan" ] || continue
  if docker volume rm "$orphan" >/dev/null 2>&1; then
    log_success "Removed orphaned legacy volume: $orphan"
    removed=$((removed + 1))
  else
    log_warn "Failed to remove orphaned legacy volume: $orphan (re-checked by the verify gate)"
  fi
done < <(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '^droplet-pi-platform_' || true)

if [ $removed -gt 0 ]; then
  log_success "$removed volume(s) removed"
else
  log_info "No volumes found to remove"
fi

# Final sweep for any orphaned anonymous volumes
docker volume prune -f >/dev/null 2>&1 || true

# --- Authoritative gate: verify OUR volumes are truly gone -------------------
# Enumerate what ACTUALLY remains instead of trusting the targeted loop above.
# Scope to prefixes we own so a sibling project's same-suffixed volume (e.g. the
# droplet-local-LLM Ollama cache, docker_ollama-data) is never misread as ours.
# A surviving *_pgdata is the headline failure this whole fix exists to stop:
# the new db container would re-mount the OLD PGDATA, keep the OLD role password,
# and crash-loop the orchestrator against the freshly-rotated .env secret.
vol_suffix_re=$(IFS='|'; printf '%s' "${VOLUMES[*]}")
owned_prefix_re=$(IFS='|'; printf '%s' "${OWNED_PREFIXES[*]}")
_remaining_owned_volumes() {
  # Two passes against one `docker volume ls`: project-prefixed survivors
  # (`<prefix>_<suffix>`) AND bare-named survivors (`<suffix>`, no prefix). The
  # bare-name removal loop above logs "re-checked by the verify gate" on
  # failure, so the gate MUST actually re-check bare names — otherwise a bare
  # `pgdata` survivor is invisible here and the reset finishes "clean" with the
  # stale DB still on the box.
  local listing
  listing="$(docker volume ls --format '{{.Name}}' 2>/dev/null || true)"
  {
    printf '%s\n' "$listing" | grep -E "^(${owned_prefix_re})_(${vol_suffix_re})\$"
    printf '%s\n' "$listing" | grep -E "^(${vol_suffix_re})\$"
  } 2>/dev/null | grep -vE '^$' || true
}
remaining="$(_remaining_owned_volumes)"

if [ -n "$remaining" ]; then
  log_warn "Volumes still present after removal:"
  printf '%s\n' "$remaining" | while IFS= read -r v; do
    [ -n "$v" ] && log_warn "  - $v"
  done
  if [ "$FORCE_REMOVE" = "true" ]; then
    log_warn "Force mode: restarting Docker to release stuck volume references..."
    if [[ "$(uname)" == "Darwin" ]]; then
      osascript -e 'quit app "Docker"' 2>/dev/null || true
      sleep 5
      open -a Docker
      # Top-level scope here (this block is at file scope, NOT inside a
      # function), so `local` would be a no-op and SC2168 fires at the
      # static-analysis layer. Plain assignment keeps the var visible to
      # the loop below — which is the only thing that reads it.
      docker_retries=30
      while [ $docker_retries -gt 0 ]; do
        docker info >/dev/null 2>&1 && break
        docker_retries=$((docker_retries - 1))
        sleep 2
      done
      if [ $docker_retries -eq 0 ]; then
        log_error "Docker did not restart in time"
        exit 1
      fi
    else
      sudo systemctl restart docker 2>/dev/null || true
      # Mirror the macOS readiness loop above: on a loaded box Docker can take
      # well over a few seconds to accept connections again. A fixed `sleep`
      # would let the verify gate below run `docker volume ls` against a
      # not-yet-ready daemon — the command fails, `2>/dev/null`/`|| true`
      # swallows it to empty, and a surviving DB volume falsely reads as gone.
      docker_retries=30
      while [ $docker_retries -gt 0 ]; do
        docker info >/dev/null 2>&1 && break
        docker_retries=$((docker_retries - 1))
        sleep 2
      done
      if [ $docker_retries -eq 0 ]; then
        log_error "Docker did not restart in time"
        exit 1
      fi
    fi
    # Retry removal of exactly what survived, then RE-VERIFY — force is an
    # operator escalation, not a license to finish with the DB volume intact.
    printf '%s\n' "$remaining" | while IFS= read -r v; do
      [ -n "$v" ] && docker volume rm "$v" >/dev/null 2>&1 || true
    done
    remaining="$(_remaining_owned_volumes)"
    if [ -n "$remaining" ]; then
      log_error "Volume(s) STILL present after Docker restart + retry:"
      printf '%s\n' "$remaining" | while IFS= read -r v; do
        [ -n "$v" ] && log_error "  - $v"
      done
      log_error "Refusing to finish — a surviving DB volume would crash-loop re-setup."
      exit 1
    fi
    log_success "Volumes force-removed after Docker restart"
  else
    log_error "$(printf '%s\n' "$remaining" | grep -c .) volume(s) could not be removed."
    log_error "Try: ./scripts/factory-reset.sh --yes --force"
    log_error "Or manually: docker volume rm <name>"
    exit 1
  fi
fi

log_divider

# =============================================================================
# Phase 3: Delete generated files
# =============================================================================

log_step 3 4 "Cleaning generated files"

# .env (device secrets)
if [ -f "$REPO_ROOT/.env" ]; then
  rm -f "$REPO_ROOT/.env"
  log_success "Removed .env (device secrets)"
fi

# .env backups + WARP-595 recovery/staging siblings. The torn-file copies
# (.env.torn.*) and any staging files stranded by an interrupted setup run
# (.env.tmp.*, .env.migrate.*, .env.upsert.*) carry the SAME device secrets
# as .env itself — a factory reset must not leak the prior owner's
# credentials through them.
for f in "$REPO_ROOT"/.env.bak.* \
         "$REPO_ROOT"/.env.torn.* \
         "$REPO_ROOT"/.env.tmp.* \
         "$REPO_ROOT"/.env.migrate.* \
         "$REPO_ROOT"/.env.upsert.*; do
  [ -f "$f" ] && rm -f "$f" && log_success "Removed $(basename "$f")"
done

# Accumulated device-backup tarballs (WARP-570 / the daily droplet-backup
# timer). They hold pg_dumps + the aikeys volume — the previous owner's data.
# A factory-new box must not carry them, so the default reset removes the
# whole dir. Kept ONLY when this reset itself was run with --backup (the
# operator explicitly asked for a recovery point). Dir is root-owned 700
# (created by device-backup.sh under sudo/systemd), hence the sudo.
DEVICE_BACKUP_DIR="/var/lib/droplet/backups"
if [ "$DO_BACKUP" != "true" ] && [ -d "$DEVICE_BACKUP_DIR" ]; then
  if sudo rm -rf "$DEVICE_BACKUP_DIR" 2>/dev/null || rm -rf "$DEVICE_BACKUP_DIR" 2>/dev/null; then
    log_success "Removed $DEVICE_BACKUP_DIR (prior device backups)"
  else
    log_warn "Could not remove $DEVICE_BACKUP_DIR — remove it manually (it holds the prior owner's data)"
  fi
fi

# TLS certificates
# ADR-023 PR-3: explicitly wipe the bootstrap self-signed pair PR-2 stashes as
# droplet.{crt,key}.bootstrap BEFORE the directory rm. A reset must never leak
# the PRIOR device's bootstrap private key into the next provisioning — this is
# named so the intent survives even if the dir-wide rm below is ever narrowed.
for _bootstrap in \
  "$REPO_ROOT/docker/certs/droplet.crt.bootstrap" \
  "$REPO_ROOT/docker/certs/droplet.key.bootstrap"; do
  if [ -e "$_bootstrap" ]; then
    rm -f "$_bootstrap"
    log_success "Removed $(basename "$_bootstrap") (bootstrap TLS material)"
  fi
done
if [ -d "$REPO_ROOT/docker/certs" ]; then
  rm -rf "$REPO_ROOT/docker/certs"
  log_success "Removed docker/certs/ (TLS certificates)"
fi

# Docker secret files (WARP-37)
if [ -d "$REPO_ROOT/docker/secrets" ]; then
  rm -rf "$REPO_ROOT/docker/secrets"
  log_success "Removed docker/secrets/ (Docker secret mounts)"
fi

# Audit signing key (WARP-456)
# WARP-456 audit chain treats factory-reset as an era boundary — new key,
# new genesis row. Preserving the old key against an empty ActivityRow
# table would silently fork the chain: two distinct genesis rows signed
# by the same key, with no verifier capable of distinguishing the two
# eras. The orchestrator's sync_audit_signing_key (scripts/lib/secrets.sh)
# re-generates the file on next setup.sh run; the empty ActivityRow table
# then writes its first row as the new chain's genesis.
if [ -d "$REPO_ROOT/data/secrets" ]; then
  rm -rf "$REPO_ROOT/data/secrets"
  log_success "Removed data/secrets/ (audit signing key — era boundary)"
fi

# Legacy MQTT password file (pre-WARP-235 installs; the passwd mechanism is
# retired — MQTT identity is the client cert CN, wiped above with data/secrets)
if [ -d "$REPO_ROOT/docker/mosquitto_passwd_dir" ]; then
  rm -rf "$REPO_ROOT/docker/mosquitto_passwd_dir"
  log_success "Removed docker/mosquitto_passwd_dir/ (legacy MQTT credentials)"
fi

# Generated mosquitto.conf (not git-tracked; may be a directory if Docker
# created the bind-mount target before the file existed)
if [ -f "$REPO_ROOT/docker/mosquitto.conf" ] || [ -d "$REPO_ROOT/docker/mosquitto.conf" ]; then
  rm -rf "$REPO_ROOT/docker/mosquitto.conf"
  log_success "Removed docker/mosquitto.conf"
fi

# Setup logs and lock files
if [ -d "$REPO_ROOT/.data" ]; then
  rm -rf "$REPO_ROOT/.data"
  log_success "Removed .data/ (logs and lock files)"
fi

# Shutdown-screen oneshot unit + host script (WARP-624). Disable + remove so
# a factory reset truly returns to out-of-box; install-device-bridge.sh
# reinstalls them on re-provision. Silent if not installed.
if [ -f /etc/systemd/system/droplet-shutdown-screen.service ] || \
   [ -f /usr/local/sbin/droplet-shutdown-screen.sh ]; then
  sudo systemctl disable --now droplet-shutdown-screen.service 2>/dev/null || true
  sudo rm -f /etc/systemd/system/droplet-shutdown-screen.service 2>/dev/null || true
  sudo rm -f /usr/local/sbin/droplet-shutdown-screen.sh 2>/dev/null || true
  sudo systemctl daemon-reload 2>/dev/null || true
  log_success "Removed shutdown-screen unit and host script"
fi

# Rack-panel console units + host scripts (WARP-1639). Disable + remove so a
# factory reset truly returns to out-of-box; install-device-bridge.sh
# reinstalls them on re-provision. Silent if not installed.
#
# ORDER MATTERS: release the console BEFORE removing the scripts. Stopping
# droplet-panel-claim.service runs its ExecStop, which hands the framebuffer
# back to fbcon — do it the other way round and the box is left with the panel
# claimed by a display service that is about to be wiped, i.e. a dark front
# panel and no console, which is exactly the state this whole path exists to
# prevent.
if [ -f /etc/systemd/system/droplet-panel-claim.service ] || \
   [ -f /usr/local/sbin/droplet-panel-console.sh ]; then
  sudo systemctl disable --now droplet-panel-deadman.timer 2>/dev/null || true
  sudo systemctl disable --now droplet-panel-claim.service 2>/dev/null || true
  # Belt-and-braces: ExecStop above should already have done this, but a
  # never-started or failed unit would not have run it.
  if [ -x /usr/local/sbin/droplet-panel-console.sh ]; then
    sudo /usr/local/sbin/droplet-panel-console.sh release 0 2>/dev/null || true
  fi
  sudo rm -f /etc/systemd/system/droplet-panel-claim.service \
             /etc/systemd/system/droplet-panel-console.service \
             /etc/systemd/system/droplet-panel-deadman.service \
             /etc/systemd/system/droplet-panel-deadman.timer 2>/dev/null || true
  sudo rm -f /usr/local/sbin/droplet-panel-console.sh \
             /usr/local/sbin/droplet-panel-deadman.sh 2>/dev/null || true
  sudo rm -f /run/droplet/panel-released /run/droplet/panel-deadman.fails 2>/dev/null || true
  sudo systemctl daemon-reload 2>/dev/null || true
  log_success "Removed rack-panel console units and host scripts"
fi

# Storage-pool host script (BUG-3 / ADR-019). Remove so a factory reset truly
# returns to out-of-box; install-device-bridge.sh reinstalls it on
# re-provision. NOTE: this removes the executor only — it never touches any
# array/disk; data on a pool is the owner's, not factory state.
if [ -f /usr/local/sbin/droplet-storage-pool.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-storage-pool.sh 2>/dev/null || true
  log_success "Removed storage-pool host script"
fi

# Storage-pool ROOT executor + apply unit + the bridge polkit rules (ADR-019
# follow-up). Remove so a reset truly returns to out-of-box;
# install-device-bridge.sh reinstalls all three on re-provision. The spooled
# request/result files live in /var/lib/droplet-bridge, wiped below.
if [ -f /usr/local/sbin/droplet-storage-pool-apply.sh ] || \
   [ -f /etc/systemd/system/droplet-storage-pool-apply.service ] || \
   [ -f /etc/polkit-1/rules.d/50-droplet-device-bridge.rules ]; then
  sudo rm -f /usr/local/sbin/droplet-storage-pool-apply.sh 2>/dev/null || true
  sudo rm -f /etc/systemd/system/droplet-storage-pool-apply.service 2>/dev/null || true
  sudo rm -f /etc/polkit-1/rules.d/50-droplet-device-bridge.rules 2>/dev/null || true
  sudo systemctl daemon-reload 2>/dev/null || true
  log_success "Removed storage-pool apply unit, root executor, and bridge polkit rules"
fi

# Single-box hostapd Wi-Fi-write host script (WARP-808). Remove so a factory
# reset truly returns to out-of-box; install-device-bridge.sh reinstalls it on
# re-provision. The customer's SSID/PSK lives in the attach env file, which the
# .env wipe + setup wizard re-seed handles separately; this removes the executor
# only.
if [ -f /usr/local/sbin/droplet-set-hostapd.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-set-hostapd.sh 2>/dev/null || true
  log_success "Removed hostapd Wi-Fi-write host script"
fi

# Factory-reset host executor (WARP-825). Remove so a reset truly returns to
# out-of-box; install-device-bridge.sh reinstalls it on re-provision. This is
# the executor the dashboard Danger Zone reaches via the device-bridge — it is
# the script invoking us right now (we run via `exec`- less delegation, so by
# the time this line runs the wrapper has already handed control to this
# canonical script). Removing it is safe and self-cleaning; it reinstalls on
# the next setup.sh.
if [ -f /usr/local/sbin/droplet-factory-reset.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-factory-reset.sh 2>/dev/null || true
  log_success "Removed factory-reset host executor"
fi

# TLS-reload host executor (ADR-023 C2). Remove so a reset truly returns to
# out-of-box; install-device-bridge.sh reinstalls it on re-provision. It only
# triggers `nginx -s reload` — removing it touches no certs or data.
if [ -f /usr/local/sbin/droplet-tls-reload.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-tls-reload.sh 2>/dev/null || true
  log_success "Removed TLS-reload host executor"
fi

# Public-FQDN write-back host executor (ADR-023 PR-1). Remove so a reset truly
# returns to out-of-box; install-device-bridge.sh reinstalls it on re-provision.
# It only persists DROPLET_PUBLIC_FQDN to .env + re-registers DNS — the .env
# itself is wiped elsewhere in this reset, so the box re-learns its name from HQ.
if [ -f /usr/local/sbin/droplet-set-public-fqdn.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-set-public-fqdn.sh 2>/dev/null || true
  log_success "Removed public-FQDN write-back host executor"
fi

# Box-name write-back host executor (WARP-988). Remove so a reset truly
# returns to out-of-box; install-device-bridge.sh reinstalls it on
# re-provision. It only persists DROPLET_BOX_NAME to .env — the .env itself is
# wiped elsewhere in this reset, so the next owner names the box afresh.
if [ -f /usr/local/sbin/droplet-set-box-name.sh ]; then
  sudo rm -f /usr/local/sbin/droplet-set-box-name.sh 2>/dev/null || true
  log_success "Removed box-name write-back host executor"
fi

# Device-bridge state + logs (needs sudo because systemd StateDirectory
# runs as root). Silent if not installed — dev machines won't have this.
if [ -d /var/lib/droplet-bridge ] || [ -f /etc/droplet/device-bridge.env ]; then
  # Stop the bridge + rotation timer before wiping state so they don't
  # race us writing back. WARP-843: also stop the attach env-file watcher —
  # the /var/lib/droplet-bridge wipe below removes the customer creds file the
  # path unit watches, and stopping it first prevents a spurious mid-reset AP
  # re-apply (the unit stays enabled, so it resumes watching on the next boot).
  sudo systemctl stop droplet-wifi-rotate.timer 2>/dev/null || true
  sudo systemctl stop droplet-device-bridge.service 2>/dev/null || true
  sudo systemctl stop droplet-openwrt-attach.path 2>/dev/null || true
  # /var/lib/droplet-bridge holds the rotation timestamp + key digest AND the
  # wizard's customer Wi-Fi creds (openwrt-attach.env — WARP-843). Wiping it
  # returns the AP to the /etc/default provisioning SSID on the next attach run.
  # systemd will recreate the directory on next start via StateDirectory=.
  sudo rm -rf /var/lib/droplet-bridge 2>/dev/null || true
  # The env file carries the auth token + OpenWrt password — regenerate
  # from the repo example on re-setup. We only remove the populated
  # copy, not the example template in the repo.
  sudo rm -f /etc/droplet/device-bridge.env 2>/dev/null || true
  # The persisted per-box AP PSK (WARP-819). A customer Wi-Fi password set
  # via the wizard gets persisted here too (resolve_ap_psk in
  # droplet-openwrt-attach), so a factory reset must remove it — the next
  # attach run then generates a FRESH per-box PSK, i.e. true factory state
  # (PR #551 review). The wizard-written customer creds themselves live in the
  # bridge StateDirectory (openwrt-attach.env) and are already covered by the
  # /var/lib/droplet-bridge wipe above; with that gone and ap-psk removed, the
  # next attach run falls back to the /etc/default provisioning SSID + a fresh
  # per-box PSK. /etc/default/droplet-openwrt-attach stays root-owned operator
  # config and is deliberately NOT rewritten here.
  sudo rm -f /etc/droplet/ap-psk 2>/dev/null || true
  # Log files. These grow over time and can contain the current wifi
  # key's sha256 digest on "rotated" lines; nothing sensitive but
  # no reason to keep logs that pre-date the reset.
  sudo rm -f /var/log/droplet-device-bridge.log \
             /var/log/droplet-wifi-rotate.log 2>/dev/null || true
  log_success "Removed device-bridge state, env, and logs"
fi

log_divider

# =============================================================================
# Phase 4: Done
# =============================================================================

log_step 4 4 "Factory reset complete"

log_divider
printf "\n"
printf "  ${_GREEN}${_BOLD}Factory reset complete.${_RESET}\n"
printf "\n"
printf "  All user data, credentials, and configuration have been erased.\n"
printf "  The device is now in a clean, out-of-the-box state.\n"
printf "\n"

if [ "$REINSTALL" = "true" ]; then
  printf "  ${_CYAN}Running setup to re-provision...${_RESET}\n"
  printf "\n"
  log_divider
  printf "\n"
  exec "$SCRIPT_DIR/setup.sh" --skip-docker
fi

printf "  To re-provision the device, run:\n"
printf "\n"
printf "    ${_BOLD}./scripts/setup.sh --skip-docker${_RESET}\n"
printf "\n"
printf "  This will generate new secrets, rebuild, and start the stack.\n"
printf "  The first visit will redirect to the setup wizard.\n"
printf "\n"
log_divider
printf "\n"
