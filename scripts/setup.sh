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
# WARP-318 FIPS 140-3 per-customer knob — tri-state. "" = leave whatever .env
# already has (a re-run WITHOUT --fips/--no-fips is a no-op on FIPS, never a
# silent flip); "true" = force ON (--fips); "false" = force OFF (--no-fips).
FIPS_MODE=""
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
                     no separate inference host on the LAN; use this to force or
                     skip auto-detect.
  --no-single-box    Force single-box off (multi-box / v2-6 deployment).
  --fips             Activate FIPS 140-3 mode (per-customer, default OFF).
                     Sets DROPLET_FIPS_MODE=1 in .env; setup.sh derives the
                     per-service OPENSSL_CONF / DROPLET_FIPS_REQUIRED /
                     NODE_OPTIONS from it (OPENSSL_MODULES is actively
                     removed — WARP-1063; see docs/fips.md). The validated
                     OpenSSL FIPS provider (CMVP #4282) already ships in every
                     image, so NO rebuild is needed — on an existing box:
                     ./scripts/setup.sh --fips --skip-docker --skip-build
                     --skip-drivers  (rewrites .env, restarts the stack).
                     FIPS RESTRICTS algorithms for certification; it does not
                     add strength. See docs/fips.md.
  --no-fips          Deactivate FIPS mode (DROPLET_FIPS_MODE=0). Restores the
                     default modern-crypto posture (TLS 1.3, OpenSSL defaults).
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
    --fips)             FIPS_MODE=true; shift ;;
    --no-fips)          FIPS_MODE=false; shift ;;
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
# shellcheck source=lib/tls-reload.sh
source "$SCRIPT_DIR/lib/tls-reload.sh"
# shellcheck source=lib/secrets.sh
source "$SCRIPT_DIR/lib/secrets.sh"
# shellcheck source=lib/compose.sh
source "$SCRIPT_DIR/lib/compose.sh"
# shellcheck source=lib/systemd.sh
source "$SCRIPT_DIR/lib/systemd.sh"
# shellcheck source=lib/camera-drivers.sh
source "$SCRIPT_DIR/lib/camera-drivers.sh"
# shellcheck source=lib/bluetooth.sh
source "$SCRIPT_DIR/lib/bluetooth.sh"
# shellcheck source=lib/local-dns.sh
source "$SCRIPT_DIR/lib/local-dns.sh"
# shellcheck source=lib/single-box.sh
source "$SCRIPT_DIR/lib/single-box.sh"
# shellcheck source=lib/backup.sh
source "$SCRIPT_DIR/lib/backup.sh"
# shellcheck source=lib/luks.sh
source "$SCRIPT_DIR/lib/luks.sh"

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
  log_success "Done. Restart affected containers to apply changes:"
  # WARP-834 foot-gun guard: on the single-box, the OpenWrt root pw lives
  # INSIDE the container and is set by droplet-openwrt-attach to match this
  # secret. A bare `docker compose restart routing` after rotating
  # OPENWRT_PASSWORD makes routing present the NEW password to a container
  # whose root pw is still the OLD one -> ubus auth fails -> the router shows
  # OFFLINE (the WARP-826 symptom). Rotate via the attach service instead, so
  # the container root pw + routing restart move in lockstep.
  # Print this WARNING first so an operator who just rotated OPENWRT_PASSWORD
  # sees the safe path before the generic restart command.
  log_warn "  If you rotated OPENWRT_PASSWORD on a single-box, run this INSTEAD"
  log_warn "  of a bare 'restart routing' (sets the container root pw + restarts"
  log_warn "  routing in lockstep):"
  log_warn "    sudo systemctl restart droplet-openwrt-attach.service"
  log_info "  For all other secret rotations:"
  log_info "    docker compose -f docker/docker-compose.yml restart"
  exit 0
fi

# --- Lockfile ---
LOCK_FILE="$REPO_ROOT/.data/.setup.lock"

