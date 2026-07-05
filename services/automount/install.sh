#!/bin/bash
# Install the Droplet USB auto-mount service on the appliance host.
#
# Idempotent: re-running won't duplicate anything. Safe to re-run after
# editing any of the service files.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

install -m 755 "$DIR/droplet-automount.sh" /usr/local/bin/droplet-automount.sh
install -m 644 "$DIR/droplet-automount@.service" /etc/systemd/system/
install -m 644 "$DIR/99-droplet-automount.rules" /etc/udev/rules.d/

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

udevadm control --reload-rules
# Don't trigger a sweep here — we intentionally want the first mount of
# any existing USB/NVMe drive to happen via udev on the next hot-plug (or
# reboot). Sweeping at install time would silently adopt every drive
# currently attached, which is a physical-access foot-gun for appliances
# that might have a stray drive plugged in during provisioning.

echo "droplet-automount installed. Plug a drive in to auto-mount."
