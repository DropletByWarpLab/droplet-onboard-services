#!/bin/bash
# droplet-automount.sh — auto-mount USB drives on the inference host and register them
# with Nextcloud + the device-bridge. Invoked by a systemd template unit
# triggered from a udev rule on add/remove.
#
# Called as:
#   droplet-automount.sh add    /dev/sda1
#   droplet-automount.sh remove /dev/sda1
#
# Mount point convention: /mnt/droplet/<label>-<short-uuid> (human-friendly
# but unambiguous). State file at /var/lib/droplet-automount/mounts.json
# tracks what we've mounted so we clean up on remove.

set -euo pipefail

ACTION="${1:-}"
DEVICE="${2:-}"

# Base paths are env-overridable ONLY for the hermetic tests
# (services/oled-display/tests/test_automount_script.py) — udev/systemd
# invoke the real unit with a clean environment, so production always uses
# the defaults.
MOUNT_BASE="${DROPLET_AUTOMOUNT_BASE:-/mnt/droplet}"
STATE_DIR="${DROPLET_AUTOMOUNT_STATE_DIR:-/var/lib/droplet-automount}"
STATE_FILE="${STATE_DIR}/mounts.json"
LOG_FILE="${DROPLET_AUTOMOUNT_LOG:-/var/log/droplet-automount.log}"

NEXTCLOUD_CONTAINER="${NEXTCLOUD_CONTAINER:-docker-nextcloud-1}"
NEXTCLOUD_USER="${NEXTCLOUD_USER:-admin}"
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:9090}"
# The device-bridge requires its shared token on /drives/changed (it gates the
# mutating routes). Read it from the same env file the bridge itself reads
# (/etc/droplet/device-bridge.env, key BRIDGE_AUTH_TOKEN), unless already
# provided in the environment. We grep the single line rather than sourcing the
# file so an unrelated assignment can't run as root here.
BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-/etc/droplet/device-bridge.env}"
if [ -z "${BRIDGE_AUTH_TOKEN:-}" ] && [ -r "$BRIDGE_ENV_FILE" ]; then
  BRIDGE_AUTH_TOKEN="$(grep -E '^BRIDGE_AUTH_TOKEN=' "$BRIDGE_ENV_FILE" 2>/dev/null \
    | head -1 | cut -d= -f2- || true)"
fi
BRIDGE_AUTH_TOKEN="${BRIDGE_AUTH_TOKEN:-}"
# Auto-registering every plugged-in USB drive as Nextcloud external storage
# is convenient but also a supply-chain vector: anyone with physical access
# to the appliance can drop a drive and get it exposed to Nextcloud admin.
# Opt in explicitly via NEXTCLOUD_AUTO_REGISTER=1 in /etc/droplet/automount.env
# so deployments that want tighter control can add mounts via the dashboard
# instead.
NEXTCLOUD_AUTO_REGISTER="${NEXTCLOUD_AUTO_REGISTER:-0}"

mkdir -p "$MOUNT_BASE" "$STATE_DIR"
chmod 755 "$MOUNT_BASE"

log() { printf "%s [%s] %s\n" "$(date -Iseconds)" "$ACTION" "$*" >> "$LOG_FILE"; }

if [ -z "$ACTION" ] || [ -z "$DEVICE" ]; then
  log "usage: $0 add|remove /dev/sdX1"
  exit 1
fi

# Never touch the boot medium. The inference host boots from eMMC
# (/dev/mmcblk*) so that's an absolute skip. NVMe is user-modular
# storage — DO include it, but re-check at runtime that it doesn't
# hold the root fs.
case "$DEVICE" in
  /dev/mmcblk*|/dev/loop*|/dev/ram*|/dev/zram*|/dev/dm-*)
    log "skip $DEVICE (boot / virtual device)"; exit 0 ;;
esac

