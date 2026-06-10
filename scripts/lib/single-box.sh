#!/usr/bin/env bash
# single-box.sh — Single-box deployment shape: hardware detection +
# host integration install. Source this file; do not execute directly.
#
# The `single-box` deployment runs the full Droplet stack on ONE x86
# host with a dGPU (for Ollama) + iGPU (for Frigate) + Wi-Fi card
# (for the in-container OpenWrt AP) — as opposed to the `multi-box`
# shape which has Ollama on a separate Jetson and OpenWrt on a Pi 5,
# or the future `v2-6` shape which uses the custom 9-PCB chassis.
# All three are shipping product; the difference is hardware layout.
#
# To support the single-box shape, three things have to land on the
# host that the multi-box / v2-6 paths don't need:
#   1. compose profile `single-box` activated (brings up `ollama` +
#      `openwrt` containers — see docker/docker-compose.yml +
#      docs/SINGLE_BOX.md)
#   2. .env knobs for the single-box hardware (FIPS off, TPM=mock,
#      OpenWrt at 127.0.0.1:8181, Frigate on the iGPU because the
#      dGPU hosts Ollama)
#   3. Host integration: systemd units + scripts that wire the
#      in-container OpenWrt to a real Wi-Fi AP via netns + a host-side
#      dnsmasq on br-lan so the managed switch downstream gets DHCP
#
# This module handles all three. Sourced from setup.sh.

# ============================================================================
# Detection
# ============================================================================
#
# Auto-detect single-box hardware so the operator doesn't have to remember
# `--single-box`. Conservative — we lean toward "not single-box" when
# ambiguous because the wrong call here installs systemd units and host
# scripts the operator might not want.
#
# Signals checked:
#   * Multiple DRM render nodes (`/dev/dri/renderD*` count > 1) — single-box
#     hosts have BOTH a dGPU (Ollama) and an iGPU (Frigate); a multi-box
#     inference host typically has just `renderD128`. Strongest signal we have.
#   * No reachable separate inference host on the LAN — if
#     `192.168.50.197:11434` answers `/api/version`, this host is the
#     intelligence layer in a multi-box deploy, not a single-box.
#   * Has AMD/NVIDIA GPU silicon — lspci shows an AMD/NVIDIA VGA/3D/Display
#     controller. NB this matches a discrete dGPU AND an integrated AMD/NVIDIA
#     APU (the vendor filter can't distinguish them); the render_count >= 2
#     gate is the real discriminator, so an iGPU-only box isn't misclassified.
#
# Returns 0 if single-box detected, 1 otherwise. Sets SINGLE_BOX_DETECTION_REASON.
detect_single_box_mode() {
  SINGLE_BOX_DETECTION_REASON=""

  # Linux only — macOS dev installs are not single-box deployments.
  if [ "$(uname)" != "Linux" ]; then
    SINGLE_BOX_DETECTION_REASON="not Linux"
    return 1
  fi

  # Signal 1: render-node count
  local render_count=0
  if [ -d /dev/dri ]; then
    render_count=$(find /dev/dri -maxdepth 1 -name 'renderD*' 2>/dev/null | wc -l)
  fi

  # Signal 2: separate inference host reachable?
  # We need a REACHABLE Ollama, not just a resolvable hostname. The single-box
  # host has avahi advertising itself, and stale /etc/hosts entries can have
  # `inference-engine.local` pointing at something dead — both make getent
  # succeed without there being a real inference host on the LAN. The curl
  # below is the authoritative check: an Ollama instance answering /api/version
  # means we're multi-box, anything else means we're not.
  #
  # The body grep for `"version":` defends against something unrelated
  # squatting on 192.168.50.197:11434 with a 200 response (rare but not
  # impossible on a noisy LAN). Ollama always returns a JSON object that
  # includes the `"version"` key.
  #
  # The CI / DROPLET_SKIP_NETWORK_PROBE escape hatch lets dev re-runs of
  # the script skip the two 2-second curl probes (≤4 s added latency on
  # every fresh install). Real provisions still do the probe.
  local jetson_reachable=0
  local skip_probe=0
  if [ -n "${CI:-}" ] || [ -n "${DROPLET_SKIP_NETWORK_PROBE:-}" ]; then
    skip_probe=1
  fi
  if [ "$skip_probe" = 0 ] && command -v curl >/dev/null 2>&1; then
    # Try the documented static IP first, then the mDNS name. Both need a
    # real /api/version response with the expected JSON body; a name that
    # resolves to a dead IP fails the curl, and an unrelated 200-responder
    # fails the body grep.
    if curl -fsS -m 2 http://192.168.50.197:11434/api/version 2>/dev/null | grep -q '"version":' \
       || curl -fsS -m 2 http://inference-engine.local:11434/api/version 2>/dev/null | grep -q '"version":'; then
      jetson_reachable=1
    fi
  fi

  # Signal 3: AMD/NVIDIA GPU silicon present? (has_dgpu is really "AMD/NVIDIA GPU
  # present, discrete OR integrated" — the vendor filter below can't tell an
  # APU's iGPU from a dGPU; render_count >= 2 above is the real discriminator.)
  # NB: lspci labels GPUs "VGA compatible controller" (and "3D controller" /
  # "Display controller"), so the class match must allow the optional
  # " compatible" word — a bare "VGA controller" never appears and silently
  # set has_dgpu=0, which made single-box auto-detect decline on real dGPU
  # boxes (e.g. the AMD single-box: "VGA compatible controller ... [AMD/ATI]").
  local has_dgpu=0
  if command -v lspci >/dev/null 2>&1; then
    if lspci 2>/dev/null | grep -iE '(VGA|3D|Display)( compatible)? controller' \
        | grep -iE '(AMD|Advanced Micro|NVIDIA|Radeon)' >/dev/null 2>&1; then
      has_dgpu=1
    fi
  fi

  # Decision matrix
  if [ "$jetson_reachable" = 1 ]; then
    SINGLE_BOX_DETECTION_REASON="separate inference host reachable on LAN — multi-box deployment shape"
    return 1
  fi

  if [ "$render_count" -ge 2 ] && [ "$has_dgpu" = 1 ]; then
    SINGLE_BOX_DETECTION_REASON="dGPU + iGPU detected (${render_count} render nodes), no inference host on LAN"
    return 0
  fi

  if [ "$render_count" -lt 2 ]; then
    SINGLE_BOX_DETECTION_REASON="only ${render_count} DRM render node(s) — not single-box hardware"
    return 1
  fi

  # shellcheck disable=SC2034  # global: set across this fn, read by the caller (scripts/setup.sh:124,127) after `source`. shellcheck checks this lib standalone and can't see the cross-file read; the directive sits on the last assignment, where SC2034 anchors.
  SINGLE_BOX_DETECTION_REASON="ambiguous signals (render=${render_count}, dgpu=${has_dgpu}, inference_host=${jetson_reachable}) — declining to auto-enable"
  return 1
}

