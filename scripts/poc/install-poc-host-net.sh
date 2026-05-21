#!/usr/bin/env bash
# Install the droplet-poc-host-net systemd unit + script + dnsmasq
# config on a POC box. Idempotent — re-run after pulling a new commit
# to pick up changes.
#
# Why this lives in scripts/poc/ instead of scripts/lib/:
#   This is POC-only plumbing for the single-box rebuild. Production
#   Droplet appliances use a separate physical OpenWrt that owns LAN
#   DHCP — these scripts are no-ops there. Keeping them under
#   scripts/poc/ makes the boundary explicit and keeps setup.sh from
#   running them on hosts that don't need them.
#
# Pre-reqs:
#   - br-lan bridge exists on the host (it does on the POC box — the
#     openwrt-attach scripts and the standard netplan both set it up).
#   - dnsmasq + dnsmasq-base packages installed (`apt-get install
#     dnsmasq-base dnsmasq`). The default dnsmasq.service can be left
#     alone (we don't touch it); ours runs as a separate instance.
#
# Usage:
#   sudo bash scripts/poc/install-poc-host-net.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-poc-host-net.sh must run as root (use sudo)" >&2
  exit 1
fi

# Refuse to clobber a running system dnsmasq.service that's actually
# serving DHCP somewhere we don't know about. Failed/disabled is fine.
sys_dnsmasq_state="$(systemctl is-active dnsmasq.service 2>/dev/null || true)"
if [ "$sys_dnsmasq_state" = "active" ]; then
  echo "system dnsmasq.service is active — refusing to install a second" >&2
  echo "instance that may bind the same interface. Disable it first:" >&2
  echo "    systemctl disable --now dnsmasq.service" >&2
  exit 1
fi

install -d -m 0755 /etc/droplet-poc-host-net
install -m 0644 "$SCRIPT_DIR/droplet-poc-lan-dhcp.conf"  /etc/droplet-poc-host-net/lan-dhcp.conf
install -m 0755 "$SCRIPT_DIR/droplet-poc-host-net.sh"     /usr/local/sbin/droplet-poc-host-net
install -m 0644 "$SCRIPT_DIR/droplet-poc-host-net.defaults" /etc/default/droplet-poc-host-net
install -m 0644 "$SCRIPT_DIR/droplet-poc-host-net.service"  /etc/systemd/system/droplet-poc-host-net.service

systemctl daemon-reload
systemctl enable --now droplet-poc-host-net.service

echo "droplet-poc-host-net: installed + enabled"
systemctl --no-pager status droplet-poc-host-net.service | head -10 || true
