#!/usr/bin/env bash
# =============================================================================
# Droplet Edge Platform — Device Setup Script
# =============================================================================
#
# Provisions a fresh device (or dev machine) with everything needed to run the
# Droplet edge platform: Docker, unique per-device secrets, built container
# images, and a running stack.
#
# Usage:
#   ./scripts/setup.sh [OPTIONS]
#
# Options:
#   --skip-docker      Skip Docker installation (assume already installed)
#   --skip-build       Skip building container images
#   --skip-drivers     Skip camera-driver / kernel-module setup
#   --skip-start       Skip starting the Docker Compose stack
#   --systemd          Install systemd service for auto-start on boot
#   --regenerate-env   Force-regenerate .env (backs up existing)
#   --sync-secrets     Only rewrite Docker secret files from .env, then exit
#   --verbose          Show full command output
#   --dry-run          Show what would be done without executing
#   -h, --help         Show this help message
#
# Idempotent — safe to re-run. Skips steps that are already complete.
# =============================================================================
set -euo pipefail

# --- Resolve paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT

# --- Parse arguments ---
SKIP_DOCKER=false
SKIP_BUILD=false
SKIP_DRIVERS=false
SKIP_START=false
INSTALL_SYSTEMD=false
REGENERATE_ENV=false
SYNC_SECRETS_ONLY=false
VERBOSE=false
DRY_RUN=false
# Single-box deployment shape — tri-state. "" = auto-detect; "true" = force on; "false" = force off.
SINGLE_BOX_MODE=""
export VERBOSE REGENERATE_ENV

usage() {
  cat << 'USAGE'
Usage: ./scripts/setup.sh [OPTIONS]

Options:
  --skip-docker      Skip Docker installation (assume already installed)
  --skip-build       Skip building container images
  --skip-drivers     Skip camera-driver / kernel-module setup
  --skip-start       Skip starting the Docker Compose stack
  --systemd          Install systemd service for auto-start on boot
                     (auto-enabled when single-box mode is detected)
  --single-box       Force single-box deployment shape (installs captured
                     host scripts, writes single-box knobs to .env,
                     activates the `single-box` compose profile).
                     Auto-detected on Linux hosts with dGPU + iGPU and
                     no separate Jetson on the LAN; use this to force or
                     skip auto-detect.
  --no-single-box    Force single-box off (multi-box / v2-6 deployment).
  --regenerate-env   Force-regenerate .env (backs up existing)
  --sync-secrets     Only rewrite Docker secret files from .env, then exit
  --verbose          Show full command output
  --dry-run          Show what would be done without executing
  -h, --help         Show this help message

Idempotent — safe to re-run. Skips steps that are already complete.
See docs/SINGLE_BOX.md for the single-box deployment matrix.
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-docker)      SKIP_DOCKER=true; shift ;;
    --skip-build)       SKIP_BUILD=true; shift ;;
    --skip-drivers)     SKIP_DRIVERS=true; shift ;;
    --skip-start)       SKIP_START=true; shift ;;
    --systemd)          INSTALL_SYSTEMD=true; shift ;;
    --single-box)       SINGLE_BOX_MODE=true; shift ;;
    --no-single-box)    SINGLE_BOX_MODE=false; shift ;;
    --regenerate-env)   REGENERATE_ENV=true; shift ;;
    --sync-secrets)     SYNC_SECRETS_ONLY=true; shift ;;
    --verbose)          VERBOSE=true; shift ;;
    --dry-run)          DRY_RUN=true; VERBOSE=true; shift ;;
    -h|--help)          usage ;;
    *)                  echo "Unknown option: $1"; usage ;;
  esac
done

# --- Source library modules ---
# shellcheck source=lib/logging.sh
source "$SCRIPT_DIR/lib/logging.sh"
# shellcheck source=lib/preflight.sh
source "$SCRIPT_DIR/lib/preflight.sh"
# shellcheck source=lib/docker.sh
source "$SCRIPT_DIR/lib/docker.sh"
# shellcheck source=lib/secrets.sh
source "$SCRIPT_DIR/lib/secrets.sh"
# shellcheck source=lib/compose.sh
source "$SCRIPT_DIR/lib/compose.sh"
# shellcheck source=lib/systemd.sh
source "$SCRIPT_DIR/lib/systemd.sh"
# shellcheck source=lib/camera-drivers.sh
source "$SCRIPT_DIR/lib/camera-drivers.sh"
# shellcheck source=lib/local-dns.sh
source "$SCRIPT_DIR/lib/local-dns.sh"
# shellcheck source=lib/single-box.sh
source "$SCRIPT_DIR/lib/single-box.sh"