# ============================================================================
# Host integration install
# ============================================================================
#
# Copies the captured single-box host scripts + systemd units + configs from
# scripts/host/ into the system paths they need to live at. Idempotent —
# safe to re-run; checks file presence before overwriting where it matters.
#
# Requires sudo. Skipped silently when not on Linux. Skipped with a warning
# when scripts/host/ is missing (i.e. someone deleted the captured set).
#
# Does NOT install:
#   * scripts/host/etc-systemd-system/droplet.service — superseded by the
#     `install_systemd_service` function in lib/systemd.sh, which generates
#     an equivalent unit using the running operator's user instead of a
#     hardcoded `droplet`. setup.sh calls install_systemd_service after this
#     so the auto-start unit always lands.
#   * scripts/host/etc-dnsmasq.d/* — legacy AP configs superseded by the
#     newer droplet-poc-host-net.service + lan-dhcp.conf. Captured in
#     scripts/host/ for historical reference only.
install_single_box_host_integration() {
  if [ "$(uname)" != "Linux" ]; then
    log_info "single-box host integration: skipping (not Linux)"
    return 0
  fi

  local host_src="$REPO_ROOT/scripts/host"
  if [ ! -d "$host_src" ]; then
    log_warn "single-box host integration: scripts/host/ missing — capture step incomplete"
    return 0
  fi

  log_info "Installing single-box host integration from scripts/host/..."

  # --- /usr/local/sbin/ scripts -------------------------------------------
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-openwrt-attach" \
    /usr/local/sbin/droplet-openwrt-attach
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-poc-host-net" \
    /usr/local/sbin/droplet-poc-host-net
  log_success "Installed /usr/local/sbin/droplet-openwrt-attach + droplet-poc-host-net"

  # --- /etc/default/ envs -------------------------------------------------
  # droplet-poc-host-net is committed as-is (no secrets). Copy directly.
  sudo install -m 0644 "$host_src/etc-default/droplet-poc-host-net" \
    /etc/default/droplet-poc-host-net

  # droplet-openwrt-attach has the AP PSK. The repo holds an .example with the
  # PSK redacted; we materialize a real one from the .env value if the operator
  # set DROPLET_AP_PSK. Otherwise we install a placeholder — and the attach
  # script (WARP-819) GENERATES a strong per-box PSK on first boot, persists it
  # 0600 at /etc/droplet/ap-psk, and re-reads it every boot. So no shared
  # password ever ships, with or without an operator-supplied value.
  # `|| true` on the grep is mandatory under `set -o pipefail`: a no-match
  # grep exits 1 and propagates through the pipe, killing setup.sh entirely.
  local ap_psk
  ap_psk="$( { grep -E '^DROPLET_AP_PSK=' "$REPO_ROOT/.env" 2>/dev/null || true; } | cut -d= -f2-)"
  if [ -z "$ap_psk" ]; then
    ap_psk="CHANGE_ME_VIA_SETUP_WIZARD"
    log_info "DROPLET_AP_PSK not set in .env — droplet-openwrt-attach will generate a per-box PSK on first boot (WARP-819)"
  fi

  # Only write if missing (don't clobber an operator-set PSK on re-runs).
  if [ ! -f /etc/default/droplet-openwrt-attach ]; then
    sudo tee /etc/default/droplet-openwrt-attach > /dev/null << EOF
# Generated by scripts/lib/single-box.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# If DROPLET_AP_PSK is the placeholder/unset, droplet-openwrt-attach generates a
# per-box PSK on first boot (persisted 0600 at /etc/droplet/ap-psk). Do NOT commit.
# Reference: scripts/host/etc-default/droplet-openwrt-attach.example

DROPLET_AP_SSID=Droplet
DROPLET_AP_PSK=$ap_psk

# Wi-Fi radio phy/iface. Left EMPTY by default so droplet-openwrt-attach's
# detect_ap_radio AUTO-DETECTS whatever card the box ships (phy0/wlp14s0 on the
# MT7922 single-box, phy1/wlp7s0 on an AX210, wlan0 elsewhere). Hardcoding one
# card's layout here (WARP-826) made the env arrive non-empty, which SKIPS
# detection and silently breaks the AP on any other card. To PIN the radio, set
# DROPLET_AP_PHY / DROPLET_AP_IFACE (in .env or here) — a non-empty value is
# honored verbatim and detection is skipped.
DROPLET_AP_PHY=${DROPLET_AP_PHY:-}
DROPLET_AP_IFACE=${DROPLET_AP_IFACE:-}
EOF
    sudo chmod 0600 /etc/default/droplet-openwrt-attach
    log_success "Wrote /etc/default/droplet-openwrt-attach (mode 0600)"
  else
    log_info "/etc/default/droplet-openwrt-attach exists — keeping rotated value"
  fi

  # --- /etc/droplet-poc-host-net/ -----------------------------------------
  sudo install -d -m 0755 /etc/droplet-poc-host-net
  sudo install -m 0644 "$host_src/etc-droplet-poc-host-net/lan-dhcp.conf" \
    /etc/droplet-poc-host-net/lan-dhcp.conf

  # --- systemd units -----------------------------------------------------
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-openwrt-attach.service" \
    /etc/systemd/system/droplet-openwrt-attach.service
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-poc-host-net.service" \
    /etc/systemd/system/droplet-poc-host-net.service
  sudo install -d -m 0755 /etc/systemd/system/droplet-openwrt-attach.service.d
  sudo install -m 0644 \
    "$host_src/etc-systemd-system/droplet-openwrt-attach.service.d/override.conf" \
    /etc/systemd/system/droplet-openwrt-attach.service.d/override.conf

  # --- /etc/tmpfiles.d/ and /etc/avahi/services/ --------------------------
  sudo install -m 0644 "$host_src/etc-tmpfiles.d/droplet.conf" \
    /etc/tmpfiles.d/droplet.conf
  sudo install -d -m 0755 /etc/avahi/services
  sudo install -m 0644 "$host_src/etc-avahi/services/droplet.service" \
    /etc/avahi/services/droplet.service

  # --- Activate ----------------------------------------------------------
  sudo systemctl daemon-reload
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/droplet.conf 2>/dev/null || true
  sudo systemctl enable droplet-openwrt-attach.service >/dev/null 2>&1
  sudo systemctl enable droplet-poc-host-net.service >/dev/null 2>&1

  log_success "single-box host integration installed"
  log_info "  Boot-time:   droplet-openwrt-attach.service + droplet-poc-host-net.service"
  log_info "  Status:      sudo systemctl status droplet-openwrt-attach droplet-poc-host-net"
  log_info "  Logs:        sudo journalctl -u droplet-openwrt-attach -u droplet-poc-host-net"
}

