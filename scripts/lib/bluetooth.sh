#!/usr/bin/env bash
# bluetooth.sh — Host Bluetooth prep for the matter-controller sidecar (WARP-850).
# Source this file; do not execute directly.
#
# The matter-controller service (services/matter-controller) commissions
# Matter devices over BLE through @matter/nodejs-ble, whose central role
# rides @stoprocent/noble. noble opens its OWN raw-channel AF_BLUETOOTH
# HCI socket (HCI_CHANNEL_RAW) — it does NOT talk to bluetoothd over
# D-Bus and it does NOT need the HCI user channel.
#
# bluetoothd-coexistence decision (encoded here, owned by setup.sh):
#   KEEP bluetoothd ENABLED AND RUNNING.
#   - noble's documented Linux prerequisites (stoprocent/noble README:
#     "Prerequisites → Linux", "Running without root/sudo") are: bluez
#     installed, the adapter present + powered, and cap_net_raw on the
#     process. There is NO "stop the daemon" requirement for the
#     central/scanner role — raw-channel sockets coexist with bluetoothd.
#   - The "adapter must be free" exclusivity constraint applies to HCI
#     *user-channel* consumers and to bleno's peripheral/advertising
#     role. The Droplet is a COMMISSIONER (central only); we never
#     advertise, so that constraint doesn't apply.
#   - bluetoothd is what power-manages the adapter across reboots and
#     rfkill events; without it hci0 comes up unpowered and noble sits
#     in `poweredOff` forever. The verified-good live state on the
#     single-box (bluetooth.service active, `btmgmt info` showing
#     `powered le` in current settings) is exactly what this function
#     converges on.
#   - The sidecar container gets its socket capability from compose
#     (`cap_add: [NET_ADMIN, NET_RAW]` + `network_mode: host`), so no
#     host-side setcap on the node binary is needed.
#
# Idempotent — every step checks-or-converges and re-running is a no-op.
# Non-fatal — a box without Bluetooth still ships every IP-only feature;
# the sidecar degrades gracefully (capabilities reflect reality).

setup_bluetooth_host() {
  log_info "Preparing host Bluetooth for Matter BLE commissioning (WARP-850)..."

  if [ "$(uname)" != "Linux" ]; then
    log_info "  Non-Linux host — skipping (BLE commissioning is Linux-only)"
    log_divider
    return 0
  fi

  # --- Packages: bluez (bluetoothd + btmgmt + bluetoothctl), rfkill ---
  local missing=()
  command -v bluetoothctl >/dev/null 2>&1 || missing+=("bluez")
  command -v rfkill >/dev/null 2>&1 || missing+=("rfkill")
  if [ ${#missing[@]} -gt 0 ]; then
    log_info "  Installing: ${missing[*]}"
    sudo apt-get update -qq 2>/dev/null || true
    if ! sudo apt-get install -y --no-install-recommends "${missing[@]}" 2>/dev/null; then
      log_warn "  Could not install ${missing[*]} — BLE commissioning will be unavailable (IP-only)"
      log_divider
      return 0
    fi
  else
    log_success "  bluez + rfkill already installed"
  fi

  # --- bluetoothd: enabled + running (see coexistence decision above) ---
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet bluetooth 2>/dev/null; then
      log_success "  bluetooth.service already active"
    else
      sudo systemctl enable --now bluetooth 2>/dev/null \
        && log_success "  bluetooth.service enabled + started" \
        || log_warn "  Could not start bluetooth.service — BLE commissioning will be unavailable"
    fi
  fi

  # --- rfkill: make sure the radio isn't soft-blocked ---
  if command -v rfkill >/dev/null 2>&1; then
    sudo rfkill unblock bluetooth 2>/dev/null || true
    log_success "  rfkill: bluetooth unblocked"
  fi

  # --- Power the adapter on (idempotent; bluetoothd keeps it powered) ---
  # `bluetoothctl power on` exits 0 when already powered. A box without
  # any adapter fails here harmlessly — the sidecar's /sys probe
  # (services/matter-controller/src/ble.ts) reports IP-only.
  if command -v bluetoothctl >/dev/null 2>&1; then
    if bluetoothctl power on >/dev/null 2>&1; then
      log_success "  Bluetooth adapter powered on"
    else
      log_warn "  No powered Bluetooth adapter found — matter-controller will run IP-only"
    fi
  fi

  log_divider
}