# --- Single-box mode resolution ---
# Either the user forced it via --single-box/--no-single-box, or we auto-detect.
# The resolved value drives: (a) install_single_box_host_integration,
# (b) configure_single_box_env, (c) auto-enabling --systemd, (d) the .env
# activation of COMPOSE_PROFILES=single-box.
if [ -z "$SINGLE_BOX_MODE" ]; then
  if detect_single_box_mode; then
    SINGLE_BOX_MODE=true
    log_info "single-box mode auto-detected: $SINGLE_BOX_DETECTION_REASON"
  else
    SINGLE_BOX_MODE=false
    log_info "single-box mode skipped: $SINGLE_BOX_DETECTION_REASON"
  fi
elif [ "$SINGLE_BOX_MODE" = "true" ]; then
  log_info "single-box mode forced on (--single-box)"
else
  log_info "single-box mode forced off (--no-single-box)"
fi

# Auto-enable systemd auto-start in single-box mode — the user vision is
# "plug WAN, everything just works", and without systemd the stack doesn't
# survive a reboot.
if [ "$SINGLE_BOX_MODE" = "true" ] && [ "$INSTALL_SYSTEMD" = "false" ]; then
  INSTALL_SYSTEMD=true
  log_info "single-box mode: auto-enabling --systemd for boot-time stack start"
fi

# --- Sync-secrets short-circuit ---
# Runs the secret-file materializer without touching .env, Docker, or any
# service. Useful after editing .env to rotate OPENWRT_PASSWORD.
if [ "$SYNC_SECRETS_ONLY" = "true" ]; then
  log_info "Syncing setup artifacts from .env..."
  migrate_env
  materialize_artifacts
  log_success "Done. Restart affected containers for changes to take effect:"
  log_info "  docker compose -f docker/docker-compose.yml restart"
  # WARP-834 foot-gun guard: on the single-box, the OpenWrt root pw lives
  # INSIDE the container and is set by droplet-openwrt-attach to match this
  # secret. A bare `docker compose restart routing` after rotating
  # OPENWRT_PASSWORD makes routing present the NEW password to a container
  # whose root pw is still the OLD one -> ubus auth fails -> the router shows
  # OFFLINE (the WARP-826 symptom). Rotate via the attach service instead, so
  # the container root pw + routing restart move in lockstep:
  log_info "  If you rotated OPENWRT_PASSWORD on a single-box, run this INSTEAD"
  log_info "  of a bare 'restart routing' (sets the container root pw + restarts"
  log_info "  routing in lockstep):"
  log_info "    sudo systemctl restart droplet-openwrt-attach.service"
  exit 0
fi

# --- Lockfile ---
LOCK_FILE="$REPO_ROOT/.data/.setup.lock"

_acquire_lock() {
  mkdir -p "$(dirname "$LOCK_FILE")"
  if [ -f "$LOCK_FILE" ]; then
    local lock_age
    lock_age=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -gt 3600 ]; then
      log_warn "Removing stale lock file (${lock_age}s old)"
      rm -f "$LOCK_FILE"
    else
      log_error "Another setup is running (lock: $LOCK_FILE)"
      log_error "If this is a mistake, remove the lock: rm $LOCK_FILE"
      exit 1
    fi
  fi
  echo $$ > "$LOCK_FILE"
}

_release_lock() {
  rm -f "$LOCK_FILE"
}

# --- Error trap ---
_on_error() {
  log_error "Setup failed. See log: $LOG_FILE"
  _release_lock
  exit 1
}