# WARP-826: poll for the OpenWrt container to be genuinely READY — Running AND
# its ubus answering — not merely `.State.Running`. `.State.Running` flips true
# the instant PID 1 starts, seconds before procd/ubus are up; on a freshly
# (re)created container (post factory-reset) the attach then docker-exec'd
# against a not-ready rootfs and the AP/RPC bootstrap raced → router offline.
# Probing ubus inside the container is the real readiness signal the subsequent
# attach depends on (it issues `ubus call ...` for the rpcd ACL + firewall).
#
# Tunables (env, defaults chosen for ~60s budget like the old loop):
#   OPENWRT_READY_TRIES     poll attempts (default 30)
#   OPENWRT_READY_INTERVAL  seconds between polls (default 2)
# Returns 0 once ready, non-zero if readiness never arrives within the budget
# (caller warns + skips — never hangs). Sentinel-delimited for unit testing
# (tests/single-box-openwrt-readiness.test.sh), mirroring the attach script's
# extractable functions.
# >>> wait_for_openwrt_ready (WARP-826)
wait_for_openwrt_ready() {
  local tries="${OPENWRT_READY_TRIES:-30}"
  local interval="${OPENWRT_READY_INTERVAL:-2}"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    i=$((i + 1))
    # 1) Container process up?
    if [ "$(docker inspect -f '{{.State.Running}}' droplet-openwrt 2>/dev/null)" = "true" ]; then
      # 2) ubus actually answering inside it? `ubus -t 1 list` is a cheap,
      #    read-only liveness probe that fails (non-zero) until procd/ubusd are
      #    up — exactly the window the old Running-only gate skipped. Quiet; we
      #    only care about the exit code.
      if docker exec droplet-openwrt ubus -t 1 list >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep "$interval"
  done
  return 1
}
# <<< wait_for_openwrt_ready (WARP-826)