_acquire_lock() {
  mkdir -p "$(dirname "$LOCK_FILE")"
  if [ -f "$LOCK_FILE" ]; then
    local lock_pid lock_age
    lock_pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    # Stale-aware reclaim: if the recorded PID is empty/garbage or no longer
    # alive, the previous run died (a SIGKILL or power loss bypasses the EXIT
    # trap below) and stranded its lock — reclaim it instead of refusing. This
    # is what made the box un-reprovisionable after an interrupted setup.
    if [ -z "$lock_pid" ] || ! kill -0 "$lock_pid" 2>/dev/null; then
      log_warn "Reclaiming stale lock (pid ${lock_pid:-unreadable} not alive)"
      rm -f "$LOCK_FILE"
    else
      # PID is alive — a real concurrent run, or (rarely) PID reuse by an
      # unrelated process. Fall back to the age guard so even a reused-PID
      # lock clears after an hour rather than blocking forever.
      lock_age=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
      if [ "$lock_age" -gt 3600 ]; then
        log_warn "Removing stale lock file (${lock_age}s old)"
        rm -f "$LOCK_FILE"
      else
        log_error "Another setup is running (lock: $LOCK_FILE, pid: $lock_pid)"
        log_error "If this is a mistake, remove the lock: rm $LOCK_FILE"
        exit 1
      fi
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
  # Lock release is handled by the EXIT trap (set right after _acquire_lock),
  # so it runs on EVERY exit path — not just this one. exit here fires it.
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
  log_info "  Would prep host Bluetooth for Matter BLE commissioning (WARP-850):"
  log_info "                  install bluez + rfkill, enable bluetooth.service,"
  log_info "                  rfkill unblock bluetooth, power on the adapter"

  log_step 4 $TOTAL_STEPS "Secret generation"
  if [ -f "$REPO_ROOT/.env" ] && [ "$REGENERATE_ENV" != "true" ]; then
    log_info "  Would skip secret generation (.env already exists)"
    log_info "  Would migrate .env: backfill ROUTING_SERVICE_TOKEN, ROUTING_MODE,"
    log_info "                       SERVICE_TOKEN_VOICE if missing"
  else
    log_info "  Would generate secrets: POSTGRES_PASSWORD, REDIS_PASSWORD,"
    log_info "                  NEXTCLOUD_ADMIN_PASSWORD,"
    log_info "                  DEVICE_SECRET, DEVICE_SECRET_KEY,"
    log_info "                  JWT_SECRET, ROUTING_SERVICE_TOKEN,"
    log_info "                  SERVICE_TOKEN_VOICE"
    log_info "  Would write .env via heredoc (no .env.example dependency)"
  fi
  log_info "  Would materialize artifacts (idempotent): mosquitto.conf +"
  log_info "                  mosquitto.acl (WARP-235 mTLS broker, per-CN topic grants),"
  log_info "                  TLS cert, docker/secrets/openwrt_password,"
  log_info "                  data/secrets/audit.key + data/secrets/email.key"
  log_info "                  WARP-236: internal CA (data/secrets/internal-ca) +"
  log_info "                  per-service TLS bundles (data/secrets/service-tls/<svc>)"
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
    log_info "                  droplet-host-net + 2 systemd units + /etc/default/"
    log_info "                  configs + /etc/avahi/services/droplet.service"
    log_info "  single-box: would install automount udev rule → /etc/udev/rules.d/99-droplet-automount.rules"
    log_info "                  + droplet-automount@.service + mnt-droplet.mount → /etc/systemd/system/"
  fi
  log_info "  Would install restic backups (WARP-254, Linux only): restic +"
  log_info "                  /usr/local/sbin/droplet-{backup,restore,restore-drill}.sh +"
  log_info "                  6 systemd units (daily 03:15 / weekly-full Sun 04:15 /"
  log_info "                  monthly restore drill), repo key derived from device identity"

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
  # Release the lock on ANY exit (success, error, or `set -e` abort). The ERR
  # trap fires only on a failed command; the benign "seeder failed (exit 1)"
  # path and other non-error early exits would otherwise leave .setup.lock
  # behind and make the next run abort with "Another setup is running".
  # Set AFTER a successful acquire so we never delete another run's lock.
  trap _release_lock EXIT

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

  # --- Phase 1.5: Encrypted data partition (WARP-232) ---
  # Provision the LUKS2/Argon2id data LV + TPM-sealed unlock BEFORE Docker, so
  # a fresh appliance's docker daemon.json data-root lands on the encrypted
  # /data before any image exists. Idempotent; refuses loudly without a TPM
  # (data stays plain), skipped silently on non-Linux. See scripts/lib/luks.sh.
  install_luks_data_partition \
    || log_warn "LUKS data-partition provisioning had issues (continuing)"

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

  # WARP-850: host Bluetooth prep for the matter-controller sidecar's
  # BLE commissioning (bluez + bluetoothd enabled/active + rfkill
  # unblock + adapter powered). Idempotent and non-fatal — a box
  # without Bluetooth still ships IP-only Matter. Rides the same
  # --skip-drivers escape hatch as the camera modules (both are
  # host-hardware prep).
  if [ "$SKIP_DRIVERS" = "true" ]; then
    log_info "Skipping Bluetooth host prep (--skip-drivers)"
    log_divider
  else
    setup_bluetooth_host
  fi

  # --- Phase 4: Secrets ---
  log_step 4 $total_steps "Secrets"
  generate_env
  # Self-heal pre-existing installs: backfill missing keys (e.g. WARP-36
  # ROUTING_SERVICE_TOKEN) and (re)materialize Docker bind-mount sources.
  # No-ops on a fresh install; recovers stale installs without --regenerate-env.
  migrate_env
  materialize_artifacts
  # WARP-232: once /data is a real encrypted mount, relocate the crypto-
  # sensitive secrets (.env carries DEVICE_SECRET_KEY → restic password;
  # data/secrets carries the audit key) onto it and symlink them back, so
  # "disk removed + mounted elsewhere yields no readable data" holds for the
  # derivation inputs too. No-op unless /data is the LUKS mapper. Idempotent.
  relocate_secrets_to_data \
    || log_warn "secrets relocation onto /data had issues (continuing)"
  # Single-box mode: append single-box .env knobs so the `single-box`
  # compose profile activates and the patched services find the right
  # values. Idempotent — re-appends the same block; docker-compose
  # env_file uses the LAST occurrence of each key.
  # See scripts/lib/single-box.sh.
  if [ "$SINGLE_BOX_MODE" = "true" ]; then
    configure_single_box_env
  fi
  # WARP-318: FIPS 140-3 per-customer activation. Only acts when the operator
  # EXPLICITLY passed --fips / --no-fips (FIPS_MODE tri-state; "" = leave .env
  # as-is, so a re-run without the flag never silently flips FIPS). Runs AFTER
  # configure_single_box_env so an explicit --fips overrides the single-box
  # shape's default `OPENSSL_CONF=`/`DROPLET_FIPS_REQUIRED=false` (operator
  # intent wins over shape default). apply_fips_mode rewrites the derived env
  # atomically; compose reads the resulting .env on the stack bring-up below,
  # so NO image rebuild is needed to flip.
  if [ "$FIPS_MODE" = "true" ]; then
    log_info "FIPS mode: ON (DROPLET_FIPS_MODE=1) — activating validated OpenSSL provider"
    apply_fips_mode on
  elif [ "$FIPS_MODE" = "false" ]; then
    log_info "FIPS mode: OFF (DROPLET_FIPS_MODE=0) — default modern-crypto posture"
    apply_fips_mode off
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

  # WARP-254 restic backup: host scripts + systemd timers (daily incremental,
  # weekly full, monthly sandboxed restore drill), repository key derived from
  # the device identity secret. EVERY Linux deployment shape gets backups (not
  # just single-box) — skipped silently on non-Linux dev hosts. Idempotent;
  # non-fatal so a transient apt/systemd hiccup never blocks provisioning
  # (re-running setup.sh self-heals). See scripts/lib/backup.sh.
  install_restic_backup \
    || log_warn "restic backup host integration had issues (continuing)"

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

  # --- Leave no host unit running stale code (WARP-1829) ---
  # Host units execute their source straight out of THIS checkout —
  # droplet-device-bridge.service runs
  # `/usr/bin/python3 $REPO_ROOT/services/oled-display/device-bridge.py` —
  # and everything above has just refreshed that source. Python reads a file
  # once, at process start, so a host unit still running from before this
  # provision would keep running the old code forever, silently: the file on
  # disk is correct and `systemctl status` says active (running). Only the
  # process disagrees.
  #
  # This restarts ONLY units whose sources actually moved, one attempt each,
  # verifying every one came back (scripts/host/droplet-host-units.sh). On a
  # normal provision it is a NO-OP — install-device-bridge.sh already
  # restarted the bridge and install_single_box_host_integration already
  # restarted host-net/egress-audit, so nothing is stale by the time we get
  # here. It earns its keep on every path that updates the checkout WITHOUT
  # re-running those installers, which is how the bug shipped in the first
  # place.
  #
  # Non-fatal: the script logs CRITICAL for any unit that does not come back
  # and the droplet-watchdog `host_unit_staleness` check keeps reporting it —
  # that must not flip an otherwise-good provision into a failed run.
  if [ -x /usr/local/sbin/droplet-host-units ]; then
    log_info "Checking for host units left running stale code (WARP-1829)..."
    sudo /usr/local/sbin/droplet-host-units refresh \
      || log_warn "A host unit did not come back after its restart — run 'sudo droplet-host-units check' and 'systemctl status <unit>'"
  fi

  # --- Leave nothing stale on the box ---
  # The .env safety copies secrets.sh writes mid-run (pre-migration backups,
  # torn-file quarantines, staging strays) exist so an INTERRUPTED run can
  # converge on the next attempt. Once the run reaches this point the live
  # .env is authoritative — remove the copies so a green provision leaves
  # zero artifacts (they carry the same device secrets as .env). An
  # interrupted run never reaches this line, so the torn-write recovery in
  # scripts/lib/secrets.sh keeps its backup to restore from.
  # Carve-out: a --regenerate-env run KEEPS .env.bak.* — that backup is the
  # documented recovery path when data volumes still hold the pre-rotation
  # passwords (see scripts/README.md "What is NOT guaranteed").
  if [ "$REGENERATE_ENV" != "true" ]; then
    for _stale in "$REPO_ROOT"/.env.bak.*; do
      [ -f "$_stale" ] || continue
      # `rm -f` swallows a missing file, but a REAL removal failure (e.g. a
      # root-owned backup an earlier privileged run left that this non-root run
      # cannot unlink) still returns non-zero. As a bare statement under
      # `set -e` that would abort AFTER a good provision but BEFORE the "Setup
      # Complete" banner — flipping a green run to a reported failure, the
      # inverse of what WARP-1309 guarantees. Guard so cleanup can never abort
      # (matches scripts/factory-reset.sh's non-essential-cleanup convention).
      rm -f "$_stale" 2>/dev/null || true
      log_info "Removed $(basename "$_stale") (mid-run .env copy — run succeeded)"
    done
  fi
  # Each pattern below is produced by a real writer that stages onto a sibling
  # then rename(2)s into place; an interrupted run strands the sibling, and it
  # carries the same device secrets as .env. Named writers (scripts/lib/):
  #   .env.torn.*    — secrets.sh generate_env torn-file quarantine ("$env_file.torn.$(date +%s)")
  #   .env.tmp.*     — secrets.sh atomic .env write ("$env_write_target.tmp.$$")
  #   .env.migrate.* — secrets.sh migrate_env backfill stage ("$env_file.migrate.$$")
  #   .env.upsert.*  — secrets.sh _upsert_env_kv / single-box.sh configure_single_box_env ("$target.upsert.$$")
  # factory-reset.sh wipes the identical set — both sites clear secrets-bearing strays.
  for _stale in "$REPO_ROOT"/.env.torn.* \
                "$REPO_ROOT"/.env.tmp.* \
                "$REPO_ROOT"/.env.migrate.* \
                "$REPO_ROOT"/.env.upsert.*; do
    [ -f "$_stale" ] || continue
    # Same set -e abort hazard as the .env.bak.* rm above — guard it too.
    rm -f "$_stale" 2>/dev/null || true
    log_info "Removed $(basename "$_stale") (stale .env staging copy)"
  done

  # --- Done ---
  # Lock is released by the EXIT trap set right after _acquire_lock.

  log_divider
  printf "\n"
  printf "  ${_BOLD}${_GREEN}Droplet Edge Platform — Setup Complete${_RESET}\n"
  printf "\n"
  # ADR-023 / WARP-1300: surface the publicly-trusted per-device FQDN as the
  # PRIMARY dashboard URL when it's known — the one address that works at
  # home AND over the VPN with a green padlock and no per-client install.
  # Read straight from .env; empty until the box has learned it from HQ on
  # its first issuance run. Once known, droplet.local itself redirects here
  # too (the single-box shape writes DROPLET_LAN_DNS_AUTHORITY=1, so the
  # gateway 307s droplet.local/droplet-ai.local/droplet.lan/droplet-ai.lan
  # to this FQDN — WARP-1300).
  _public_fqdn=""
  if [ -f "$REPO_ROOT/.env" ]; then
    _public_fqdn="$(grep -E '^DROPLET_PUBLIC_FQDN=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  fi
  if [ -n "$_public_fqdn" ]; then
    printf "  Dashboard:     ${_CYAN}https://%s${_RESET} (trusted — green padlock, works on LAN and over VPN)\n" "$_public_fqdn"
    printf "  Shortcut:      type ${_CYAN}droplet.local${_RESET} in any browser on this network — it lands there\n"
    # WARP-1301 (redirect-design spec §5): every emitted URL prints the FQDN
    # once it's known — .local survives only as the thing humans type.
    printf "  API:           ${_CYAN}https://%s/api/health${_RESET}\n" "$_public_fqdn"
  else
    printf "  Dashboard:     ${_CYAN}https://droplet-ai.local${_RESET} (mDNS) or ${_CYAN}https://droplet-ai.lan${_RESET} (router DNS)\n"
    printf "                 ${_DIM}https://localhost also works on this device${_RESET}\n"
    printf "  API:           ${_CYAN}https://droplet-ai.local/api/health${_RESET}\n"
  fi
  printf "\n"
  printf "  ${_BOLD}About the browser padlock${_RESET}\n"
  printf "  The Droplet gets a publicly-trusted certificate automatically — no\n"
  printf "  per-device install is needed. The first few minutes after setup it may\n"
  printf "  serve a temporary self-signed cert (you'll see a one-time \"Not secure\"\n"
  printf "  warning) until the trusted certificate is issued; it then turns into a\n"
  printf "  green padlock on its own.\n"
  printf "  ${_DIM}Offline / air-gapped fallback only: ./scripts/trust-droplet-cert.sh${_RESET}\n"
  printf "  ${_DIM}Windows: powershell -ExecutionPolicy Bypass -File scripts\\trust-droplet-cert.ps1${_RESET}\n"
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
