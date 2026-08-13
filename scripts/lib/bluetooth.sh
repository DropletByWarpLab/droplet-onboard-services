#!/usr/bin/env bash
# bluetooth.sh — Host Bluetooth prep for the matter-controller sidecar
# (WARP-850, reversed by WARP-1939). Source this file; do not execute
# directly.
#
# The matter-controller service (services/matter-controller) commissions
# Matter devices over BLE through @matter/nodejs-ble, whose central role
# rides @stoprocent/noble. noble opens its OWN raw-channel AF_BLUETOOTH
# HCI socket (HCI_CHANNEL_RAW) — it does NOT talk to bluetoothd over
# D-Bus.
#
# bluetoothd-coexistence decision — REVERSED 2026-08-12 (WARP-1939):
#   DISABLE bluetoothd. Its single useful responsibility (powering the
#   adapter at boot) moves to droplet-bt-power.service, installed below.
#
#   WARP-850 originally kept bluetoothd enabled on the theory that
#   raw-channel central-role sockets coexist with it. On the current
#   image (Ubuntu 24.04, kernel 6.x, BlueZ 5.7x — post-2026-08-04
#   reflash) that theory is FALSIFIED on real hardware:
#   - With bluetooth.service active, EVERY noble LE connect failed:
#     "Unknown Connection Identifier (0x2)" within ~2s or a 2-minute
#     connect timeout, with kernel-side "hcon … sent 0 < count 1" and
#     "ACL packet for unknown connection handle" at the exact attempt
#     timestamps. Scanning kept working — the failure is confined to
#     connection state, which bluetoothd/the kernel mgmt layer also
#     manages (LL privacy / resolving-list state noble's raw connects
#     don't participate in).
#   - Host BlueZ itself could connect to the same device fine, proving
#     radio + firmware healthy and isolating the conflict to the two
#     stacks sharing connection state.
#   - With bluetoothd stopped (and the adapter re-powered), the same
#     commission succeeded end-to-end.
#   Full evidence: WARP-1939.
#
#   The half of WARP-850's rationale that WAS right: without
#   bluetoothd, nothing powers the adapter — hci0 comes up unpowered
#   after every boot and noble scans silently blind ("No commissionable
#   device was discovered", no error anywhere). droplet-bt-power.service
#   below owns exactly that one job now, and the sidecar's /capabilities
#   probe (services/matter-controller/src/ble.ts, defaultAdapterPowered)
#   reports honestly when it didn't run.
#
#   The sidecar container gets its socket capability from compose
#   (`cap_add: [NET_ADMIN, NET_RAW]` + `network_mode: host`), so no
#   host-side setcap on the node binary is needed.
#
# Idempotent — every step checks-or-converges and re-running is a no-op.
# Non-fatal — a box without Bluetooth still ships every IP-only feature;
# the sidecar degrades gracefully (capabilities reflect reality).

setup_bluetooth_host() {
  log_info "Preparing host Bluetooth for Matter BLE commissioning (WARP-850/WARP-1939)..."

  if [ "$(uname)" != "Linux" ]; then
    log_info "  Non-Linux host — skipping (BLE commissioning is Linux-only)"
    log_divider
    return 0
  fi

  # --- Packages: bluez (btmgmt + bluetoothctl), rfkill ---
  # bluez stays installed even though its daemon is disabled: btmgmt is
  # what droplet-bt-power.service and operators use to drive the
  # adapter, and it ships in the bluez package.
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

  # --- bluetoothd: DISABLED (see decision header, WARP-1939) ---
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files bluetooth.service >/dev/null 2>&1; then
      if systemctl is-enabled --quiet bluetooth 2>/dev/null \
        || systemctl is-active --quiet bluetooth 2>/dev/null; then
        sudo systemctl disable --now bluetooth 2>/dev/null \
          && log_success "  bluetooth.service disabled + stopped (WARP-1939: conflicts with the sidecar's raw-HCI connects)" \
          || log_warn "  Could not disable bluetooth.service — BLE commissioning may be unreliable (WARP-1939)"
      else
        log_success "  bluetooth.service already disabled"
      fi
    fi
  fi

  # --- droplet-bt-power.service: the adapter-power job bluetoothd used
  # to do. Oneshot at boot; retries because the adapter can enumerate
  # late (mt7921 firmware load takes ~20s on the shipping box). ---
  local unit=droplet-bt-power.service
  sudo tee "/etc/systemd/system/$unit" > /dev/null <<'UNIT'
[Unit]
Description=Droplet: power on the Bluetooth adapter for Matter BLE commissioning (WARP-1939)
# bluetoothd is disabled on Droplet hosts: its LE connection management
# conflicts with the matter-controller sidecar's raw-HCI stack (noble)
# — every BLE connect fails with "Unknown Connection Identifier". This
# oneshot replaces the daemon's single load-bearing job: powering the
# adapter at boot. The retry loop absorbs late adapter enumeration
# (mt7921 firmware load ~20s).
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=120
# hciconfig, NOT btmgmt: `btmgmt power on` HANGS when stdin is not a TTY
# (verified on the box — rc=124 under `timeout 6 … </dev/null`, instant
# interactively), and a systemd unit is exactly the no-TTY case; the
# first install of this unit timed out at TimeoutStartSec and failed on
# precisely that. `$$` because systemd expands `$` in ExecStart before
# the shell ever runs.
ExecStart=/bin/sh -c 'rfkill unblock bluetooth 2>/dev/null || true; i=0; while [ $$i -lt 20 ]; do if hciconfig hci0 up >/dev/null 2>&1; then exit 0; fi; i=$$((i+1)); sleep 3; done; echo "no Bluetooth adapter came up — matter-controller runs IP-only" >&2; exit 0'

[Install]
WantedBy=multi-user.target
UNIT
  sudo chmod 0644 "/etc/systemd/system/$unit"
  sudo systemctl daemon-reload
  sudo systemctl enable "$unit" >/dev/null 2>&1 || true
  log_success "  $unit installed + enabled (powers the adapter at boot)"

  # --- rfkill + power NOW (idempotent; the unit covers future boots) ---
  if command -v rfkill >/dev/null 2>&1; then
    sudo rfkill unblock bluetooth 2>/dev/null || true
    log_success "  rfkill: bluetooth unblocked"
  fi
  # hciconfig, NOT bluetoothctl (needs the now-disabled daemon) and NOT
  # btmgmt (`btmgmt power on` hangs when stdin is not a TTY — and this
  # script runs under automation as often as under a human).
  if sudo hciconfig hci0 up >/dev/null 2>&1; then
    log_success "  Bluetooth adapter powered on"
  else
    log_warn "  No powered Bluetooth adapter found — matter-controller will run IP-only"
  fi

  log_divider
}