# Trigger the OpenWrt container bootstrap after start_stack (re)creates it.
# droplet-openwrt-attach.service is a boot-time `oneshot` (RemainAfterExit),
# so on a no-reboot re-provision — factory-reset wiped openwrt-config /
# openwrt-overlay and start_stack made a FRESH openwrt container — the oneshot
# does NOT re-run, leaving the new container unprovisioned (no umdns, no rpcd
# ACL, eth0 not in the `lan` firewall zone). fw4 then DROPs ubus input and the
# routing service crash-loops (WARP-578 — reproduces the reported "router
# offline"). Restart the unit explicitly once openwrt is READY; the attach
# script is idempotent.
provision_single_box_openwrt() {
  if ! systemctl list-unit-files droplet-openwrt-attach.service >/dev/null 2>&1; then
    return 0  # unit not installed (non-single-box / dev host) — nothing to do
  fi
  # WARP-826: gate on real readiness (Running AND ubus up), not `.State.Running`
  # alone. The attach docker-execs `ubus call ...`, so kicking it before ubus is
  # answering raced the bootstrap on a freshly recreated container.
  if ! wait_for_openwrt_ready; then
    log_warn "openwrt container not READY (Running + ubus) within budget — skipping attach; routing may be offline until next boot (WARP-578/826)"
    return 0
  fi
  log_info "Provisioning the OpenWrt container (umdns + rpcd ACL + eth0 firewall trust)..."
  # Re-kick the oneshot explicitly: it does NOT fire on a container recreate, so
  # the provisioner is the only thing that re-runs the attach on a fresh container.
  if sudo systemctl restart droplet-openwrt-attach.service; then
    log_success "droplet-openwrt-attach ran — routing can reach ubus (WARP-578/826)"
  else
    log_warn "droplet-openwrt-attach failed — check: sudo journalctl -u droplet-openwrt-attach"
  fi
}

# ============================================================================
# .env knobs
# ============================================================================
#
# Appends single-box .env vars so the compose profile activates AND the
# patched services find the right values. Called from setup.sh AFTER
# generate_env (which writes the secrets-only block via heredoc).
#
# Why append vs heredoc-include: the existing secrets.sh heredoc is a
# single-source-of-truth canonical write that runs on every setup.
# Single-box knobs are layered on top so the heredoc stays clean and
# multi-box / v2-6 deployments get a slimmer .env. Idempotent —
# duplicate appends are safe because the LAST occurrence of a key
# wins in docker-compose env_file parsing.
# ----------------------------------------------------------------------------
# DROPLET_PM_ENABLED gate (WARP-496) — the embedded Plane PM stack is opt-OUT,
# DEFAULT ON. Returns 0 (enabled) for an unset/empty value or anything that is
# NOT an explicit disable token; returns 1 (disabled) only for the explicit
# tokens 0 / false / no (case-insensitive). Explicit token list, no host-
# specific default (architecture-guard rules 10/12). Canonical definition;
# scripts/lib/compose.sh inlines the same token check for its build gate
# (kept in sync — see the comment there).
_droplet_pm_enabled() {
  local v
  v=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
  case "$v" in
    0|false|no) return 1 ;;
    *)          return 0 ;;
  esac
}

# Strip the `pm` token from a comma-separated COMPOSE_PROFILES value ($1).
# Used by the gate-OFF path so DROPLET_PM_ENABLED=0 + a re-run actually drops
# the Plane stack on an already-PM-provisioned box (symmetric with the enable
# path's append). Comma-wrapped param-expansion replace (no sed) is
# substring-safe: a profile named e.g. `pmx`/`xpm` is preserved.
_strip_pm_profile() {
  local wrapped=",${1:-},"
  wrapped="${wrapped//,pm,/,}"
  wrapped="${wrapped#,}"; wrapped="${wrapped%,}"
  printf '%s' "$wrapped"
}

