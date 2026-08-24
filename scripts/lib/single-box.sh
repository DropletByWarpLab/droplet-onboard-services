#!/usr/bin/env bash
# single-box.sh — Single-box deployment shape: hardware detection +
# host integration install. Source this file; do not execute directly.
#
# The `single-box` deployment runs the full Droplet stack on ONE x86
# host with a dGPU (for Ollama) + iGPU (for Frigate) + Wi-Fi card
# (for the in-container OpenWrt AP) — as opposed to the `multi-box`
# shape which has Ollama on a separate inference host and OpenWrt on a separate router host,
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
  local inference_reachable=0
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
      inference_reachable=1
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
  if [ "$inference_reachable" = 1 ]; then
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
  SINGLE_BOX_DETECTION_REASON="ambiguous signals (render=${render_count}, dgpu=${has_dgpu}, inference_host=${inference_reachable}) — declining to auto-enable"
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
#     newer droplet-host-net.service + lan-dhcp.conf. Captured in
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
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-host-net" \
    /usr/local/sbin/droplet-host-net
  # WARP-2064: the container-lifecycle watcher — re-applies the attach (via the
  # WARP-843 relay) whenever droplet-openwrt starts, so a no-wipe deploy that
  # recreates the container cannot strand the WG overlay NAT on a dead IP.
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-openwrt-watch" \
    /usr/local/sbin/droplet-openwrt-watch
  log_success "Installed /usr/local/sbin/droplet-openwrt-attach + droplet-host-net + droplet-openwrt-watch"

  # --- WARP-2150: iw is a hard prerequisite of droplet-openwrt-attach --------
  # detect_ap_radio maps the wireless phy to its netdev via `iw dev`, and the
  # attach moves the phy into the container netns via `iw phy ... set netns`.
  # Ubuntu Server does not ship iw, and nothing else here installed it: the
  # first validated fresh install (2026-08-24) hit `iw: command not found`,
  # the iface resolved empty, and the AP never came up. Ensure it at setup time
  # so re-runs heal existing boxes too. Best-effort apt with one update+retry
  # (restic precedent in lib/backup.sh): a transient failure must not abort
  # setup — the attach now skips AP bring-up with a loud, actionable message
  # when the iface stays unresolved, and a setup.sh re-run self-heals.
  if ! command -v iw >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iw; then
        sudo apt-get update -y >/dev/null 2>&1 || true
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iw || true
      fi
    fi
    if command -v iw >/dev/null 2>&1; then
      log_success "Installed iw (wireless phy/iface control for droplet-openwrt-attach)"
    else
      log_warn "iw still missing — droplet-openwrt-attach will SKIP AP bring-up (no Wi-Fi AP) until 'sudo apt-get install -y iw' succeeds and the unit restarts"
    fi
  fi

  # --- /etc/default/ envs -------------------------------------------------
  # droplet-host-net is committed as-is (no secrets). Copy directly.
  sudo install -m 0644 "$host_src/etc-default/droplet-host-net" \
    /etc/default/droplet-host-net

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
  # WARP-595: stage + rename. Because this write is guarded by the existence
  # check above, a partial file from an interrupted run (power cut mid-tee,
  # missing the SSID/PSK lines) would otherwise be kept FOREVER — every re-run
  # says "exists — keeping rotated value" and the AP config never converges.
  # Writing to a .tmp and mv'ing means the guard only ever sees complete files.
  if [ ! -f /etc/default/droplet-openwrt-attach ]; then
    sudo tee /etc/default/droplet-openwrt-attach.tmp > /dev/null << EOF
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
    sudo chmod 0600 /etc/default/droplet-openwrt-attach.tmp
    sudo mv /etc/default/droplet-openwrt-attach.tmp /etc/default/droplet-openwrt-attach
    log_success "Wrote /etc/default/droplet-openwrt-attach (mode 0600)"
  else
    log_info "/etc/default/droplet-openwrt-attach exists — keeping rotated value"
  fi

  # WARP-843 (security): /etc/default/droplet-openwrt-attach stays ROOT-owned.
  # It is the ROOT droplet-openwrt-attach.service's EnvironmentFile and carries
  # operator/hardware config ONLY (the provisioning SSID default +
  # DROPLET_AP_PHY/IFACE pins). It must NOT be droplet-writable — a
  # droplet-writable file loaded via EnvironmentFile lets a compromised bridge
  # inject arbitrary env into a root unit (LPE). The sandboxed wizard Wi-Fi
  # writes instead land in the bridge's own StateDirectory
  # (/var/lib/droplet-bridge/openwrt-attach.env), which root reads back through
  # the validated customer_ap_creds / customer_guest_creds whitelist parse —
  # never as env. So there is deliberately NO chown to the droplet user here.
  [ -f /etc/default/droplet-openwrt-attach ] && \
    sudo chmod 0600 /etc/default/droplet-openwrt-attach

  # --- /etc/droplet/ (per-box secrets: ap-psk, device-bridge.env) ---------
  # WARP-1035: must exist BEFORE `compose up` — docker-compose bind-mounts
  # this DIRECTORY read-only into matter-controller so the sidecar can read
  # the per-box AP PSK (WARP-819) for BLE-first commissioning (WARP-895).
  # Pre-creating it host-side keeps ownership/mode deterministic (root
  # 0755) instead of relying on dockerd's implicit missing-bind-source
  # creation. The ap-psk file itself is written 0600 by
  # droplet-openwrt-attach on first boot — never here.
  sudo install -d -m 0755 /etc/droplet

  # --- /etc/droplet-host-net/ -----------------------------------------
  sudo install -d -m 0755 /etc/droplet-host-net
  sudo install -m 0644 "$host_src/etc-droplet-host-net/lan-dhcp.conf" \
    /etc/droplet-host-net/lan-dhcp.conf

  # --- network self-heal (WARP-1680) --------------------------------------
  # Backstop for a NIC rename / dead uplink leaving the box with no IPv4 and
  # no remote path in. Acts ONLY when nothing holds a usable address, so it is
  # a no-op on every healthy boot. The primary defence is MAC-matched netplan
  # (scripts/host/etc-netplan/70-eth.yaml.example) — this is what saves the box
  # when that is not enough.
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-net-selfheal" \
    /usr/local/sbin/droplet-net-selfheal

  # --- systemd units -----------------------------------------------------
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-net-selfheal.service" \
    /etc/systemd/system/droplet-net-selfheal.service
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-openwrt-attach.service" \
    /etc/systemd/system/droplet-openwrt-attach.service
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-host-net.service" \
    /etc/systemd/system/droplet-host-net.service
  sudo install -d -m 0755 /etc/systemd/system/droplet-openwrt-attach.service.d
  sudo install -m 0644 \
    "$host_src/etc-systemd-system/droplet-openwrt-attach.service.d/override.conf" \
    /etc/systemd/system/droplet-openwrt-attach.service.d/override.conf
  # WARP-843: env-file watcher + reapply relay. The sandboxed device-bridge
  # writes /etc/default/droplet-openwrt-attach but holds NO restart privilege;
  # this root-owned pair re-applies the AP config on every change (the relay
  # exists because the attach service is RemainAfterExit=yes — a path-triggered
  # START of it would be a no-op; the relay performs the restart).
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-openwrt-attach.path" \
    /etc/systemd/system/droplet-openwrt-attach.path
  sudo install -m 0644 \
    "$host_src/etc-systemd-system/droplet-openwrt-attach-reapply.service" \
    /etc/systemd/system/droplet-openwrt-attach-reapply.service
  # WARP-2064: container-lifecycle watcher for the attach (see the sbin
  # install above). Long-running docker-events consumer, Restart=always.
  sudo install -m 0644 \
    "$host_src/etc-systemd-system/droplet-openwrt-watch.service" \
    /etc/systemd/system/droplet-openwrt-watch.service

  # --- SSH access toggle (WARP-1984) ---------------------------------------
  # Network → System's "Allow SSH" control. The orchestrator (a container)
  # writes an intent file; this root-owned path+service pair applies it. No
  # relay unit here: droplet-ssh-access.service is a plain oneshot, so a
  # path-triggered start really executes (see the note above on why the
  # openwrt-attach pair needs one and this does not).
  #
  # The state dir is root-owned and NOT group-writable: `state` is what the
  # dashboard trusts as the source of truth, and the container gets it through
  # a read-only bind (see docker-compose.yml). Ownership alone would not be
  # enough — the orchestrator runs as container UID 0 and a bind mount does no
  # UID remapping, so a writable mount here would let it forge or delete
  # `state` no matter who owns the file.
  #
  # The writable half is the intent.d/ subdirectory, bind-mounted rw on its
  # own. A directory, not a bare file, because the orchestrator writes intent
  # by mktemp+rename and a single-FILE bind detaches when its inode is
  # replaced (WARP-1908).
  sudo install -d -m 0755 -o root -g root \
    /var/lib/droplet-ssh-access
  sudo install -d -m 0775 -o root -g "${DROPLET_GROUP:-droplet}" \
    /var/lib/droplet-ssh-access/intent.d
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-ssh-access" \
    /usr/local/sbin/droplet-ssh-access
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-ssh-access.service" \
    /etc/systemd/system/droplet-ssh-access.service
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-ssh-access.path" \
    /etc/systemd/system/droplet-ssh-access.path
  # Boot reset (the third artefact): PathModified= does not fire when the
  # path unit starts against a pre-existing unchanged intent file, so without
  # this oneshot a reboot left `state` claiming on while sshd (deliberately
  # start-not-enabled) was down — a green toggle over an unreachable box. At
  # boot it rewrites the intent to off; the watcher fires on the modification
  # and the applier records the truth.
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-ssh-access-boot-reset" \
    /usr/local/sbin/droplet-ssh-access-boot-reset
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-ssh-access-boot-reset.service" \
    /etc/systemd/system/droplet-ssh-access-boot-reset.service
  # Enable the WATCHER, not the service — the service is meant to run only when
  # the intent file changes. Deliberately no `systemctl start` of the service
  # here: installing the toggle must not itself change whether SSH is on.
  sudo systemctl enable --now droplet-ssh-access.path >/dev/null 2>&1 || true
  # The boot reset: `enable`, never `enable --now`. It belongs to the NEXT
  # boot — running it at install time would flip a live support session's
  # intent to off mid-setup, and installing the toggle must not itself change
  # whether SSH is on, in either direction.
  sudo systemctl enable droplet-ssh-access-boot-reset.service >/dev/null 2>&1 || true
  log_success "Installed the SSH-access toggle (droplet-ssh-access.path + service + boot reset)"

  # --- /etc/tmpfiles.d/ and /etc/avahi/services/ --------------------------
  sudo install -m 0644 "$host_src/etc-tmpfiles.d/droplet.conf" \
    /etc/tmpfiles.d/droplet.conf
  sudo install -d -m 0755 /etc/avahi/services
  sudo install -m 0644 "$host_src/etc-avahi/services/droplet.service" \
    /etc/avahi/services/droplet.service

  # --- unified self-heal watchdog (WARP-1002) ------------------------------
  # One timer-driven supervisor for the proven-heal wedge states (Wi-Fi PCI
  # death via the WARP-869 helper, XVF3800 voice-DSP wedge, docker DNS,
  # container crash-loops). Status: /var/lib/droplet/watchdog/status.json.
  sudo install -m 0755 "$host_src/droplet-watchdog.sh" \
    /usr/local/sbin/droplet-watchdog
  # The WARP-869 Wi-Fi wedge helper is the watchdog's wifi detect+heal engine.
  # install-device-bridge.sh also installs it (idempotent), but landing it
  # here too closes the first-boot ordering gap — the watchdog timer must
  # never tick before its helper exists.
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-wifi-watchdog" \
    /usr/local/sbin/droplet-wifi-watchdog
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-watchdog.service" \
    /etc/systemd/system/droplet-watchdog.service
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-watchdog.timer" \
    /etc/systemd/system/droplet-watchdog.timer
  # Per-box tuning file: install once, never clobber operator edits.
  if [ ! -f /etc/default/droplet-watchdog ]; then
    sudo install -m 0644 "$host_src/etc-default/droplet-watchdog" \
      /etc/default/droplet-watchdog
  fi
  # Migration: the standalone WARP-869 timer is superseded — the unified
  # watchdog invokes the same helper, and two independent schedulers could
  # race a PCI remove/rescan. The helper script itself stays installed.
  sudo systemctl disable --now droplet-wifi-watchdog.timer 2>/dev/null || true
  sudo rm -f /etc/systemd/system/droplet-wifi-watchdog.service \
             /etc/systemd/system/droplet-wifi-watchdog.timer
  log_success "Installed /usr/local/sbin/droplet-watchdog (+ units; supersedes droplet-wifi-watchdog.timer)"

  # --- WARP-1829 host-unit refresh ----------------------------------------
  # Host units execute their source out of the git working tree
  # (droplet-device-bridge.service runs `/usr/bin/python3
  # <repo>/services/oled-display/device-bridge.py`), and the box's refresh
  # restarts CONTAINERS only — so a merged fix could sit inert in a running
  # process indefinitely while the repo, the file on disk and `systemctl
  # status` all looked correct. This ships BOTH halves:
  #   * /usr/local/sbin/droplet-host-units — `check` is the standalone
  #     detector (ExecMainStartTimestamp vs the mtime of the sources the
  #     unit executes); `refresh` restarts exactly what is stale.
  #   * droplet-host-units.service — the on-demand hook the refresh flow
  #     starts. Deliberately NOT enabled and given NO timer: the standing
  #     detection rides the existing droplet-watchdog.timer pass as the
  #     `host_unit_staleness` check, so there is one scheduler, not two.
  sudo install -m 0755 "$host_src/droplet-host-units.sh" \
    /usr/local/sbin/droplet-host-units
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-host-units.service" \
    /etc/systemd/system/droplet-host-units.service
  log_success "Installed /usr/local/sbin/droplet-host-units (+ on-demand unit)"

  # --- XVF3800 DSP control tool (xvf_host) for voice_dsp self-heal (WARP-1408) -
  # Both the host watchdog (droplet-watchdog.sh) and voice-io's POST
  # /voice/restart-processor shell out to `xvf_host REBOOT 1` to clear a wedged
  # XVF3800 DSP. Vendored + checksum-verified (scripts/host/xvf/) so DSP recovery
  # survives a reflash instead of being wiped with /tmp. xvf_host resolves its
  # dlopen'd libs binary-adjacent, so the libs are co-located with the binary;
  # /usr/local/bin is bind-mounted read-only into voice-io at /host/usr-local-bin,
  # so this one install serves BOTH the host watchdog and the container endpoint.
  local xvf_src
  case "$(uname -m)" in
    x86_64) xvf_src="$host_src/xvf/linux_x86_64" ;;
    *)      xvf_src="" ;;
  esac
  if [ -z "$xvf_src" ] || [ ! -f "$xvf_src/xvf_host" ]; then
    log_warn "xvf_host: no vendored payload for arch $(uname -m) — XVF3800 DSP self-heal unavailable"
  elif ! ( cd "$xvf_src" && sha256sum -c SHA256SUMS ) >/dev/null 2>&1; then
    # Never install an unverified control binary. Loud but non-fatal: the box
    # still boots and the voice_dsp check reports the missing tool honestly.
    log_error "xvf_host: SHA256 verification FAILED in $xvf_src — refusing to install (DSP self-heal unavailable)"
  else
    sudo install -m 0755 "$xvf_src/xvf_host" /usr/local/bin/xvf_host
    sudo install -m 0644 \
      "$xvf_src/libcommand_map.so" "$xvf_src/libdevice_usb.so" \
      "$xvf_src/transport_config.yaml" "$xvf_src/dfu_cmds.yaml" \
      /usr/local/bin/
    if [ -x /usr/local/bin/xvf_host ]; then
      log_success "Installed xvf_host + libs to /usr/local/bin (XVF3800 DSP self-heal survives reflash)"
    else
      log_error "xvf_host: install ran but /usr/local/bin/xvf_host is not executable"
    fi
  fi

  # --- WARP-268 egress-audit collector -------------------------------------
  sudo install -d -m 0755 /usr/local/lib/droplet-egress-audit
  sudo install -m 0644 "$REPO_ROOT/services/egress-audit/"*.py \
    /usr/local/lib/droplet-egress-audit/
  sudo install -m 0755 "$host_src/usr-local-sbin/droplet-egress-audit" \
    /usr/local/sbin/droplet-egress-audit
  sudo install -m 0644 "$host_src/etc-systemd-system/droplet-egress-audit.service" \
    /etc/systemd/system/droplet-egress-audit.service
  if [ ! -f /etc/default/droplet-egress-audit ]; then
    sudo install -m 0644 "$host_src/etc-default/droplet-egress-audit" \
      /etc/default/droplet-egress-audit
    sudo sed -i \
      -e "s|^DROPLET_ENV_FILE=.*|DROPLET_ENV_FILE=$REPO_ROOT/.env|" \
      -e "s|^DROPLET_EGRESS_ALLOWLIST=.*|DROPLET_EGRESS_ALLOWLIST=$REPO_ROOT/docs/security/allowed-egress.yaml|" \
      /etc/default/droplet-egress-audit
  fi
  # Collector deps (best-effort apt — restic precedent in lib/backup.sh: a
  # transient failure must not abort setup; the unit fails loudly until
  # they exist and a setup.sh re-run self-heals).
  if command -v apt-get >/dev/null 2>&1; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
      conntrack tcpdump python3-yaml || \
      log_warn "egress-audit deps missing — droplet-egress-audit.service will fail until 'sudo apt-get install -y conntrack tcpdump python3-yaml' succeeds"
  fi
  log_success "Installed droplet-egress-audit collector (WARP-268)"

  # --- Migrate from the pre-rename service name if present (WARP-445) -----
  # This block is the only code in scripts/ that still OPERATES on the
  # legacy `droplet-poc-host-net` name (the rename to `droplet-host-net`
  # itself landed in PR #676): a box provisioned BEFORE the rename still
  # runs the old unit,
  # and the only way to retire it is to name it here. ship-check's
  # lifecycle-naming check grandfathers exactly this token for that reason
  # (its allowlist + hint text are the only other mentions). Delete this
  # whole block, and the grandfather with it, once the fleet has no
  # pre-rename boxes left.
  #
  # Idempotent: on a second run the old unit file is gone, so the flag stays
  # 0 and the rm sweep no-ops — no restart of the renamed service, no logs.
  local legacy_host_net_migrated=0
  if [ -f /etc/systemd/system/droplet-poc-host-net.service ]; then
    legacy_host_net_migrated=1
    sudo systemctl disable --now droplet-poc-host-net.service 2>/dev/null || true
  fi
  # The file sweep stays unconditional — rm -f/-rf no-op when absent, and an
  # earlier torn migration (unit gone, script/env/confdir left) still heals.
  sudo rm -f /etc/systemd/system/droplet-poc-host-net.service \
             /usr/local/sbin/droplet-poc-host-net \
             /etc/default/droplet-poc-host-net
  sudo rm -rf /etc/droplet-poc-host-net

  # --- Activate ----------------------------------------------------------
  sudo systemctl daemon-reload
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/droplet.conf 2>/dev/null || true
  # WARP-1680: enabled (not --now) — it is a boot-time recovery path, and
  # running it mid-setup on a healthy box would only log a no-op.
  sudo systemctl enable droplet-net-selfheal.service >/dev/null 2>&1
  sudo systemctl enable droplet-openwrt-attach.service >/dev/null 2>&1
  # WARP-843: --now so the watcher is live immediately (not only after the
  # next reboot) — the wizard's first Wi-Fi save can happen minutes after
  # setup.sh finishes. The relay itself is start-on-demand (no [Install]).
  sudo systemctl enable --now droplet-openwrt-attach.path >/dev/null 2>&1
  # WARP-2064: --now so the container-lifecycle watcher is live immediately —
  # the very next `docker compose up -d` could recreate droplet-openwrt, and
  # the watcher's own startup heal also fixes a DNAT already stranded by an
  # earlier recreate on this box. `restart` covers a re-run of setup.sh
  # replacing the script under a running watcher.
  sudo systemctl enable droplet-openwrt-watch.service >/dev/null 2>&1
  sudo systemctl restart droplet-openwrt-watch.service >/dev/null 2>&1 || true
  sudo systemctl enable droplet-host-net.service >/dev/null 2>&1
  # WARP-445: when the pre-rename unit was just stopped above, the renamed
  # unit must be STARTED now (not just enabled) — otherwise br-lan loses its
  # DHCP server + switch route until the next reboot. `restart` (not `start`)
  # so a half-alive instance from a torn earlier migration picks up the fresh
  # files too. `|| true`: a start failure must not abort setup — the unit
  # fails loudly in journalctl and Restart=on-failure keeps retrying.
  if [ "$legacy_host_net_migrated" = 1 ]; then
    sudo systemctl restart droplet-host-net.service >/dev/null 2>&1 || true
    log_success "Migrated pre-rename host-net service — old unit disabled + files removed, droplet-host-net.service enabled + started"
  fi
  # WARP-1002: unified self-heal watchdog — always on; the healthy-path cost
  # is a handful of read-only sysfs/docker probes every ~3 minutes.
  sudo systemctl enable --now droplet-watchdog.timer >/dev/null 2>&1
  # WARP-268: runtime egress-audit collector. restart|| true so a missing
  # apt dep (conntrack/tcpdump/python3-yaml) doesn't fail the whole install;
  # the unit self-heals on the next setup.sh re-run once the deps land.
  sudo systemctl enable droplet-egress-audit.service >/dev/null 2>&1
  sudo systemctl restart droplet-egress-audit.service >/dev/null 2>&1 || true

  log_success "single-box host integration installed"
  log_info "  Boot-time:   droplet-openwrt-attach.service + droplet-host-net.service"
  log_info "  Self-heal:   droplet-watchdog.timer (status: /var/lib/droplet/watchdog/status.json)"
  log_info "  Status:      sudo systemctl status droplet-openwrt-attach droplet-host-net"
  log_info "  Logs:        sudo journalctl -u droplet-openwrt-attach -u droplet-host-net -u droplet-watchdog"
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
# WARP-1947 — the box's home-facing WireGuard endpoint IP
# ============================================================================
#
# Derive the box's default-route egress source IPv4 — the LAN address a
# same-network client dials the overlay WireGuard endpoint at. This is the
# value `WIREGUARD_HOME_ENDPOINT_HOST` pins so the issued overlay profile
# carries a REACHABLE `lan` candidate.
#
# Why derive it here rather than leave the env empty and let the orchestrator
# discover it at request time (the vpn-home-endpoint.ts design):
#   - On the single-box shape the host owns the uplink, so the routing summary
#     has NO WAN address — tier 1 of the request-time precedence yields nothing.
#   - The env fallback (tier 2) is consulted BEFORE the device-bridge
#     /host/uplink-ip probe (tier 3), so a STALE pin silently shadows discovery
#     (this box shipped 192.168.1.87, a dead former IP, and every issued profile
#     pointed its only endpoint at a corpse — no_usable_endpoint).
#   - /host/uplink-ip returns null on this shape today, and the orchestrator
#     often has no BRIDGE_AUTH_TOKEN, so leaving the env empty yields NO lan
#     candidate at all.
# The module doc explicitly allows an operator to pin the host's DHCP IP here;
# doing it at provision time (re-derived on every setup run, overwriting any
# stale value) keeps it correct across DHCP changes and a factory reset.
#
# `ip route get 1.1.1.1` reports the source address the kernel would use for
# off-box traffic — the box's real uplink IP. Parsed with awk (portable; no
# grep -P dependency). Prints the IP on success, exit 1 when there is no usable
# address so the caller can leave any existing value alone rather than blank it.
derive_single_box_home_endpoint() {
  local line ip
  line="$(ip route get 1.1.1.1 2>/dev/null)" || return 1
  ip="$(printf '%s\n' "$line" \
    | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
  case "$ip" in
    # Mirror vpn-home-endpoint.ts isUsableHostIp(): reject placeholders/self.
    '' | 0.0.0.0 | 127.* | 169.254.*) return 1 ;;
  esac
  # A crude IPv4 shape guard — never emit anything that isn't dotted-quad, so a
  # surprising `ip` output can't land junk in a minted conf.
  case "$ip" in
    *[!0-9.]*) return 1 ;;
  esac
  printf '%s' "$ip"
}

