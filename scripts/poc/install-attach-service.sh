#!/usr/bin/env bash
# Install the droplet-openwrt-attach systemd unit + script + env file
# on a POC box. Idempotent — re-run after pulling a new commit to
# pick up changes to the attach script.
#
# Why this lives in scripts/poc/ instead of scripts/lib/:
#   The POC box runs the in-container OpenWrt + Ollama stack via
#   docker-compose.override.yml. Production Droplet hardware uses a
#   separate physical OpenWrt — these scripts (and the override) are
#   no-ops on prod boxes. Keeping POC-only artifacts under scripts/poc/
#   makes the boundary explicit and stops setup.sh from running them
#   on hosts that don't need them.
#
# Pre-reqs:
#   - droplet-openwrt container exists in compose (override active)
#   - OPENWRT_PASSWORD is set in .env and `setup.sh --sync-secrets`
#     has written docker/secrets/openwrt_password.
#
# Usage:
#   sudo bash scripts/poc/install-attach-service.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Require root (we install into /usr/local/sbin + /etc/systemd/system).
if [ "$(id -u)" -ne 0 ]; then
  echo "install-attach-service.sh must run as root (use sudo)" >&2
  exit 1
fi

install -m 0755 "$SCRIPT_DIR/droplet-openwrt-attach.sh"      /usr/local/sbin/droplet-openwrt-attach
install -m 0644 "$SCRIPT_DIR/droplet-openwrt-attach.defaults" /etc/default/droplet-openwrt-attach
install -m 0644 "$SCRIPT_DIR/droplet-openwrt-attach.service"  /etc/systemd/system/droplet-openwrt-attach.service

systemctl daemon-reload
systemctl enable --now droplet-openwrt-attach.service

echo "droplet-openwrt-attach: installed + enabled"
systemctl --no-pager status droplet-openwrt-attach.service | head -6 || true