configure_single_box_env() {
  local env_file="$REPO_ROOT/.env"
  if [ ! -f "$env_file" ]; then
    log_error "configure_single_box_env: $env_file missing — generate_env must run first"
    return 1
  fi

  # --- Idempotent upsert of the single-box knobs (WARP-556) ----------------
  # The base .env (generate_env + lib/compose.sh) already sets several of
  # these keys (COMPOSE_PROFILES, OLLAMA_URL, ROUTING_MODE). A blind `>>`
  # append duplicated them — harmless under `.env` last-wins, but fragile (a
  # reorder flips OLLAMA_URL to the non-resolving host) and confusing to an
  # operator debugging a fresh install. upsert_env strips any existing copy
  # of a key before writing it, so re-running setup.sh never duplicates one.
  upsert_env() {
    local key="$1" val="$2"
    if grep -qE "^${key}=" "$env_file"; then
      # 0600 tmp (umask) so the secrets-bearing .env never transits world-
      # readable; cat>file (not mv) preserves the original perms + inode.
      ( umask 077; grep -vE "^${key}=" "$env_file" > "${env_file}.tmp" )
      cat "${env_file}.tmp" > "$env_file"
      rm -f "${env_file}.tmp"
    fi
    printf '%s=%s\n' "$key" "$val" >> "$env_file"
  }

  # COMPOSE_PROFILES is MERGED, not overwritten: keep whatever lib/compose.sh
  # already set (`linux` for Frigate, `display` for the OLED sim) and add
  # `single-box` (bundled ollama + openwrt). The old overwrite silently
  # dropped `display`.
  local existing_profiles merged_profiles
  # `|| true`: grep exits 1 when the key is absent. Under `set -euo pipefail`
  # that bare assignment would abort setup (and silently — this runs inside a
  # function, so the top-level ERR trap isn't inherited). Empty is handled by
  # the case below. Same guard sync_openwrt_password_secret() documents.
  existing_profiles=$(grep -E '^COMPOSE_PROFILES=' "$env_file" | tail -1 | cut -d= -f2- || true)
  case ",${existing_profiles}," in
    *,single-box,*) merged_profiles="$existing_profiles" ;;
    ,,)             merged_profiles="single-box" ;;
    *)              merged_profiles="${existing_profiles},single-box" ;;
  esac

  # Embedded Plane PM stack — opt-OUT gate, DEFAULT ON (WARP-496 / bug #10).
  # The 7 PM services carry `profiles: ["pm"]` ONLY (compose profiles are
  # static), so PM is reached on the single-box shape by APPENDING `pm` to
  # COMPOSE_PROFILES here. The owner wants project management working out-of-
  # the-box on capable boxes, so PM is enabled by default; a resource-
  # constrained (~6 GB) box drops the ~2.5 GB always-on stack by setting
  # DROPLET_PM_ENABLED=0 (or false/no) in .env. Explicit state — absence means
  # enabled, and the disabled set is an explicit token list (architecture-guard
  # rules 10/12: no host-specific default, no guessing from IS NULL).
  local pm_enabled_val
  # `|| true`: a fresh .env has no DROPLET_PM_ENABLED line, so grep exits 1 and
  # would abort under `set -euo pipefail` (silently — inside a function, no ERR
  # trap). Empty → enabled-by-default via _droplet_pm_enabled. This is the bug
  # that bricked the first single-box reflash after the Plane-PM work landed.
  pm_enabled_val=$(grep -E '^DROPLET_PM_ENABLED=' "$env_file" | tail -1 | cut -d= -f2- || true)
  if _droplet_pm_enabled "$pm_enabled_val"; then
    case ",${merged_profiles}," in
      *,pm,*) : ;;                                  # already present — idempotent
      ,,)     merged_profiles="pm" ;;
      *)      merged_profiles="${merged_profiles},pm" ;;
    esac
    log_info "Plane PM stack ENABLED on single-box (DROPLET_PM_ENABLED=${pm_enabled_val:-<unset, default on>})"
  else
    # Gate OFF: STRIP any previously-appended `pm` token so disabling is
    # symmetric — DROPLET_PM_ENABLED=0 + a re-run actually drops the stack on an
    # already-PM-provisioned box, not only on a fresh provision.
    merged_profiles="$(_strip_pm_profile "$merged_profiles")"
    log_info "Plane PM stack DISABLED on single-box (DROPLET_PM_ENABLED=${pm_enabled_val}) — ~2.5 GB freed"
  fi

  # RAG eval (RAGAS retrieval-quality scoring) — enabled by DEFAULT on the
  # single-box shape (bug #15). The `rag-eval` service is `["eval"]`-profiled,
  # so it's reached by APPENDING `eval` to COMPOSE_PROFILES here — the same
  # mechanism as `single-box`/`pm` above. docker-compose.yml's eval-profile
  # comment calls RAGAS "GPU-bound, overkill on every appliance", but the
  # single-box shape always ships the dGPU RAGAS leans on (Ollama's local
  # judge), so that caveat doesn't apply here — the orchestrator's
  # /api/admin/rag-eval/* surface would otherwise dead-end on a 503. To stop the
  # scheduled runs WITHOUT dropping the container, set RAG_EVAL_DISABLED=1 in
  # .env (consumed directly by the rag-eval container — see docker-compose.yml).
  case ",${merged_profiles}," in
    *,eval,*) : ;;                                  # already present — idempotent
    ,,)       merged_profiles="eval" ;;
    *)        merged_profiles="${merged_profiles},eval" ;;
  esac

  # One-time descriptive header (idempotent — only on the first write).
  if ! grep -q 'Single-box deployment knobs' "$env_file"; then
    cat >> "$env_file" << 'EOF'