# ----------------------------------------------------------------------------
# WARP-1982 — the box's own LAN IPv4 addresses, for Nextcloud's trusted_domains.
#
# Browsing the appliance BY IP is a first-class path, not an edge case: the
# setup wizard hands out an address before any name resolves, droplet.local /
# .lan answer only on the appliance's own LAN, and the per-device FQDN is
# split-horizon. A browser on a neighbouring segment has no name at all. If the
# address it uses is not in Nextcloud's trusted_domains, the dashboard loads
# (Next.js does not check Host) while every Nextcloud leg — the embedded
# document editor above all — answers HTTP 400.
#
# WHY NOT WILDCARDS, which is what WARP-1973 tried and WARP-1982 removed:
# Nextcloud expands a `*` in a trusted-domain entry to `[-\.a-zA-Z0-9]*`, a
# class that includes LETTERS AND DOTS. So `192.168.*` compiles to
# /^192\.168\.[-\.a-zA-Z0-9]*$/i and matches `192.168.evil.com` — measured, not
# theorised. Any attacker controlling a DNS name of that shape pointed at the
# box passes the allowlist, which is the Host-header poisoning the list exists
# to prevent. No wildcard can express "IPv4 in this range only"; narrowing the
# prefix does not help, since `192.168.5.*` still matches `192.168.5.evil`.
#
# So: enumerate the box's ACTUAL addresses as EXACT tokens. Re-derived on every
# provision, which is what keeps it correct across a DHCP change and a factory
# reset — the same reasoning as the home endpoint above.
#
# Loopback, link-local and the Docker bridge ranges are excluded: the first two
# are never a browser's address for this box, and the in-compose services reach
# Nextcloud by service NAME (already trusted), so a bridge address would widen
# the list for nothing.
derive_single_box_lan_ips() {
  local ips
  ips="$(ip -4 -o addr show scope global 2>/dev/null \
    | awk '{ split($4, a, "/"); print a[1] }' \
    | awk '
        /^127\./      { next }   # loopback
        /^169\.254\./ { next }   # link-local
        /^172\.1[7-9]\./ { next }  # docker default bridge pool
        /^172\.2[0-9]\./ { next }
        /^172\.3[01]\./  { next }
        /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print }
      ' \
    | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  [ -n "$ips" ] || return 1
  printf '%s' "$ips"
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
configure_single_box_env() {
  local env_file="$REPO_ROOT/.env"
  if [ ! -f "$env_file" ]; then
    log_error "configure_single_box_env: $env_file missing — generate_env must run first"
    return 1
  fi

  # WARP-595: normalize a missing trailing newline BEFORE any append below
  # (the one-time header block and upsert_env both append). A torn write from
  # an interrupted previous run — or a hand edit — can leave .env without a
  # trailing newline; appending to it would glue the new content onto the last
  # existing line and corrupt both.
  # WARP-232 (finding 2): after relocate_secrets_to_data, $env_file is a SYMLINK
  # onto the encrypted /data. All writes below must go THROUGH the link to its
  # real target — staging beside the link and `mv`-ing over it would replace the
  # symlink with a plain file on the unencrypted root (moving DEVICE_SECRET_KEY
  # back outside the LUKS boundary and breaking the compose `../.env` bind for
  # the docker-group user). Resolve once here; the newline-normalize + upsert_env
  # below operate on $env_target.
  local env_target="$env_file"
  if [ -L "$env_file" ]; then
    env_target="$(readlink -f "$env_file" 2>/dev/null || readlink "$env_file")"
    [ -n "$env_target" ] || env_target="$env_file"
  fi

  if [ -s "$env_target" ] && [ -n "$(tail -c 1 "$env_target")" ]; then
    printf '\n' >> "$env_target"
  fi

  # --- Idempotent upsert of the single-box knobs (WARP-556) ----------------
  # The base .env (generate_env + lib/compose.sh) already sets several of
  # these keys (COMPOSE_PROFILES, OLLAMA_URL, ROUTING_MODE). A blind `>>`
  # append duplicated them — harmless under `.env` last-wins, but fragile (a
  # reorder flips OLLAMA_URL to the non-resolving host) and confusing to an
  # operator debugging a fresh install. upsert_env strips any existing copy
  # of a key before writing it, so re-running setup.sh never duplicates one.
  #
  # WARP-595: rebuild into a staging file and RENAME into place. The previous
  # implementation truncated the live .env (`cat tmp > .env`) and re-copied it
  # "to preserve perms + inode" — but an interruption between the truncate and
  # the rewrite (power cut / SSH drop mid-upsert on a RE-provision) left a
  # PREFIX of .env on disk (down to an empty file), silently dropping every
  # key after the cut — including live-stack secrets like POSTGRES_PASSWORD
  # that migrate_env cannot regenerate to match the existing data volumes.
  # rename(2) is atomic on the same filesystem and no consumer depends on the
  # .env inode; the staging copy is created under umask 077 and chmod'd 600
  # explicitly so the secrets-bearing file never transits world-readable.
  # Sweep staging siblings a previous interrupted run may have stranded
  # (process died between creating the stage and the mv) — they carry the same
  # secrets as .env and must not accumulate. Mirrors the .tmp.* / .migrate.*
  # sweeps in generate_env / migrate_env. Safe: concurrent runs are excluded
  # by setup.sh's lockfile, so no live stage can be swept.
  rm -f "$env_target".upsert.* 2>/dev/null || true

  upsert_env() {
    local key="$1" val="$2"
    # Stage next to and rename onto the REAL target (encrypted /data when
    # relocated), never the symlink itself — see the $env_target note above.
    local stage="${env_target}.upsert.$$"
    # A value containing whitespace MUST be quoted. .env is `.`-sourced as a
    # shell script in four places (setup.sh:605, verify.sh:33,
    # lib/compose.sh:659, lib/secrets.sh:1103) and bash reads a bare
    # `KEY=a b` as "assign KEY=a for the duration of the command `b`" — so the
    # variable reads back EMPTY and the shell exits 127 trying to run the
    # second field.
    #
    # That 127 fails the ENCLOSING step, which is the damaging part. It is how
    # a space-separated DROPLET_TRUSTED_LAN_IPS aborted
    # install-device-bridge.sh before its `systemctl enable --now
    # droplet-panel-claim.service`, leaving the claim code undrawn and the
    # customer hard-stopped at wizard step 2 — with no symptom beyond
    # "front-panel host integration had issues (continuing)".
    #
    # Only whitespace values change shape; every other value stays byte-for-
    # byte as before, so the other 49 call sites cannot regress. Compose's own
    # .env parser strips the quotes, so the container side is unchanged.
    local rendered
    case "$val" in
      *[[:space:]]*)
        # Escape what survives inside double quotes, so a value can never
        # execute or expand when sourced.
        local esc="$val"
        esc="${esc//\\/\\\\}"
        esc="${esc//\"/\\\"}"
        esc="${esc//\$/\\\$}"
        esc="${esc//\`/\\\`}"
        rendered="${key}=\"${esc}\""
        ;;
      *) rendered="${key}=${val}" ;;
    esac
    ( umask 077; { grep -vE "^${key}=" "$env_target" 2>/dev/null || true; \
                   printf '%s\n' "$rendered"; } > "$stage" )
    chmod 600 "$stage"
    mv "$stage" "$env_target"
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

  # WARP-1865: keep the `dmr` profile when the box is flipped to DMR.
  #
  # The WARP-1772 guard below preserves the DMR *URLs* on a re-run, but the
  # *profile* was left to the flip runbook — and flip-single-box.sh writes
  # COMPOSE_PROFILES into docker/.env while setup.sh runs compose with
  # --env-file $REPO_ROOT/.env. The two disagreed, so a re-run kept
  # OLLAMA_URL=http://dmr:12434 while never starting the dmr service, and
  # started ollama instead (its profile is `single-box`). Chat, the RAGAS
  # judge and LLM_MODEL all ended up pointing at a container that wasn't
  # running — the same un-flip failure the URL guard was written to stop,
  # arriving through the other half of the flip.
  #
  # Read from $env_target (what this run is writing) rather than $env_file:
  # INFERENCE_RUNTIME is a durable operator-set property and is what decides
  # this, exactly as it decides the URLs below. Never ADDS dmr on a box that
  # isn't flipped — an accidental flip is as bad as an accidental un-flip.
  #
  # The `ollama` arm is the mirror image, added when the ollama service moved
  # off the `single-box` profile onto its own. `single-box` is a four-service
  # bundle (openwrt, switch, camera-discovery, and formerly ollama), so while
  # ollama rode that token there was no way to stop serving Ollama without
  # dropping the router and camera discovery too — which is why a flipped box
  # kept a model-less daemon holding /dev/kfd and renderD128 open beside DMR.
  # Now exactly one runtime token is appended, so a box can never start both
  # runtimes (the SINGLE GPU OWNER violation, WARP-1826) nor neither (no
  # inference at all). Un-flipped boxes keep today's behaviour verbatim.
  local _profiles_runtime
  _profiles_runtime="$(grep -E '^INFERENCE_RUNTIME=' "$env_target" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]' || true)"
  if [ "$_profiles_runtime" = "dmr" ]; then
    case ",${merged_profiles}," in
      *,dmr,*) : ;;
      *)       merged_profiles="${merged_profiles},dmr"
               log_info "single-box env: INFERENCE_RUNTIME=dmr — kept the dmr profile in COMPOSE_PROFILES (WARP-1865)" ;;
    esac
    # Belt and braces: if a half-finished flip left `ollama` in the list, drop
    # it. Leaving both is the one outcome worse than either alone.
    case ",${merged_profiles}," in
      *,ollama,*)
        merged_profiles="$(printf '%s' "$merged_profiles" | tr ',' '\n' | grep -vx 'ollama' | paste -sd, -)"
        log_info "single-box env: INFERENCE_RUNTIME=dmr — dropped the stale ollama profile (single GPU owner, WARP-1826)" ;;
    esac
  else
    # The mirror strip. Without it the exclusion is one-directional: the dmr
    # arm above drops a stale `ollama`, but a box carrying `dmr` whose runtime
    # is ollama (or unset) would keep `dmr` AND gain `ollama` — both runtimes
    # on one card, the very WARP-1826 violation this block exists to prevent,
    # arriving from the rollback direction instead of the flip direction.
    # Strip BEFORE the add so the add sees an already-cleaned list.
    case ",${merged_profiles}," in
      *,dmr,*)
        merged_profiles="$(printf '%s' "$merged_profiles" | tr ',' '\n' | grep -vx 'dmr' | paste -sd, -)"
        log_info "single-box env: INFERENCE_RUNTIME is not dmr — dropped the stale dmr profile (single GPU owner, WARP-1826)" ;;
    esac
    case ",${merged_profiles}," in
      *,ollama,*) : ;;
      ,,)         merged_profiles="ollama" ;;
      *)          merged_profiles="${merged_profiles},ollama"
                  log_info "single-box env: INFERENCE_RUNTIME is not dmr — added the ollama profile so the box has an inference runtime" ;;
    esac
  fi

  # RAG eval (RAGAS retrieval-quality scoring) — enabled by DEFAULT on the
  # single-box shape (bug #15). The `rag-eval` service is `["eval"]`-profiled,
  # so it's reached by APPENDING `eval` to COMPOSE_PROFILES here — the same
  # mechanism as `single-box` above. docker-compose.yml's eval-profile
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

  # Cloudflare Tunnel relay (`relay` profile, WARP-974 / ADR-025) — the outbound
  # remote-access connector (cloudflared) that replaces DuckDNS + the inbound
  # WireGuard port. OPT-IN: activate `relay` ONLY when a TUNNEL_TOKEN is present in
  # .env, so an un-provisioned box never brings up (and crash-loops) a tokenless
  # connector. The token is provisioned out-of-band (fleet HQ / operator) — the
  # cloudflared container reads it straight from .env via env_file.
  if grep -qE '^TUNNEL_TOKEN=.+' "$env_file" 2>/dev/null; then
    case ",${merged_profiles}," in
      *,relay,*) : ;;                                # already present — idempotent
      ,,)        merged_profiles="relay" ;;
      *)         merged_profiles="${merged_profiles},relay" ;;
    esac
  fi

  # Document engine (`docs` profile, WARP-882 / WARP-1686 / ADR-027 WS-4) —
  # RAM GATED. The engine (Collabora CODE by default per ADR-034 — no
  # licensing fee; OnlyOffice CE via DOCS_ENGINE=onlyoffice) is a ~2 GB
  # always-on image, so it is DEFAULT-ON on a roomy box, DROPPED on a small one:
  #   * total RAM > SINGLE_BOX_DOCS_MIN_GIB (default 8 GiB) → the 32 GB / 16 GB
  #     single-box ABSORBS the engine comfortably: merge `docs` into
  #     COMPOSE_PROFILES (idempotent, no duplicate) and set DOCS_ENABLED=1.
  #   * ≤ 8 GiB box → DROP `docs` and set DOCS_ENABLED=0 to reclaim the ~2 GB;
  #     the dashboard renders "Edit" as unavailable (not dead).
  # RAM is read the same way as scripts/lib/preflight.sh (MemTotal kB / 1048576).
  # If /proc/meminfo is unreadable (non-Linux dev), we DROP docs (conservative —
  # don't bring up a 2 GB engine on an unsized host). The ONLYOFFICE_JWT_SECRET
  # (used by the onlyoffice engine + the orchestrator's editor session tokens)
  # is generated unconditionally by scripts/lib/secrets.sh::generate_env
  # (openssl rand -hex 32), which runs BEFORE this on every setup — so the
  # docs path always has a strong secret regardless of engine.
  local docs_min_gib mem_kb mem_gb docs_enabled_val docs_engine
  docs_min_gib="${SINGLE_BOX_DOCS_MIN_GIB:-8}"
  mem_gb=0
  if [ -r /proc/meminfo ]; then
    # `|| true`: a no-match grep exits 1 and would abort under set -euo pipefail
    # inside this function (no inherited ERR trap). Empty → mem_gb stays 0 → drop.
    mem_kb=$({ grep -E '^MemTotal:' /proc/meminfo || true; } | awk '{print $2}')
    [ -n "$mem_kb" ] && mem_gb=$((mem_kb / 1048576))
  fi
  if [ "$mem_gb" -gt "$docs_min_gib" ]; then
    # Merge `docs` (idempotent — never duplicate if already present).
    case ",${merged_profiles}," in
      *,docs,*) : ;;                                # already present
      ,,)       merged_profiles="docs" ;;
      *)        merged_profiles="${merged_profiles},docs" ;;
    esac
    docs_enabled_val=1
    log_info "Document engine: ON (${mem_gb} GiB > ${docs_min_gib} GiB threshold) — \`docs\` profile + DOCS_ENABLED=1"
  else
    # Drop `docs` if a previous run / lib/compose.sh added it; reclaim the engine.
    local stripped_profiles="" p
    local IFS_SAVE="$IFS"; IFS=','
    for p in $merged_profiles; do
      [ "$p" = "docs" ] && continue
      [ -z "$p" ] && continue
      stripped_profiles="${stripped_profiles:+${stripped_profiles},}${p}"
    done
    IFS="$IFS_SAVE"
    merged_profiles="$stripped_profiles"
    docs_enabled_val=0
    log_info "Document engine: OFF (${mem_gb} GiB ≤ ${docs_min_gib} GiB threshold) — dropped \`docs\`, DOCS_ENABLED=0"
  fi

  # --- Descriptive header block: surgical replace (WARP-444) ---------------
  # The block below is pure documentation (comment lines only); the knob
  # VALUES are upsert_env'd after it. The previous skip-when-marker-present
  # guard was only half idempotent: it never refreshed stale header prose
  # after the knob set changed, and it did nothing about the duplicate
  # blocks that pre-guard setup retries had already appended (the live box
  # accumulated three). So instead of skipping: strip EVERY existing copy of
  # the block — the marker line plus its enclosing run of comment lines and
  # one preceding blank spacer — and append ONE fresh copy. A re-run
  # converges to exactly one up-to-date block, and an .env carrying
  # accumulated duplicates dedupes on the next run. Only comment/blank lines
  # are ever removed, so KEY=value lines interleaved between stale blocks
  # survive untouched.
  local block_marker='Single-box deployment knobs (managed by scripts/lib/single-box.sh'
  local had_block=0
  if grep -qF "$block_marker" "$env_target"; then
    had_block=1
    # Same staged-write + rename discipline as upsert_env above (WARP-595
    # atomicity, WARP-232 symlink-aware): rebuild into a 0600 stage next to
    # the REAL target and rename over it — never truncate the live .env.
    local block_stage="${env_target}.upsert.$$"
    ( umask 077; awk -v marker="$block_marker" '
        { lines[NR] = $0; if (index($0, marker) > 0) hit[NR] = 1 }
        END {
          for (i = 1; i <= NR; i++) {
            if (!(i in hit)) continue
            # Expand from the marker to the enclosing run of comment lines
            # (covers both `# ===` fences, and stays bounded on a torn block
            # missing its closing fence) plus one preceding blank spacer, so
            # a removed block leaves no stranded fence or double blank.
            s = i; while (s > 1 && lines[s-1] ~ /^#/) s--
            if (s > 1 && lines[s-1] ~ /^[[:space:]]*$/) s--
            e = i; while (e < NR && lines[e+1] ~ /^#/) e++
            for (j = s; j <= e; j++) del[j] = 1
          }
          for (i = 1; i <= NR; i++) if (!(i in del)) print lines[i]
        }' "$env_target" > "$block_stage" )
    chmod 600 "$block_stage"
    mv "$block_stage" "$env_target"
  fi

  # Append the one fresh copy (through $env_target — see the symlink note
  # above; appending via the symlink would work, but every other write in
  # this function targets the resolved path, so stay consistent).
  cat >> "$env_target" << 'EOF'

# ============================================================================
# Single-box deployment knobs (managed by scripts/lib/single-box.sh —
# re-run setup.sh --regenerate-env to reset; see docs/SINGLE_BOX.md).
#   COMPOSE_PROFILES     linux (Frigate) + display (OLED sim) + single-box
#                        (single-box also activates camera-discovery — gated
#                        to `full` otherwise). single-box.sh ALSO appends
#                        `eval` by DEFAULT so the rag-eval (RAGAS) service runs
#                        and /api/admin/rag-eval/* works out-of-the-box
#                        (bug #15); set RAG_EVAL_DISABLED=1 to pause runs.
#                        `docs` (document engine, WARP-882/WARP-1686) is
#                        RAM-GATED: merged in + DOCS_ENABLED=1 when total RAM >
#                        8 GiB (the 32 GB / 16 GB box), dropped + DOCS_ENABLED=0
#                        on a ≤8 GB box. Threshold: SINGLE_BOX_DOCS_MIN_GIB.
#   DOCS_ENABLED         document-engine master switch (RAM-gated above).
#   DOCS_ENGINE          which engine: collabora (default — Collabora CODE,
#                        LibreOffice, no licensing fee, ADR-034) or onlyoffice
#                        (kept for a future OEM-licensed SKU).
#   DOCS_ENGINE_IMAGE    engine image; written together with DOCS_ENGINE.
#   DOCS_INTERNAL_URL    compose-network engine URL the orchestrator
#                        health-probes (engine-dependent: coolwsd
#                        :9980/docs vs OnlyOffice :80).
#   FRIGATE_RENDER_NODE  DETECTED from /dev/dri (WARP-1680): the second render
#                        node when the host has two (leaving the dGPU for
#                        Ollama), otherwise the only one. Never assumed —
#                        a hardcoded renderD129 broke every single-GPU box.
#   CAMERA_SUBNET        "auto" — camera-discovery resolves the camera network
#                        from the edge router at scan time (WARP-1805);
#                        overrides the multi-box VLAN default 192.168.100.0/24
#   WIREGUARD_LAN_CIDR/  VPN peer .conf AllowedIPs + DNS, pinned to the single-
#   WIREGUARD_DNS        box LAN (br-lan 192.168.20.0/24, gateway/dnsmasq at
#                        192.168.20.1). Overrides the orchestrator's multi-box
#                        LAN defaults (192.168.50.x in
#                        apps/orchestrator/src/config.ts) so a remote VPN client
#                        can reach the dashboard + resolve *.lan (WARP-839).
#   WIREGUARD_HOME_ENDPOINT_HOST DERIVED (WARP-1947) — the box's default-route
#                        egress IPv4, the LAN address a same-network overlay
#                        client dials the WireGuard endpoint at. Request-time
#                        discovery can't find it on this shape (host owns WAN,
#                        /host/uplink-ip null), and a stale pin shadows it (this
#                        box shipped a dead 192.168.1.87), so it is derived +
#                        pinned here, overwriting any stale value on every run.
#                        Skipped (prior value left) when there's no default route.
#   OLLAMA_URL           compose-internal `ollama` service
#   RAGAS_OLLAMA_URL     rag-eval judge → the same in-network ollama (/v1);
#                        the compose host.docker.internal default is
#                        unreachable here (bundled ollama publishes
#                        loopback-only on the host)
#   OPENSSL_CONF/FIPS/TPM consumer x86 has no FIPS OpenSSL / TPM 2.0
#   LLM_MODEL            THE one model (architecture-guard one-model rule)
#   OPENWRT_*            bundled openwrt container at 127.0.0.1:8181
#   DROPLET_AP_MODE      hostapd — the single-box host runs the Wi-Fi AP via
#                        hostapd (not a standalone UCI router), so the device-bridge
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
  if [ "$had_block" = 1 ]; then
    log_info "Replaced existing single-box block in .env"
  fi

  upsert_env COMPOSE_PROFILES    "$merged_profiles"
  # Document-engine master switch + internal URL, RAM-gated above. The
  # orchestrator reads DOCS_ENABLED (explicit, never inferred from absence) and
  # probes DOCS_INTERNAL_URL for the engine's health; on a small box DOCS_ENABLED=0
  # makes /files/docs/status report "unavailable" and the editor degrade cleanly.
  upsert_env DOCS_ENABLED        "$docs_enabled_val"
  # WARP-1686 (ADR-034): engine-selectable document server. DOCS_ENGINE picks
  # the engine; the compose image + the orchestrator's internal probe URL MUST
  # track it (coolwsd listens on :9980 under net.service_root=/docs; OnlyOffice
  # listens on :80 at its root), so all three are written together and never
  # diverge. An existing .env's DOCS_ENGINE (operator choice) is respected —
  # a shell-env override wins for a supervised one-off run.
  docs_engine="${DOCS_ENGINE:-}"
  if [ -z "$docs_engine" ] && [ -f "$env_target" ]; then
    docs_engine="$({ grep -E '^DOCS_ENGINE=' "$env_target" || true; } | tail -1 | cut -d= -f2-)"
  fi
  docs_engine="${docs_engine:-collabora}"
  case "$docs_engine" in
    onlyoffice)
      upsert_env DOCS_ENGINE        onlyoffice
      upsert_env DOCS_ENGINE_IMAGE  "onlyoffice/documentserver:8.2"
      upsert_env DOCS_INTERNAL_URL  http://docserver
      log_info "Document engine: onlyoffice (OEM-licensed SKU posture — AGPLv3 CE otherwise)"
      ;;
    *)
      upsert_env DOCS_ENGINE        collabora
      upsert_env DOCS_ENGINE_IMAGE  "collabora/code:26.04.2.4.1"
      upsert_env DOCS_INTERNAL_URL  "http://docserver:9980/docs"
      log_info "Document engine: collabora (Collabora CODE — LibreOffice, no licensing fee)"
      ;;
  esac
  # WARP-1680: DETECT the render node — never assume a two-GPU layout.
  # This was hardcoded to renderD129 on the theory that the dGPU (renderD128)
  # is reserved for Ollama. On a box whose GPU is a single AMD Raphael iGPU
  # only renderD128 exists, so Frigate's device map pointed at a node that was
  # not there. Docker refuses to create a container with a missing device, and
  # because that failure aborts the whole `docker compose up` run it stranded
  # gateway/ai-gateway/file-indexer/rag-eval/docserver in `Created` — the
  # dashboard went dark (gateway owns 80/443) while 21 other containers ran
  # fine. Prefer the SECOND render node when the host really has two (keeping
  # the dGPU free for Ollama); fall back to the only one that exists.
  local render_node
  render_node="$(ls -1 /dev/dri/renderD* 2>/dev/null | sort | sed -n '2p')"
  [ -n "$render_node" ] || render_node="$(ls -1 /dev/dri/renderD* 2>/dev/null | sort | head -n1)"
  if [ -n "$render_node" ]; then
    upsert_env FRIGATE_RENDER_NODE "$render_node"
    log_info "FRIGATE_RENDER_NODE detected: $render_node"
  else
    # No DRM render node at all (headless VM / passthrough-less host). Leave
    # the compose default; Frigate falls back to CPU decode.
    log_warn "no /dev/dri/renderD* found — leaving FRIGATE_RENDER_NODE at the compose default"
  fi
  # CAMERA_SUBNET: the compose default (192.168.100.0/24) is the multi-box
  # OpenWrt camera VLAN (openwrt/files/etc/config/dhcp `cameras`). The
  # single-box shape has no separate camera VLAN today — cameras attach to
  # whatever LAN the edge router serves, and a provision-time constant here
  # has now gone stale TWICE (192.168.100.0/24 when ADR-018 pinned br-lan
  # 192.168.20.0/24; then 192.168.20.0/24 when networking moved to the Pi
  # edge router and cameras landed on its LAN — WARP-1805, camera discovery
  # ran healthy but blind both times). "auto" makes camera-discovery resolve
  # the network from the routing service's /network/interfaces at scan time,
  # so the filter follows the same router that hands cameras their leases.
  # When the OpenWrt single-box unification (ADR-018 T3) lands a real
  # isolated camera VLAN on this shape, pin this to that VLAN's network.
  upsert_env CAMERA_SUBNET       auto
  # WARP-839: pin the WireGuard peer LAN CIDR + DNS to the single-box LAN. The
  # orchestrator's defaults (WIREGUARD_LAN_CIDR=192.168.50.0/24,
  # WIREGUARD_DNS=192.168.50.1 in apps/orchestrator/src/config.ts) are the
  # MULTI-BOX LAN. The single-box LAN is br-lan 192.168.20.0/24 with the
  # gateway + dnsmasq at 192.168.20.1 (droplet.local -> 192.168.20.1), so the
  # rendered peer .conf AllowedIPs/DNS must point there — otherwise a remote VPN
  # client can't reach the dashboard or resolve *.lan. Multi-box keeps the
  # config.ts 192.168.50.x defaults (untouched); this override is written ONLY
  # on the single-box path.
  upsert_env WIREGUARD_LAN_CIDR  192.168.20.0/24
  upsert_env WIREGUARD_DNS       192.168.20.1
  # WARP-1947: pin the box's home-facing endpoint IP so a same-network client's
  # overlay profile carries a REACHABLE `lan` candidate. See the
  # derive_single_box_home_endpoint() banner above for the full why — in short,
  # request-time discovery cannot find it on this shape, and a stale hardcode
  # (this box shipped a dead 192.168.1.87) is worse than none. Derived + upserted
  # here, so it re-derives on every provision and survives a factory reset. If the
  # box has no default route yet (headless first boot), leave any prior value
  # rather than blanking an operator pin — the client just falls back to whatever
  # runtime discovery can find, and the next setup run fixes it.
  local _home_endpoint
  if _home_endpoint="$(derive_single_box_home_endpoint)"; then
    upsert_env WIREGUARD_HOME_ENDPOINT_HOST "$_home_endpoint"
    log_info "WIREGUARD_HOME_ENDPOINT_HOST derived from default route: $_home_endpoint"
  else
    log_warn "could not derive the box egress IP (no default route?) — leaving WIREGUARD_HOME_ENDPOINT_HOST unchanged; the overlay home candidate may be unavailable until the next setup run"
  fi
  # WARP-1982: the box's own addresses, so a browser that reaches the appliance
  # BY IP gets a working document editor instead of HTTP 400 from every
  # Nextcloud leg. Re-derived every provision so a new DHCP lease converges.
  # Leave any prior value alone if enumeration fails — blanking it would strip
  # working entries from the trust list on a box that is merely mid-reconfigure.
  local _lan_ips
  if _lan_ips="$(derive_single_box_lan_ips)"; then
    upsert_env DROPLET_TRUSTED_LAN_IPS "$_lan_ips"
    log_info "DROPLET_TRUSTED_LAN_IPS derived from the box's interfaces: $_lan_ips"
  else
    log_warn "could not enumerate the box's LAN IPv4 addresses — leaving DROPLET_TRUSTED_LAN_IPS unchanged; browsing this box BY IP may answer 400 on Nextcloud legs (the embedded editor included) until the next setup run"
  fi
  # WARP-1772: the inference runtime is a durable, operator-set property, and
  # upsert_env is an OVERWRITE — before this guard, any re-run of setup on a
  # DMR-flipped box silently pointed chat, the RAGAS judge, and the model id
  # back at Ollama and logged success (the flip audit's nastiest finding: a
  # factory re-provision that un-flips the box). INFERENCE_RUNTIME itself is
  # never WRITTEN here — the flip runbook owns it (scripts/dmr/flip-single-box.sh);
  # it is only READ so the three runtime-coupled values stay coherent with it.
  _inference_runtime="$(grep -E '^INFERENCE_RUNTIME=' "$env_target" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]' || true)"
  if [ "$_inference_runtime" = "dmr" ]; then
    log_info "single-box env: INFERENCE_RUNTIME=dmr detected — preserving the DMR wiring (WARP-1772)"
    upsert_env OLLAMA_URL        http://dmr:12434
    upsert_env RAGAS_OLLAMA_URL  http://dmr:12434/v1
    # LLM_MODEL under DMR is the EXACT id the store reports (registry-
    # qualified, derived live at flip time) — re-deriving it here would
    # reintroduce the id-vocabulary gap, so preserve what the flip set.
    _current_llm="$(grep -E '^LLM_MODEL=' "$env_target" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
    if [ -n "$_current_llm" ]; then
      upsert_env LLM_MODEL "$_current_llm"
    else
      # WARP-1870: never leave it unset. That branch predates DMR being a
      # provisioning target — it assumed a human had flipped the box and set
      # the id by hand, so "leave it alone" was the safe move. Now that a FRESH
      # box provisions to DMR, an unset LLM_MODEL means the orchestrator has
      # nothing to acquire on first boot: a dead appliance out of the crate,
      # which is strictly worse than a default that can be corrected.
      #
      # Falls back to the same constant secrets.sh writes. The `:-` literal is
      # the sourcing-order belt-and-braces; tests/dmr-default-provisioning.test.sh
      # asserts the two files agree so this copy cannot drift.
      _default_dmr_model="${DROPLET_DEFAULT_DMR_MODEL:-docker.io/ai/gpt-oss:20B-F16}"
      upsert_env LLM_MODEL "$_default_dmr_model"
      log_info "single-box env: INFERENCE_RUNTIME=dmr and LLM_MODEL was unset — defaulted to $_default_dmr_model (must match DMR's /api/tags exactly, or first boot re-pulls ~13.79 GB every time)"
    fi
  else
    upsert_env OLLAMA_URL          http://ollama:11434
    # RAGAS judge → the same in-network `ollama` service. The compose default
    # (http://host.docker.internal:11434/v1) targets a HOST-installed Ollama,
    # but the bundled single-box container publishes only 127.0.0.1:11434 on
    # the host — a loopback bind is unreachable from the bridge-gateway IP on
    # Linux, so every judge call ECONNREFUSEDs. Point rag-eval straight at the
    # compose service (OpenAI-compat /v1 path), same target as OLLAMA_URL above.
    upsert_env RAGAS_OLLAMA_URL    http://ollama:11434/v1
    upsert_env LLM_MODEL           gpt-oss:20b
  fi
  upsert_env OPENSSL_CONF        ""
  upsert_env DROPLET_FIPS_REQUIRED false
  upsert_env DROPLET_TPM_BACKEND mock
  # WARP-1980: an EXTERNAL edge router must survive a setup re-run.
  #
  # `single-box` is a statement about the INFERENCE topology, not about routing:
  # detect_single_box_mode() decides it from the DRM render-node count and an
  # Ollama probe, and never looks at the router. These three knobs conflated it
  # with "this box IS the router" and pointed the routing service at the BUNDLED
  # droplet-openwrt container.
  #
  # A single-box appliance behind a real edge router is the shipping customer
  # shape (RB5009 + managed switch + AP), and on that box the clobber is silent
  # and total: the bundled container answers, so nothing errors — the Network
  # tab simply describes a router nobody is on. Recovering it means re-writing
  # both .env files AND re-enrolling the droplet-ai credential by hand.
  #
  # Preserve an operator-configured external host, exactly as the LLM_MODEL
  # guard above preserves a flipped runtime. Loopback (or unset — a fresh
  # provision) means the bundled container, the right default for a flat
  # single-box. This preserves intent; it does not auto-detect a router.
  local _current_openwrt_host
  _current_openwrt_host="$(grep -E '^OPENWRT_HOST=' "$env_target" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  case "$_current_openwrt_host" in
    ''|127.0.0.1|localhost|::1)
      upsert_env OPENWRT_HOST        127.0.0.1
      upsert_env OPENWRT_PORT        8181
      upsert_env OPENWRT_USERNAME    root
      ;;
    *)
      log_info "single-box env: external edge router configured (OPENWRT_HOST=$_current_openwrt_host) — preserving OPENWRT_HOST/PORT/USERNAME instead of re-pointing at the bundled container"
      ;;
  esac
  upsert_env ROUTING_MODE        real
  # Warning-free droplet.local: on the single-box shape this box IS the
  # router — its dnsmasq answers the split-horizon FQDN for every DHCP
  # client, so the gateway may 307 droplet.local → the trusted FQDN. On any
  # other shape the FQDN is client-unresolvable and the knob stays 0 (compose
  # default), keeping today's behavior. EXPLICIT, never derived.
  upsert_env DROPLET_LAN_DNS_AUTHORITY 1
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
  # is unreachable here and every /api/network, /api/vpn call dies
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
  # WARP-1981: a framebuffer rack panel must survive a factory reset.
  #
  # display.py keeps "fb" EXPLICIT-ONLY on purpose: the 5 s promotion loop
  # re-probes USB every tick, so an auto-selected fb backend would silently
  # lose the panel to a PyPortal plugged in later. That intent is right at
  # RUNTIME — but nothing ever made the value explicit at PROVISION time. No
  # script writes DISPLAY_BACKEND (`git grep DISPLAY_BACKEND -- scripts/` was
  # empty), .env.example ships `auto`, and factory-reset.sh deletes .env.
  #
  # So a rack-panel box came back from a wipe on the `sim` backend, which
  # renders to a PNG inside the container. The setup wizard's claim code lives
  # on that panel and ClaimStep is NOT skippable — the install stops dead at
  # step two with a working box nobody can claim.
  #
  # Detect the panel and write the explicit value setup should always have
  # left behind. Gated on a framebuffer existing AND no PyPortal on USB, so a
  # real PyPortal box still auto-probes exactly as before.
  # Test/dev hooks (so the detection is unit-testable without a real panel):
  #   DROPLET_FB_DEV   override the framebuffer device probed  (default /dev/fb0)
  #   DROPLET_FB_SIZE  override the virtual_size sysfs file
  #   DROPLET_USB_TTY  override the PyPortal USB glob prefix
  local _fb_dev _fb_sizefile _usb_glob
  _fb_dev="${DROPLET_FB_DEV:-/dev/fb0}"
  _fb_sizefile="${DROPLET_FB_SIZE:-/sys/class/graphics/fb0/virtual_size}"
  _usb_glob="${DROPLET_USB_TTY:-/dev/tty}"
  local _current_display_backend
  _current_display_backend="$( { grep -E '^DISPLAY_BACKEND=' "$env_target" 2>/dev/null || true; } | tail -1 | cut -d= -f2-)"
  # Probe each glob separately. `ls a* b*` exits non-zero when EITHER pattern
  # is unmatched, so a single `! ls` reports "no PyPortal" on a box that has
  # /dev/ttyACM1 but no /dev/ttyUSB* — failing OPEN into fb and stealing the
  # panel from a real USB display. Unmatched globs stay literal and
  # `[ -e <literal> ]` is false, so this needs no nullglob.
  local _usb_present=0 _tty
  for _tty in "${_usb_glob}"ACM* "${_usb_glob}"USB*; do
    if [ -e "$_tty" ]; then _usb_present=1; break; fi
  done
  if [ -n "$_current_display_backend" ] && [ "$_current_display_backend" != "auto" ]; then
    log_info "single-box env: DISPLAY_BACKEND=$_current_display_backend already set — leaving the operator's choice alone"
  elif [ -e "$_fb_dev" ] && [ "$_usb_present" = 0 ]; then
    upsert_env DISPLAY_BACKEND fb
    upsert_env FB_DEVICE       "$_fb_dev"
    # virtual_size is "<width>,<height>" (e.g. `1424,280`). Never trust it
    # blind: a bad parse here writes a garbage geometry that the panel then
    # renders at, which reads as "the screen is broken" rather than as a
    # config error.
    local _fb_size _fb_w _fb_h
    _fb_size="$(cat "$_fb_sizefile" 2>/dev/null || true)"
    _fb_w="${_fb_size%%,*}"
    _fb_h="${_fb_size##*,}"
    case "${_fb_w}|${_fb_h}" in
      *[!0-9]*\|*|*\|*[!0-9]*|\|*|*\|)
        log_warn "single-box env: /dev/fb0 present but virtual_size was unreadable ('${_fb_size}') — DISPLAY_BACKEND=fb written WITHOUT dimensions. Set LCD_WIDTH/LCD_HEIGHT by hand or the claim screen may render at the wrong geometry." ;;
      *)
        upsert_env LCD_WIDTH  "$_fb_w"
        upsert_env LCD_HEIGHT "$_fb_h"
        log_info "single-box env: framebuffer rack panel detected — DISPLAY_BACKEND=fb, ${_fb_w}x${_fb_h} (from /sys/class/graphics/fb0/virtual_size)" ;;
    esac
  fi
  # WARP-850: matter-controller is the 4th host-net service on the ladder
  # (:8083) — same WARP-806 reasoning as the three above.
  upsert_env DROPLET_MATTER_SERVICE_URL "http://${bridge_gw}:8083"
  # WARP-895: hand the Droplet AP's SSID (and an operator-set PSK, if any)
  # to the Matter controller so BLE-first Matter devices can join the LAN.
  # SSID matches the AP written above (~line 201).
  local _matter_ap_ssid
  _matter_ap_ssid="$( { grep -E '^DROPLET_AP_SSID=' "${REPO_ROOT:-/nonexistent}/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2-)"
  upsert_env DROPLET_MATTER_WIFI_SSID "${_matter_ap_ssid:-Droplet}"
  local _matter_ap_psk
  _matter_ap_psk="$( { grep -E '^DROPLET_AP_PSK=' "${REPO_ROOT:-/nonexistent}/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2-)"
  if [ -n "$_matter_ap_psk" ] && [ "$_matter_ap_psk" != "CHANGE_ME_VIA_SETUP_WIZARD" ]; then
    upsert_env DROPLET_MATTER_WIFI_PSK "$_matter_ap_psk"
  fi
  # WARP-1035 (closes the WARP-895 follow-up): point the sidecar at the
  # per-box AP PSK droplet-openwrt-attach generates + persists on first
  # boot (WARP-819). The compose /etc/droplet DIRECTORY bind mount (ro)
  # makes the path readable in-container; the sidecar resolves file-first
  # per commission, so this stays correct even when attach lands the PSK
  # after the stack is already up. The operator DROPLET_MATTER_WIFI_PSK
  # env above remains the fallback when the file is absent — and attach
  # persists an operator override INTO this file anyway, so file and env
  # can't diverge on a healthy box.
  upsert_env DROPLET_MATTER_WIFI_PSK_FILE /etc/droplet/ap-psk
  # WARP-1363: same file-first pattern for the SSID. The env SSID above is
  # written once at setup and goes stale on an AP rename (claim / wizard
  # Wi-Fi save) — droplet-openwrt-attach persists the LIVE SSID to
  # /etc/droplet/ap-ssid on every attach, and the sidecar re-reads it per
  # commission, so a renamed AP can never strand Matter commissioning.
  upsert_env DROPLET_MATTER_WIFI_SSID_FILE /etc/droplet/ap-ssid
  # Device-bridge (host process, binds 0.0.0.0:9090) — same WARP-806 reasoning
  # as the three host services above: the orchestrator's config default is
  # http://host.docker.internal:9090 (docker0), exactly the default WARP-806
  # documented as unreliable on this box. Pin it to the droplet_default gateway
  # so the single-box Wi-Fi write (WARP-808), storage ops, and the QR/creds
  # reads never depend on docker0 being up.
  upsert_env DEVICE_BRIDGE_URL   "http://${bridge_gw}:9090"

  log_success "Wrote single-box knobs to .env (idempotent upsert — COMPOSE_PROFILES=${merged_profiles}, DOCS_ENABLED=${docs_enabled_val} (RAM-gated, ${mem_gb} GiB vs ${docs_min_gib} GiB), CAMERA_SUBNET=auto (edge-router derived, WARP-1805), WIREGUARD_LAN_CIDR=192.168.20.0/24, WIREGUARD_DNS=192.168.20.1, OLLAMA_URL + RAGAS_OLLAMA_URL (judge → in-network ollama), FIPS off, TPM=mock, OpenWrt 127.0.0.1:8181, LLM_MODEL=gpt-oss:20b, DROPLET_AP_MODE=hostapd, SWITCH_AUTOPROVISION=1 flat-lan, ROUTING/SWITCH/DISPLAY/DEVICE_BRIDGE URLs → ${bridge_net} gateway ${bridge_gw})"
}
