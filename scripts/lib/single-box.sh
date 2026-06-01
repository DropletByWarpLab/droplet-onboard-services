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
#   * Has dGPU silicon — lspci shows AMD/NVIDIA VGA controller (not just
#     integrated graphics). Belt-and-suspenders confirmation.
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

  # Signal 3: dGPU silicon present?
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

  # droplet-openwrt-attach has the AP PSK. The repo holds an .example with
  # the PSK redacted; we materialize the real one from the .env value
  # (DROPLET_AP_PSK if set, else fall back to a setup-wizard placeholder
  # that the setup wizard will rotate on first run).
  # `|| true` on the grep is mandatory under `set -o pipefail`: a no-match
  # grep exits 1 and propagates through the pipe, killing setup.sh entirely.
  local ap_psk
  ap_psk="$( { grep -E '^DROPLET_AP_PSK=' "$REPO_ROOT/.env" 2>/dev/null || true; } | cut -d= -f2-)"
  if [ -z "$ap_psk" ]; then
    ap_psk="CHANGE_ME_VIA_SETUP_WIZARD"
    log_warn "DROPLET_AP_PSK not set in .env — installing placeholder; setup wizard will rotate"
  fi

  # Only write if missing (don't clobber a rotated PSK on re-runs).
  if [ ! -f /etc/default/droplet-openwrt-attach ]; then
    sudo tee /etc/default/droplet-openwrt-attach > /dev/null << EOF
# Generated by scripts/lib/single-box.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Rotated by setup wizard on first run; do NOT commit.
# Reference: scripts/host/etc-default/droplet-openwrt-attach.example

DROPLET_AP_SSID=Droplet
DROPLET_AP_PSK=$ap_psk

# Hardware specifics for the Wi-Fi radio: phy0 surfaces as wlp14s0 inside
# the openwrt container. Override here if your hardware enumerates
# differently.
DROPLET_AP_PHY=${DROPLET_AP_PHY:-phy0}
DROPLET_AP_IFACE=${DROPLET_AP_IFACE:-wlp14s0}
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

# Trigger the OpenWrt container bootstrap after start_stack (re)creates it.
# droplet-openwrt-attach.service is a boot-time `oneshot` (RemainAfterExit),
# so on a no-reboot re-provision — factory-reset wiped openwrt-config /
# openwrt-overlay and start_stack made a FRESH openwrt container — the oneshot
# does NOT re-run, leaving the new container unprovisioned (no umdns, no rpcd
# ACL, eth0 not in the `lan` firewall zone). fw4 then DROPs ubus input and the
# routing service crash-loops (WARP-578 — reproduces the reported "router
# offline"). Restart the unit explicitly once openwrt is up; the attach script
# is idempotent.
provision_single_box_openwrt() {
  if ! systemctl list-unit-files droplet-openwrt-attach.service >/dev/null 2>&1; then
    return 0  # unit not installed (non-single-box / dev host) — nothing to do
  fi
  # Wait for the openwrt container to be Running before the attach docker-execs.
  local tries=30
  while [ "$tries" -gt 0 ]; do
    [ "$(docker inspect -f '{{.State.Running}}' droplet-openwrt 2>/dev/null)" = "true" ] && break
    tries=$((tries - 1))
    sleep 2
  done
  if [ "$tries" -eq 0 ]; then
    log_warn "openwrt container not Running after 60s — skipping attach; routing may be offline until next boot (WARP-578)"
    return 0
  fi
  log_info "Provisioning the OpenWrt container (umdns + rpcd ACL + eth0 firewall trust)..."
  if sudo systemctl restart droplet-openwrt-attach.service; then
    log_success "droplet-openwrt-attach ran — routing can reach ubus (WARP-578)"
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
  existing_profiles=$(grep -E '^COMPOSE_PROFILES=' "$env_file" | tail -1 | cut -d= -f2-)
  case ",${existing_profiles}," in
    *,single-box,*) merged_profiles="$existing_profiles" ;;
    ,,)             merged_profiles="single-box" ;;
    *)              merged_profiles="${existing_profiles},single-box" ;;
  esac

  # One-time descriptive header (idempotent — only on the first write).
  if ! grep -q 'Single-box deployment knobs' "$env_file"; then
    cat >> "$env_file" << 'EOF'

# ============================================================================
# Single-box deployment knobs (managed by scripts/lib/single-box.sh —
# re-run setup.sh --regenerate-env to reset; see docs/SINGLE_BOX.md).
#   COMPOSE_PROFILES     linux (Frigate) + display (OLED sim) + single-box
#   FRIGATE_RENDER_NODE  iGPU renderD129 (dGPU renderD128 is reserved Ollama)
#   OLLAMA_URL           compose-internal `ollama` service
#   OPENSSL_CONF/FIPS/TPM consumer x86 has no FIPS OpenSSL / TPM 2.0
#   LLM_MODEL            THE one model (architecture-guard one-model rule)
#   OPENWRT_*            bundled openwrt container at 127.0.0.1:8181
# ============================================================================
EOF
  fi

  upsert_env COMPOSE_PROFILES    "$merged_profiles"
  upsert_env FRIGATE_RENDER_NODE /dev/dri/renderD129
  upsert_env OLLAMA_URL          http://ollama:11434
  upsert_env OPENSSL_CONF        ""
  upsert_env DROPLET_FIPS_REQUIRED false
  upsert_env DROPLET_TPM_BACKEND mock
  upsert_env LLM_MODEL           gpt-oss:20b
  upsert_env OPENWRT_HOST        127.0.0.1
  upsert_env OPENWRT_PORT        8181
  upsert_env OPENWRT_USERNAME    root
  upsert_env ROUTING_MODE        real

  log_success "Wrote single-box knobs to .env (idempotent upsert — COMPOSE_PROFILES=${merged_profiles}, OLLAMA_URL, FIPS off, TPM=mock, OpenWrt 127.0.0.1:8181, LLM_MODEL=gpt-oss:20b)"
}
