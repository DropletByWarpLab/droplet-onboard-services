#!/bin/bash
# Install the Droplet USB auto-mount service on the appliance host.
#
# Idempotent: re-running won't duplicate anything. Safe to re-run after
# editing any of the service files.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

install -m 755 "$DIR/droplet-automount.sh" /usr/local/bin/droplet-automount.sh
install -m 644 "$DIR/droplet-automount@.service" /etc/systemd/system/
install -m 644 "$DIR/droplet-automount-reconcile.service" /etc/systemd/system/
install -m 644 "$DIR/99-droplet-automount.rules" /etc/udev/rules.d/

# WARP-1338 — Nextcloud-registration opt-in for the automount + storage-pool
# root units (loaded via EnvironmentFile=). Provisioning opts IN; the
# in-script default stays 0 (the deliberate opt-out posture), so an operator
# can flip this file to 0 and re-provisioning preserves that choice — only
# ownership/mode are re-asserted.
#
# ROOT-UNIT LPE INVARIANT (WARP-843): this file feeds ROOT units
# (droplet-automount@.service, droplet-automount-reconcile.service,
# droplet-storage-pool-apply.service), and a systemd EnvironmentFile loads
# EVERY KEY=VALUE line into the unit's environment — so it must be owned
# root:root and NEVER writable by the droplet user (a droplet-writable
# EnvironmentFile on a root unit is an arbitrary-env-injection privilege
# escalation; guard: tests/openwrt-attach-env-invariant.test.sh +
# services/oled-display/tests/test_automount_env_wiring.py).
# >>> automount_env_install
_install_automount_env() {
  local env_file="${DROPLET_AUTOMOUNT_ENV_FILE:-/etc/droplet/automount.env}"
  mkdir -p "$(dirname "$env_file")"
  if [ ! -f "$env_file" ]; then
    cat > "$env_file" <<'ENV_EOF'
# Droplet automount -> Nextcloud external-storage registration (WARP-1338).
# Loaded by ROOT units via EnvironmentFile= — keep this file root:root 0644,
# never droplet-writable (WARP-843 root-unit LPE invariant).
# Set NEXTCLOUD_AUTO_REGISTER=0 to opt out of auto-registering HOT-PLUGGED
# drives (the udev automount + boot-reconcile paths). Owner-confirmed
# dashboard storage ops (pool format / drive adopt / drive reclaim) always
# register — they ARE the deliberate "add mounts via the dashboard" path
# this opt-out steers tighter deployments toward.
NEXTCLOUD_AUTO_REGISTER=1
NEXTCLOUD_CONTAINER=droplet-nextcloud-1
ENV_EOF
  fi
  chown root:root "$env_file"
  chmod 0644 "$env_file"
}
_install_automount_env
# <<< automount_env_install

STATE_DIR="${DROPLET_AUTOMOUNT_STATE_DIR:-/var/lib/droplet-automount}"
mkdir -p /mnt/droplet "$STATE_DIR" /var/log
chmod 755 /mnt/droplet

# WARP-232 (finding 10): fleet upgrade regression. Before WARP-232 every plain
# (unencrypted) USB drive mounted read-WRITE unconditionally. After WARP-232 a
# plain drive is read-only-untrusted unless its UUID is on the trust list — so a
# previously-adopted customer drive (e.g. Nextcloud external storage) silently
# flips READ-ONLY on the next replug/reboot. Seed the trust list from any
# already-mounted plain drives recorded in the existing state, ONCE, so upgrades
# preserve the rw drives the operator already accepted. Enrolled LUKS drives are
# excluded (they don't use the trust list); only plain drives that mounted rw
# under the old default ("trusted" or a legacy entry with no trust field) are
# seeded. Idempotent: grep-guarded appends, marker file prevents re-seeding.
_seed_trusted_list_from_state() {
  local state_file="$STATE_DIR/mounts.json"
  local trusted_list="$STATE_DIR/trusted.list"
  local marker="$STATE_DIR/.trusted-seeded"
  [ -f "$state_file" ] || return 0
  [ -f "$marker" ] && return 0
  command -v python3 >/dev/null 2>&1 || return 0
  # Legacy state entries have no "trust" key (all mounted rw); post-232 rw
  # drives are "trusted". Both should stay rw across the upgrade. Enrolled LUKS
  # (trust list N/A) and untrusted-ro (never accepted) are excluded by the
  # extractor below. NOTE: command substitution `$(...)`, not `< <(...)` — the
  # heredoc-in-process-substitution form mis-parses under bash 3.2 (dev/CI Macs)
  # when the embedded python has comments with parens; `$(...)` is portable.
  local seeded=0 uuids uuid
  uuids="$(python3 - "$state_file" <<'PY'
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    s = {"mounts": []}
for m in s.get("mounts", []):
    trust = m.get("trust", "trusted")
    uuid = m.get("uuid")
    if uuid and trust in ("trusted",):
        print(uuid)
PY
)"
  while IFS= read -r uuid; do
    [ -z "$uuid" ] && continue
    if ! grep -qxF "$uuid" "$trusted_list" 2>/dev/null; then
      printf '%s\n' "$uuid" >> "$trusted_list"
      seeded=$((seeded + 1))
    fi
  done <<EOF
$uuids
EOF
  touch "$marker" 2>/dev/null || true
  [ "$seeded" -gt 0 ] && echo "droplet-automount: seeded $seeded previously-trusted plain drive(s) into trusted.list (fleet upgrade)."
  return 0
}
_seed_trusted_list_from_state

# Make /mnt/droplet a shared mount so new automounts under it propagate
# into containers that bind-mount /mnt/droplet with rshared. Without
# this, Nextcloud (which bind-mounts /mnt/droplet -> /host) only sees
# drives that were present at container start.
if ! findmnt /mnt/droplet >/dev/null 2>&1; then
  mount --bind /mnt/droplet /mnt/droplet
fi
mount --make-rshared /mnt/droplet

# Persist the bind+shared across reboots via a small systemd mount unit.
cat > /etc/systemd/system/mnt-droplet.mount <<'MOUNT_EOF'
[Unit]
Description=Droplet shared automount namespace
Before=local-fs.target
[Mount]
What=/mnt/droplet
Where=/mnt/droplet
Type=none
Options=bind,rshared
[Install]
WantedBy=local-fs.target
MOUNT_EOF
systemctl daemon-reload
systemctl enable mnt-droplet.mount >/dev/null 2>&1 || true

# WARP-1338 — boot-time registration reconcile. Enabled for every boot, and
# started once now (non-blocking, non-fatal) so a fleet-upgraded box whose
# mounts predate registration converges without waiting for a reboot. This
# registers ONLY already-mounted trusted/pool paths — it mounts nothing, so
# it is NOT the install-time drive sweep deliberately avoided below.
systemctl enable droplet-automount-reconcile.service >/dev/null 2>&1 || true
systemctl start --no-block droplet-automount-reconcile.service >/dev/null 2>&1 || true

udevadm control --reload-rules
# Don't trigger a sweep here — we intentionally want the first mount of
# any existing USB/NVMe drive to happen via udev on the next hot-plug (or
# reboot). Sweeping at install time would silently adopt every drive
# currently attached, which is a physical-access foot-gun for appliances
# that might have a stray drive plugged in during provisioning.

echo "droplet-automount installed. Plug a drive in to auto-mount."