# --- Dry run mode ---
if [ "$DRY_RUN" = "true" ]; then
  TOTAL_STEPS=7
  log_divider
  printf "\n  Droplet Edge Platform — Setup (DRY RUN)\n\n"
  log_divider

  log_step 1 $TOTAL_STEPS "Preflight checks"
  log_info "  Would check: OS, architecture, disk (>= 8 GB), memory (>= 2 GB), internet"

  log_step 2 $TOTAL_STEPS "Docker installation"
  if [ "$SKIP_DOCKER" = "true" ]; then
    log_info "  SKIPPED (--skip-docker)"
  else
    log_info "  Would install Docker Engine 25+ and Compose v2 if not present"
    log_info "  Would add user '$USER' to docker group if needed"
  fi

  log_step 3 $TOTAL_STEPS "Camera drivers"
  log_info "  Would install: v4l-utils, ffmpeg, usbutils"
  log_info "  Would load kernel modules: uvcvideo, videodev, videobuf2_v4l2"
  log_info "  Would persist modules for boot, install udev rules"
  log_info "  Would detect connected USB cameras"

  log_step 4 $TOTAL_STEPS "Secret generation"
  if [ -f "$REPO_ROOT/.env" ] && [ "$REGENERATE_ENV" != "true" ]; then
    log_info "  Would skip secret generation (.env already exists)"
    log_info "  Would migrate .env: backfill ROUTING_SERVICE_TOKEN, ROUTING_MODE,"
    log_info "                       SERVICE_TOKEN_VOICE if missing"
  else
    log_info "  Would generate secrets: POSTGRES_PASSWORD, REDIS_PASSWORD,"
    log_info "                  MQTT_PASSWORD, NEXTCLOUD_ADMIN_PASSWORD,"
    log_info "                  DEVICE_SECRET, DEVICE_SECRET_KEY,"
    log_info "                  JWT_SECRET, ROUTING_SERVICE_TOKEN,"
    log_info "                  SERVICE_TOKEN_VOICE"
    log_info "  Would write .env via heredoc (no .env.example dependency)"
  fi
  log_info "  Would materialize artifacts (idempotent): MQTT password file,"
  log_info "                  mosquitto.conf, TLS cert, docker/secrets/openwrt_password"
  if [ "$SINGLE_BOX_MODE" = "true" ]; then
    log_info "  single-box: would append COMPOSE_PROFILES=linux,single-box + knobs to .env"
    log_info "                  (FRIGATE_RENDER_NODE, OLLAMA_URL, OPENSSL_CONF=,"
    log_info "                  DROPLET_FIPS_REQUIRED=false, DROPLET_TPM_BACKEND=mock,"
    log_info "                  LLM_MODEL=gpt-oss:20b, OPENWRT_HOST/PORT/USERNAME,"
    log_info "                  ROUTING/SWITCH/DISPLAY_SERVICE_URL)"
    log_info "  single-box: would docker-network-inspect (create if absent) the"
    log_info "                  droplet_default bridge so its gateway is derivable at"
    log_info "                  Phase 4, before stack bring-up (compose adopts it on up)"
    log_info "  single-box: would pin ROUTING_SERVICE_URL (:8080), SWITCH_SERVICE_URL"
    log_info "                  (:8081), DISPLAY_SERVICE_URL (:8082) to the live"
    log_info "                  droplet_default gateway (derived from docker, never"
    log_info "                  hardcoded) — host-net services unreachable via the"
    log_info "                  host.docker.internal/docker0 default the multi-box keeps"
    log_info "  single-box: would install /usr/local/sbin/droplet-openwrt-attach +"
    log_info "                  droplet-poc-host-net + 2 systemd units + /etc/default/"
    log_info "                  configs + /etc/avahi/services/droplet.service"
    log_info "  single-box: would install automount udev rule → /etc/udev/rules.d/99-droplet-automount.rules"
    log_info "                  + droplet-automount@.service + mnt-droplet.mount → /etc/systemd/system/"
  fi

  log_step 5 $TOTAL_STEPS "Build container images"
  if [ "$SKIP_BUILD" = "true" ]; then
    log_info "  SKIPPED (--skip-build)"
  else
    log_info "  Would pull 7 base images and build 7 app images (orchestrator, web-dashboard,"
    log_info "                  ai-gateway, routing, file-indexer, switch, camera-discovery)"
    if [ "$SINGLE_BOX_MODE" = "true" ]; then
      log_info "                  + pull ollama/ollama:rocm + openwrt/rootfs:x86_64-24.10.2 (single-box profile)"
    fi
  fi

  log_step 6 $TOTAL_STEPS "Start stack"
  if [ "$SKIP_START" = "true" ]; then
    log_info "  SKIPPED (--skip-start)"
  else
    log_info "  Would start: db, cache, broker, gateway, orchestrator, web-dashboard,"
    log_info "               ai-gateway, nextcloud, routing"
    if [ "$(uname)" = "Linux" ]; then
      log_info "               + frigate (linux profile)"
    else
      log_info "               (frigate skipped — macOS, no GPU device node)"
    fi
    if [ "$SINGLE_BOX_MODE" = "true" ]; then
      log_info "               + ollama, openwrt (single-box profile)"
    fi
    log_info "  Would wait for health checks"
  fi

  log_step 7 $TOTAL_STEPS "Verify"
  log_info "  Would run ./scripts/verify.sh"
  log_info "  Would configure local DNS: mDNS (droplet-ai.local via host avahi)"
  log_info "                              + droplet-ai.lan via OpenWrt dnsmasq (if reachable)"

  if [ "$INSTALL_SYSTEMD" = "true" ]; then
    printf "\n"
    log_info "  Would install systemd service: droplet.service"
  fi

  printf "\n"
  log_divider
  exit 0
