#!/bin/bash
# Install the Droplet USB auto-mount service on the Jetson host.
#
# Idempotent: re-running won't duplicate anything. Safe to re-run after
# editing any of the service files.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

install -m 755 "$DIR/droplet-automount.sh" /usr/local/bin/droplet-automount.sh
install -m 644 "$DIR/droplet-automount@.service" /etc/systemd/system/
install -m 644 "$DIR/99-droplet-automount.rules" /etc/udev/rules.d/

mkdir -p /mnt/droplet /var/lib/droplet-automount /var/log
chmod 755 /mnt/droplet

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