# Paranoia guard — re-check even though udev should have filtered these.
# If anything goes sideways with the rule, this keeps the boot fs safe.
boot_src="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
boot_parent="$(lsblk -no PKNAME "$boot_src" 2>/dev/null || true)"
dev_base="$(basename "$DEVICE")"
dev_parent="$(lsblk -no PKNAME "$DEVICE" 2>/dev/null || true)"
if [ "$DEVICE" = "$boot_src" ] || [ "$dev_base" = "$boot_parent" ] \
   || [ "$dev_parent" = "$boot_parent" ]; then
  log "skip $DEVICE (holds rootfs / sibling of boot device)"
  exit 0
fi

# Reject the status display's firmware flash regardless of how it shows
# up — it's a display, not storage.
if [ -n "${ID_VENDOR_ID:-}" ] && [ "$ID_VENDOR_ID" = "239a" ]; then
  log "skip $DEVICE (Adafruit vendor — status display)"; exit 0
fi

# Size guard — anything < 100 MiB is almost certainly firmware or an
# ESP, not user storage.
size_bytes="$(lsblk -bno SIZE "$DEVICE" 2>/dev/null | head -1 || echo 0)"
if [ -n "$size_bytes" ] && [ "$size_bytes" -lt 104857600 ] 2>/dev/null; then
  log "skip $DEVICE (size ${size_bytes}B < 100 MiB — not a storage volume)"
  exit 0
fi

notify_bridge() {
  # Non-blocking notify. The bridge caches drive state itself via
  # /drives, but an explicit hint lets it refresh its display
  # immediately instead of waiting for the next poll.
  # /drives/changed is auth-gated: present the shared token. Build the auth
  # header only when a token is available so a misconfigured box still attempts
  # the (now-401) call rather than silently dropping the flag in `set -u`.
  local auth_args=()
  if [ -n "${BRIDGE_AUTH_TOKEN:-}" ]; then
    auth_args=(-H "X-Droplet-Auth: ${BRIDGE_AUTH_TOKEN}")
  fi
  curl -s -X POST -m 3 "${BRIDGE_URL}/drives/changed" \
    -H 'Content-Type: application/json' \
    "${auth_args[@]}" \
    -d "{\"action\":\"$1\",\"device\":\"$2\",\"mount\":\"$3\"}" \
    >/dev/null 2>&1 || true
}

nc_occ() {
  # Nextcloud's `occ` must run as UID 33 (www-data) — that's how the
  # image owns its config files. Using `docker exec -u 33` avoids the
  # "Owner id of config.php: 33" warning + permission denial.
  docker exec -u 33 "$NEXTCLOUD_CONTAINER" php occ "$@"
}

nextcloud_add() {
  local mount="$1"
  local name="$2"
  if ! nc_occ app:enable files_external >/dev/null 2>&1; then
    log "failed to enable files_external; is nextcloud running?"
    return 1
  fi
  if nc_occ files_external:list --output=json 2>/dev/null \
      | grep -q "\"datadir\":\"\\\\?/host/$name\""; then
    log "nextcloud: already registered $name"
    return 0
  fi
  local rc
  rc=$(nc_occ files_external:create \
        "/$name" local null::null -c datadir="/host/$name" 2>&1) || true
  log "nextcloud create: $rc"
  local mid
  mid=$(echo "$rc" | grep -oE '[0-9]+' | head -1)
  if [ -n "$mid" ]; then
    nc_occ files_external:applicable \
      --add-user="$NEXTCLOUD_USER" "$mid" >/dev/null 2>&1 || true
  fi
}

nextcloud_remove() {
  local name="$1"
  local mid
  mid=$(nc_occ files_external:list --output=json 2>/dev/null \
        | grep -oE '{[^}]*"mount_point":"\\/'"$name"'"[^}]*"mount_id":[0-9]+' \
        | grep -oE '"mount_id":[0-9]+' | grep -oE '[0-9]+' | head -1) || true
  if [ -n "$mid" ]; then
    nc_occ files_external:delete -y "$mid" >/dev/null 2>&1 || true
    log "nextcloud removed mount id=$mid name=$name"
  fi
}