fi

# =============================================================================
# Main
# =============================================================================
main() {
  trap _on_error ERR

  _acquire_lock

  local total_steps=7
  [ "$SKIP_DOCKER" = "true" ] || true
  [ "$SKIP_BUILD" = "true" ] || true
  [ "$SKIP_START" = "true" ] || true

  log_divider
  printf "\n  ${_BOLD}Droplet Edge Platform — Setup${_RESET}\n\n"
  log_divider

  # --- Phase 1: Preflight ---
  log_step 1 $total_steps "Preflight checks"
  preflight_check

  # --- Phase 2: Docker ---
  log_step 2 $total_steps "Docker"
  if [ "$SKIP_DOCKER" = "true" ]; then
    log_info "Skipping Docker installation (--skip-docker)"
    log_divider
  else
    install_docker
    setup_docker_group
  fi
  # Decide once whether subsequent docker calls need sudo. Fails fast with a
  # clear error if docker is unreachable, instead of leaking a password prompt
  # from inside a later spinner or polling loop.
  detect_docker_sudo || exit 1

  # --- Phase 3: Camera Drivers ---
  log_step 3 $total_steps "Camera Drivers"
  if [ "$SKIP_DRIVERS" = "true" ]; then
    log_info "Skipping camera driver setup (--skip-drivers)"
    log_divider
  else
    install_camera_drivers
  fi

  # --- Phase 4: Secrets ---
  log_step 4 $total_steps "Secrets"
  generate_env
  # Self-heal pre-existing installs: backfill missing keys (e.g. WARP-36
  # ROUTING_SERVICE_TOKEN) and (re)materialize Docker bind-mount sources.
  # No-ops on a fresh install; recovers stale installs without --regenerate-env.
  migrate_env
  materialize_artifacts
  # Single-box mode: append single-box .env knobs so the `single-box`
  # compose profile activates and the patched services find the right
  # values. Idempotent — re-appends the same block; docker-compose
  # env_file uses the LAST occurrence of each key.
  # See scripts/lib/single-box.sh.
  if [ "$SINGLE_BOX_MODE" = "true" ]; then
    configure_single_box_env
  fi
  # WARP-230 device-identity first-boot enrollment. Idempotent —
  # exits 0 when /var/lib/droplet/tpm/provisioned.json already exists
  # or when running in dev with no TPM (mock backend, sidecar handles
  # the actual provisioning on first start).
  if [ -x "$SCRIPT_DIR/provision-device-identity.sh" ]; then
    bash "$SCRIPT_DIR/provision-device-identity.sh" \
      || log_warn "device-identity provisioning script exited non-zero (continuing)"
  fi
  # Single-box mode: install captured host scripts + systemd units for the
  # in-container OpenWrt AP attach + br-lan DHCP. Idempotent. Skipped
  # silently on non-Linux hosts. See scripts/lib/single-box.sh +
  # scripts/host/.
  if [ "$SINGLE_BOX_MODE" = "true" ]; then
    install_single_box_host_integration
    # Front-panel (PyPortal Titano) host integration: the shutdown-screen
    # systemd hook (pushes "Shutting down" / "Safe to power off" on teardown)
    # plus the device-bridge. Non-fatal — the dashboard and the oled-display
    # container still run without it. install-device-bridge.sh is idempotent,
    # self-elevates with sudo, auto-provisions the host pairing-QR dep
    # (python3-qrcode) plus the single-box DROPLET_AP_MODE=hostapd knob, and
    # enables the bridge unconditionally (the shutdown screen needs no deps).
    # NOTE: this does
    # NOT flash the board's CircuitPython firmware — that is a deliberate
    # ./scripts/flash-pyportal.sh step (a write-locked board needs a physical
    # UF2/safe-mode flash, so it must not run unattended here).
    if [ -x "$SCRIPT_DIR/install-device-bridge.sh" ]; then
      "$SCRIPT_DIR/install-device-bridge.sh" \
        || log_warn "front-panel host integration had issues (continuing)"
    fi
    # USB/NVMe hot-plug auto-mount. Installs the udev rule +
    # droplet-automount@.service so a drive added or swapped at runtime
    # auto-mounts under /mnt/droplet and surfaces in the dashboard (the
    # device-bridge merges the automount state with /proc/mounts). Idempotent;
    # needs root for /etc/udev + /etc/systemd, so run under sudo. Non-fatal —
    # the box still serves without hot-plug mounting. install.sh deliberately
    # does NOT sweep already-attached drives (a provisioning foot-gun); the
    # first mount of an existing drive happens on the next hot-plug/reboot, and
    # the opt-in setup "adopt drives" step handles deliberate wipe+adopt.
    if [ -f "$REPO_ROOT/services/automount/install.sh" ]; then
      sudo bash "$REPO_ROOT/services/automount/install.sh" \
        || log_warn "USB auto-mount install had issues (continuing)"
    fi
  fi

  # --- Phase 5: Build ---
  log_step 5 $total_steps "Build"
  if [ "$SKIP_BUILD" = "true" ]; then
    log_info "Skipping build (--skip-build)"
    log_divider
  else
    prepare_and_build
  fi

  # --- Phase 6: Start ---
  log_step 6 $total_steps "Start"
  if [ "$SKIP_START" = "true" ]; then
    log_info "Skipping start (--skip-start)"
    log_divider
  else
    start_stack
  fi

  # Single-box: (re)provision the OpenWrt container now that start_stack
  # (re)created it. The boot-time oneshot droplet-openwrt-attach does not fire
  # on a no-reboot re-provision, so trigger it here or routing crash-loops
  # against an unprovisioned openwrt (WARP-578).
  if [ "$SINGLE_BOX_MODE" = "true" ] && [ "$SKIP_START" != "true" ]; then
    provision_single_box_openwrt
  fi

  # --- Workspace settings seeder (WARP-457) ---
  # Idempotent first-boot hook for the WorkspaceSetting table. The
  # orchestrator's app.ts already invokes this at every start; calling
  # it here from setup.sh makes the install path's intent explicit
  # ("the settings table is bootstrapped before verify runs") and
  # surfaces a clean log entry in the install transcript. Re-running
  # is safe — the underlying seeder is insert-or-skip (createMany +
  # skipDuplicates) and operator-edited values are never overwritten.
  #
  # WARP-484: capture the seeder's combined stdout+stderr in a variable
  # and explicitly branch on the exit code. The previous form piped
  # through `grep ... || true`, which the shell rewrites as "ignore
  # every exit code in the pipeline" — a real failure surfaced as a
  # silent green log line. The variable-capture form preserves
  # `set -euo pipefail` while still treating seeder failure as a warn
  # (the install continues; verify.sh runs next and surfaces follow-on
  # damage if any).
  if [ "$SKIP_START" != "true" ]; then
    log_info "Seeding workspace settings (WARP-457; idempotent)..."
    seeder_out=""
    seeder_rc=0
    seeder_out=$(run_docker_compose -f "$REPO_ROOT/docker/docker-compose.yml" \
                   --env-file "$REPO_ROOT/.env" \
                   exec -T orchestrator npm run --silent seed 2>&1) || seeder_rc=$?
    if [ "$seeder_rc" -eq 0 ]; then
      if printf '%s\n' "$seeder_out" | grep -qE "Workspace settings|Seed data"; then
        log_success "Workspace settings seeder completed"
      else
        # Exit 0 but no recognizable output — surface the transcript so
        # an operator can decide whether the orchestrator silently
        # changed shape. Not a failure, but not a clean pass either.
        log_warn "Workspace settings seeder returned 0 but emitted no recognizable output"
        printf '%s\n' "$seeder_out" | head -20 >&2
      fi
    else
      log_warn "Workspace settings seeder failed (exit $seeder_rc):"
      printf '%s\n' "$seeder_out" | head -20 >&2
      log_warn "Continuing install — verify.sh will surface follow-on damage if any. Check: docker compose logs orchestrator"
    fi
    unset seeder_out seeder_rc
  fi

  # --- Phase 7: Verify ---
  log_step 7 $total_steps "Verify"
  if [ "$SKIP_START" != "true" ] && [ -x "$SCRIPT_DIR/verify.sh" ]; then
    "$SCRIPT_DIR/verify.sh" || log_warn "Some verification checks failed — see output above"
  else
    log_info "Skipping verification (stack not started or verify.sh not found)"
  fi

  # --- Local DNS (mDNS + router dnsmasq) ---
  # Runs after the stack is up so the routing service is ready to accept the
  # `droplet.lan` registration. Non-fatal: a missing router or mDNS failure
  # only downgrades discovery, it doesn't break the install.
  if [ "$SKIP_START" != "true" ]; then
    # Source the materialized .env so ROUTING_SERVICE_URL / ROUTING_SERVICE_TOKEN
    # / OPENWRT_HOST / ROUTING_MODE are in scope for setup_local_dns.
    if [ -f "$REPO_ROOT/.env" ]; then
      set -a
      # shellcheck disable=SC1091
      . "$REPO_ROOT/.env"
      set +a
    fi
    setup_local_dns || log_warn "Local DNS bootstrap had issues — see above"
  fi

  # --- Systemd (optional) ---
  if [ "$INSTALL_SYSTEMD" = "true" ]; then
    printf "\n"
    log_info "Installing systemd service..."
    install_systemd_service
  fi

  # --- Done ---
  _release_lock

  log_divider
  printf "\n"
  printf "  ${_BOLD}${_GREEN}Droplet Edge Platform — Setup Complete${_RESET}\n"
  printf "\n"
  printf "  Dashboard:     ${_CYAN}https://droplet-ai.local${_RESET} (mDNS) or ${_CYAN}https://droplet-ai.lan${_RESET} (router DNS)\n"
  printf "                 ${_DIM}https://localhost also works on this device${_RESET}\n"
  printf "  API:           ${_CYAN}https://droplet-ai.local/api/health${_RESET}\n"
  printf "\n"
  printf "  ${_BOLD}To silence the browser \"Not secure\" warning${_RESET} (one-time, per client):\n"
  printf "    macOS / Linux: ${_CYAN}./scripts/trust-droplet-cert.sh${_RESET}\n"
  printf "    Windows:       ${_CYAN}powershell -ExecutionPolicy Bypass -File scripts\\trust-droplet-cert.ps1${_RESET}  ${_DIM}(run as Administrator)${_RESET}\n"
  printf "  The script downloads the Droplet's self-signed cert and installs it\n"
  printf "  into your OS trust store — the Droplet signs for droplet-ai.local,\n"
  printf "  droplet-ai.lan, droplet.local, droplet.lan, localhost, and LAN IPs.\n"
  printf "\n"
  printf "  Open the dashboard to complete setup — a guided wizard\n"
  printf "  will walk you through creating your admin account.\n"
  printf "\n"
  printf "  Device secrets: ${_DIM}%s/.env${_RESET} (chmod 600)\n" "$REPO_ROOT"

  if [ "$DOCKER_GROUP_ADDED" = "true" ]; then
    printf "\n"
    printf "  ${_YELLOW}NOTE${_RESET}: You were added to the 'docker' group.\n"
    printf "  Log out and back in (or run ${_BOLD}newgrp docker${_RESET}) to use\n"
    printf "  docker commands without sudo.\n"
  fi

  printf "\n"
  log_divider
  printf "  Log file: ${_DIM}%s${_RESET}\n" "$LOG_FILE"
  log_divider
  printf "\n"
}

main "$@"