# ============================================================================
# Single-box deployment knobs (managed by scripts/lib/single-box.sh —
# re-run setup.sh --regenerate-env to reset; see docs/SINGLE_BOX.md).
#   COMPOSE_PROFILES     linux (Frigate) + display (OLED sim) + single-box
#                        (single-box also activates camera-discovery — gated
#                        to `full` otherwise). single-box.sh ALSO appends `pm`
#                        by DEFAULT so the embedded Plane PM stack at /pm/ runs
#                        out-of-the-box (bug #10) — see DROPLET_PM_ENABLED. It
#                        ALSO appends `eval` by DEFAULT so the rag-eval (RAGAS)
#                        service runs and /api/admin/rag-eval/* works out-of-the-
#                        box (bug #15); set RAG_EVAL_DISABLED=1 to pause runs.
#   DROPLET_PM_ENABLED   opt-OUT gate for the Plane PM stack, DEFAULT ON. The
#                        7 PM services are `["pm"]`-profiled, so this knob
#                        decides whether `pm` is appended to COMPOSE_PROFILES
#                        above. Set to 0 (or false/no) on a memory-constrained
#                        (~6 GB) box to drop the ~2.5 GB always-on Plane stack;
#                        unset/anything-else keeps PM enabled. Its DROPLET_PM_*
#                        secrets are generated unconditionally by
#                        scripts/lib/secrets.sh regardless of this gate.
#   FRIGATE_RENDER_NODE  iGPU renderD129 (dGPU renderD128 is reserved Ollama)
#   CAMERA_SUBNET        single-box camera network (br-lan 192.168.20.0/24);
#                        overrides the multi-box VLAN default 192.168.100.0/24
#   WIREGUARD_LAN_CIDR/  VPN peer .conf AllowedIPs + DNS, pinned to the single-
#   WIREGUARD_DNS        box LAN (br-lan 192.168.20.0/24, gateway/dnsmasq at
#                        192.168.20.1). Overrides the orchestrator's multi-box
#                        Pi-LAN defaults (192.168.50.x in
#                        apps/orchestrator/src/config.ts) so a remote VPN client
#                        can reach the dashboard + resolve *.lan (WARP-839).
#   OLLAMA_URL           compose-internal `ollama` service
#   OPENSSL_CONF/FIPS/TPM consumer x86 has no FIPS OpenSSL / TPM 2.0
#   LLM_MODEL            THE one model (architecture-guard one-model rule)
#   OPENWRT_*            bundled openwrt container at 127.0.0.1:8181
#   DROPLET_AP_MODE      hostapd — the single-box host runs the Wi-Fi AP via
#                        hostapd (not a Pi-5 UCI router), so the device-bridge
#                        reads pairing-QR creds in hostapd mode. Mirrored into
#                        /etc/droplet/device-bridge.env by
#                        install-device-bridge.sh (WARP-654).
#   SWITCH_AUTOPROVISION on — the bundled managed switch reconciles itself on
#                        bring-up (ADR-018 item 9) so a plugged-in AP lands on
#                        the LAN instead of stranding on an isolated VLAN.
#   SWITCH_VLAN_PROFILE  flat-lan — single-box runs a flat br-lan with NO
#                        inter-VLAN routing yet (ADR-018 item 3 not landed), so
#                        the switch must NOT isolate the camera VLAN (it would
#                        cut the working camera + Frigate off). flat-lan only
#                        pulls stray access ports back to untagged VLAN 1.
#   SWITCH_PROTECTED_PORT (NOT baked) — the uplink/trunk port that must never be
#                        moved off the LAN/trunk. The single-box switch port map
#                        is host-specific and not yet known here (rule 12: no
#                        host-specific default), so it is left for the operator
#                        / a supervised live step. With it unset (0) flat-lan is
#                        still safe — it only ever moves a port ONTO VLAN 1, the
#                        LAN, so it cannot strand the uplink.
# ============================================================================
EOF
  fi

  upsert_env COMPOSE_PROFILES    "$merged_profiles"
  upsert_env FRIGATE_RENDER_NODE /dev/dri/renderD129
  # CAMERA_SUBNET: the compose default (192.168.100.0/24) is the multi-box
  # OpenWrt camera VLAN (openwrt/files/etc/config/dhcp `cameras`). The
  # single-box shape has no separate camera VLAN today — cameras attach to
  # the box's own LAN (br-lan, 192.168.20.0/24; see
  # scripts/host/etc-droplet-poc-host-net/lan-dhcp.conf). Pinning the subnet
  # to the actual single-box camera network is what makes camera discovery
  # scan where the cameras are instead of an empty multi-box VLAN (ADR-018
  # Decision 4). When the OpenWrt single-box unification (ADR-018 T3) lands a
  # real isolated camera VLAN on this shape, this value moves to that VLAN's
  # network in lockstep.
  upsert_env CAMERA_SUBNET       192.168.20.0/24
  # WARP-839: pin the WireGuard peer LAN CIDR + DNS to the single-box LAN. The
  # orchestrator's defaults (WIREGUARD_LAN_CIDR=192.168.50.0/24,
  # WIREGUARD_DNS=192.168.50.1 in apps/orchestrator/src/config.ts) are the
  # MULTI-BOX Pi LAN. The single-box LAN is br-lan 192.168.20.0/24 with the
  # gateway + dnsmasq at 192.168.20.1 (droplet.local -> 192.168.20.1), so the
  # rendered peer .conf AllowedIPs/DNS must point there — otherwise a remote VPN
  # client can't reach the dashboard or resolve *.lan. Multi-box keeps the
  # config.ts 192.168.50.x defaults (untouched); this override is written ONLY
  # on the single-box path.
  upsert_env WIREGUARD_LAN_CIDR  192.168.20.0/24
  upsert_env WIREGUARD_DNS       192.168.20.1
  upsert_env OLLAMA_URL          http://ollama:11434
  upsert_env OPENSSL_CONF        ""
  upsert_env DROPLET_FIPS_REQUIRED false
  upsert_env DROPLET_TPM_BACKEND mock
  upsert_env LLM_MODEL           gpt-oss:20b
  upsert_env OPENWRT_HOST        127.0.0.1
  upsert_env OPENWRT_PORT        8181
  upsert_env OPENWRT_USERNAME    root
  upsert_env ROUTING_MODE        real
  # WARP-815 (K4): the routing service resolves the Wi-Fi scan radio from
  # DROPLET_WIFI_SCAN_DEVICE (the orchestrator no longer hardcodes wlan0 on the
  # wire). The single-box AP radio is phy0 → wlp14s0 inside the openwrt
  # container. SOURCE this from DROPLET_AP_IFACE so the scan radio tracks the AP
  # radio if an operator overrode it; default to the same wlp14s0 the AP iface
  # defaults to (install_single_box_host_integration writes
  # DROPLET_AP_IFACE=${DROPLET_AP_IFACE:-wlp14s0}). The AP radio in AP mode can't
  # itself scan (iw scan -> Not supported -95); the graceful "scan unavailable"
  # UX is a separate dashboard ticket. This only wires the config so the radio
  # name is correct rather than the absent wlan0.
  upsert_env DROPLET_WIFI_SCAN_DEVICE "${DROPLET_AP_IFACE:-wlp14s0}"
  # device-bridge pairing-QR source: the single-box AP is a host hostapd, not
  # a UCI router, so the bridge must read creds in hostapd mode (it defaults to
  # uci). install-device-bridge.sh mirrors this knob into the bridge env so a
  # fresh box renders a pairing QR without a manual step (WARP-654).
  upsert_env DROPLET_AP_MODE     hostapd
  # ADR-018 item 9: bundled managed switch auto-provisions on bring-up so a
  # plugged-in AP joins the LAN. flat-lan ONLY (single-box has no inter-VLAN
  # routing yet — item 3); never isolate the camera VLAN here. SWITCH_PROTECTED_PORT
  # is intentionally NOT baked (host-specific port map unknown — rule 12);
  # flat-lan stays safe without it (it only moves ports onto the LAN).
  upsert_env SWITCH_AUTOPROVISION 1
  upsert_env SWITCH_VLAN_PROFILE  flat-lan

  # --- Host-net service URLs → live droplet_default gateway (WARP-806) -------
  # routing (:8080), switch (:8081), and oled-display (:8082) all run with
  # `network_mode: host` and bind those ports on the host. The orchestrator is
  # on the `droplet_default` compose bridge; its `extra_hosts: host-gateway`
  # resolves `host.docker.internal` to docker0 (172.17.0.1) — which is DOWN on
  # the single-box (the box only ever brings up the droplet_default bridge,
  # gateway 172.18.0.1). So the compose-default
  # ROUTING/SWITCH/DISPLAY_SERVICE_URL of `http://host.docker.internal:<port>`
  # is unreachable here and every /api/network, /api/ddns, /api/vpn call dies
  # with `ECONNREFUSED 172.17.0.1:8080`. Fix: pin these three URLs to the LIVE
  # droplet_default gateway so the bridged orchestrator reaches the host-bound
  # services on the bridge the box actually has. The gateway is DERIVED from
  # docker, never hardcoded — there is no top-level `networks:` block in the
  # compose file, so Docker's IPAM auto-assigns the subnet (the next free
  # 172.x.0.0/16) and it can legitimately differ per host. Same docker0-down
  # precedent that moved DEVICE_BRIDGE_URL off 172.17.0.1
  # (apps/orchestrator/src/config.ts + routes/storage.ts). Multi-box keeps the
  # host.docker.internal default — this override is written ONLY on the
  # single-box path (this function). The .env is consumed by `start_stack`
  # (compose --env-file), so writing it here, before bring-up, means the
  # orchestrator boots with the correct URLs (no restart needed).
  #
  # Ordering note: this runs in setup Phase 4 (Secrets), BEFORE Phase 6 brings
  # the stack up — so on a FRESH install the droplet_default network does not
  # exist yet to inspect. We therefore CREATE it first when absent (idempotent;
  # a plain bridge stamped with compose's default-network labels, which compose
  # then adopts on `up` without recreating it) and read back the gateway
  # Docker's IPAM assigned. On a re-provision the network already exists and the
  # create is a harmless no-op. We only fail loud if, after ensuring it exists,
  # the gateway still can't be read (a genuine Docker fault) — never silently
  # leave the unreachable host.docker.internal default in place.
  local bridge_net="droplet_default" bridge_gw=""
  # Create the bridge if absent so the gateway is derivable at Phase-4 time.
  # `|| true` on each docker call: under `set -euo pipefail` a non-zero exit
  # inside this function would abort setup silently (no inherited ERR trap); we
  # validate the derived value explicitly below and fail loud with context.
  if ! docker network inspect "$bridge_net" >/dev/null 2>&1; then
    docker network create \
      --label com.docker.compose.network=default \
      --label com.docker.compose.project=droplet \
      "$bridge_net" >/dev/null 2>&1 || true
    log_info "Pre-created the $bridge_net bridge so the host-net gateway is derivable before stack bring-up (compose adopts it on \`up\`)."
  fi
  bridge_gw=$(docker network inspect "$bridge_net" \
    -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
  # Trim stray whitespace/newlines the Go template can emit for multi-config nets.
  bridge_gw=$(printf '%s' "$bridge_gw" | tr -d '[:space:]')
  if [ -z "$bridge_gw" ]; then
    # Fail loud — do NOT silently leave the unreachable host.docker.internal
    # default. An empty gateway here is the difference between a working router
    # page and a box-wide ECONNREFUSED, so surface it with a clear next step.
    log_error "configure_single_box_env: could not derive the ${bridge_net} bridge gateway (\`docker network inspect ${bridge_net}\` returned no gateway, even after attempting to create it). Refusing to leave ROUTING/SWITCH/DISPLAY_SERVICE_URL at the unreachable host.docker.internal (docker0) default. Check the Docker daemon (\`docker network ls\`) and re-run setup.sh --single-box."
    return 1
  fi
  upsert_env ROUTING_SERVICE_URL "http://${bridge_gw}:8080"
  upsert_env SWITCH_SERVICE_URL  "http://${bridge_gw}:8081"
  upsert_env DISPLAY_SERVICE_URL "http://${bridge_gw}:8082"
  # Device-bridge (host process, binds 0.0.0.0:9090) — same WARP-806 reasoning
  # as the three host services above: the orchestrator's config default is
  # http://host.docker.internal:9090 (docker0), exactly the default WARP-806
  # documented as unreliable on this box. Pin it to the droplet_default gateway
  # so the single-box Wi-Fi write (WARP-808), storage ops, and the QR/creds
  # reads never depend on docker0 being up.
  upsert_env DEVICE_BRIDGE_URL   "http://${bridge_gw}:9090"

  log_success "Wrote single-box knobs to .env (idempotent upsert — COMPOSE_PROFILES=${merged_profiles}, CAMERA_SUBNET=192.168.20.0/24, WIREGUARD_LAN_CIDR=192.168.20.0/24, WIREGUARD_DNS=192.168.20.1, OLLAMA_URL, FIPS off, TPM=mock, OpenWrt 127.0.0.1:8181, LLM_MODEL=gpt-oss:20b, DROPLET_AP_MODE=hostapd, SWITCH_AUTOPROVISION=1 flat-lan, ROUTING/SWITCH/DISPLAY/DEVICE_BRIDGE URLs → ${bridge_net} gateway ${bridge_gw})"
}