state_add() {
  local device="$1" mount="$2" label="$3" uuid="$4"
  python3 - "$STATE_FILE" "$device" "$mount" "$label" "$uuid" <<'PYEOF'
import json, os, sys
path, device, mount, label, uuid = sys.argv[1:6]
try:
    with open(path) as f: state = json.load(f)
except Exception:
    state = {"mounts": []}
state["mounts"] = [m for m in state["mounts"] if m.get("device") != device]
state["mounts"].append({
    "device": device, "mount": mount, "label": label, "uuid": uuid,
})
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f: json.dump(state, f, indent=2)
PYEOF
}

state_remove() {
  local device="$1"
  python3 - "$STATE_FILE" "$device" <<'PYEOF'
import json, sys
path, device = sys.argv[1:3]
try:
    with open(path) as f: state = json.load(f)
except Exception:
    state = {"mounts": []}
removed = [m for m in state["mounts"] if m.get("device") == device]
state["mounts"] = [m for m in state["mounts"] if m.get("device") != device]
with open(path, "w") as f: json.dump(state, f, indent=2)
for m in removed:
    print(m["mount"])
PYEOF
}

case "$ACTION" in
  add)
    # Read filesystem metadata WITHOUT eval. `blkid -o export` returns
    # KEY=VALUE lines that used to be fed to `eval`; a crafted LABEL with
    # embedded newlines + shell metacharacters would execute as root via
    # udev -> systemd. `-o value -s <field>` returns only the raw value
    # for the named field, so there is no shell syntax to evaluate.
    TYPE="$(blkid -o value -s TYPE "$DEVICE" 2>/dev/null || true)"
    LABEL="$(blkid -o value -s LABEL "$DEVICE" 2>/dev/null || true)"
    UUID="$(blkid -o value -s UUID "$DEVICE" 2>/dev/null || true)"
    # Defensive: strip any stray newlines/CR so downstream string handling
    # can't be tricked by multi-line filesystem metadata.
    TYPE="${TYPE//$'\n'/}"; TYPE="${TYPE//$'\r'/}"
    LABEL="${LABEL//$'\n'/}"; LABEL="${LABEL//$'\r'/}"
    UUID="${UUID//$'\n'/}"; UUID="${UUID//$'\r'/}"
    if [ -z "${TYPE:-}" ]; then
      log "$DEVICE has no filesystem signature, skipping"
      exit 0
    fi
    # Signatures that are real but NOT mountable filesystems. The WARP-936
    # udev widening delivers whole-disk add events, so RAID members, LVM PVs,
    # LUKS containers and swap now reach this script — each is owned by its
    # own subsystem (mdadm / LVM / cryptsetup / swapon); attempting `mount`
    # on them fails and leaves a failed droplet-automount@ unit on every
    # boot of a box with a pool. Skip cleanly instead.
    case "$TYPE" in
      linux_raid_member|LVM2_member|crypto_LUKS|swap)
        log "skip $DEVICE (signature $TYPE — managed by its own subsystem, not mountable)"
        exit 0 ;;
    esac
    # Skip labels that are obviously firmware / boot / display volumes
    # even if udev let them through (belt-and-braces).
    case "${LABEL:-}" in
      CIRCUITPY|BOOT|EFI|SYSTEM|RECOVERY|ROOT-A|ROOT-B)
        log "skip $DEVICE (label=$LABEL — system volume)"; exit 0 ;;
    esac
    LABEL="${LABEL:-drive}"
    SHORT_UUID="$(echo "${UUID:-}" | head -c 8)"
    NAME="$(echo "$LABEL" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-\+//;s/-\+$//')"
    [ -z "$NAME" ] && NAME="drive"
    if [ -n "$SHORT_UUID" ]; then
      NAME="${NAME}-${SHORT_UUID}"
    fi
    MOUNT="${MOUNT_BASE}/${NAME}"
    mkdir -p "$MOUNT"

    # If udisks or something else already mounted this device elsewhere
    # (common on desktop-oriented distros), unmount it first so we can
    # reseat it under /mnt/droplet/. That's the path Nextcloud + the
    # display bridge agree on.
    existing=$(findmnt -n -o TARGET --source "$DEVICE" 2>/dev/null | head -1 || true)
    if [ -n "$existing" ] && [ "$existing" != "$MOUNT" ]; then
      log "$DEVICE already mounted at $existing; unmounting to relocate"
      umount "$existing" 2>/dev/null || umount -l "$existing" 2>/dev/null || true
    fi

    # Clear any phantom mount-entry left over from a previous device
    # that had the same mount path but is now gone (e.g. re-enumerated
    # /dev/sdX after re-plug). mountpoint returns true but statvfs
    # reports the underlying rootfs — detect that and force-clean.
    if mountpoint -q "$MOUNT"; then
      phantom_src=$(findmnt -n -o SOURCE "$MOUNT" 2>/dev/null || true)
      if [ -n "$phantom_src" ] && [ ! -e "$phantom_src" ]; then
        log "clearing phantom mount at $MOUNT (source $phantom_src gone)"
        umount -l "$MOUNT" 2>/dev/null || true
      fi
    fi

    # Skip if the right device is already mounted at the right path
    if mountpoint -q "$MOUNT" && \
       [ "$(findmnt -n -o SOURCE "$MOUNT" 2>/dev/null)" = "$DEVICE" ]; then
      log "$DEVICE already mounted at $MOUNT"
    else
      # Permissive options for FAT/exFAT/NTFS (common on USB drives).
      # ext4/xfs/btrfs will reject `uid=` options, so branch.
      case "$TYPE" in
        vfat|exfat|ntfs|msdos)
          mount -o "rw,noatime,uid=1000,gid=1000,umask=0002,nofail" \
            "$DEVICE" "$MOUNT" \
            || { log "mount failed for $DEVICE ($TYPE) -> $MOUNT"; rmdir "$MOUNT" 2>/dev/null || true; exit 1; }
          ;;
        *)
          mount -o "rw,noatime,nofail" "$DEVICE" "$MOUNT" \
            || { log "mount failed for $DEVICE ($TYPE) -> $MOUNT"; rmdir "$MOUNT" 2>/dev/null || true; exit 1; }
          chown -R 1000:1000 "$MOUNT" 2>/dev/null || true
          ;;
      esac
      log "mounted $DEVICE ($TYPE, label=$LABEL) -> $MOUNT"
    fi

    state_add "$DEVICE" "$MOUNT" "$LABEL" "${UUID:-}"
    if [ "$NEXTCLOUD_AUTO_REGISTER" = "1" ]; then
      nextcloud_add "$MOUNT" "$NAME" || log "nextcloud registration skipped"
    else
      log "nextcloud auto-register disabled (set NEXTCLOUD_AUTO_REGISTER=1 to enable)"
    fi
    notify_bridge add "$DEVICE" "$MOUNT"
    ;;

  remove)
    # udev gives us the dev path of the partition that went away. We
    # look it up in state to find our mountpoint and unmount.
    mapfile -t old_mounts < <(state_remove "$DEVICE")
    for m in "${old_mounts[@]}"; do
      [ -z "$m" ] && continue
      name="$(basename "$m")"
      nextcloud_remove "$name" || true
      if mountpoint -q "$m"; then
        umount -l "$m" && log "unmounted $m"
      fi
      rmdir "$m" 2>/dev/null || true
    done
    notify_bridge remove "$DEVICE" ""
    ;;

  *)
    log "unknown action $ACTION"
    exit 1 ;;
esac
