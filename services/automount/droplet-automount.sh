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

# WARP-232 seams (test-only overrides; production uses the defaults).
USB_ENROLL="${DROPLET_AUTOMOUNT_USB_ENROLL:-/usr/local/sbin/droplet-usb-enroll.sh}"
SYSTEMD_CRYPTSETUP="${DROPLET_SYSTEMD_CRYPTSETUP_BIN:-/usr/lib/systemd/systemd-cryptsetup}"
CRYPTSETUP="${DROPLET_CRYPTSETUP_BIN:-cryptsetup}"

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
  # `${auth_args[@]}` on an EMPTY array trips `set -u` under bash < 4.4 (the
  # macOS 3.2 test host). Guard the expansion so the token-less call still fires
  # (the branch is identical; only the array plumbing differs by bash version).
  if [ "${#auth_args[@]}" -gt 0 ]; then
    curl -s -X POST -m 3 "${BRIDGE_URL}/drives/changed" \
      -H 'Content-Type: application/json' \
      "${auth_args[@]}" \
      -d "{\"action\":\"$1\",\"device\":\"$2\",\"mount\":\"$3\"}" \
      >/dev/null 2>&1 || true
  else
    curl -s -X POST -m 3 "${BRIDGE_URL}/drives/changed" \
      -H 'Content-Type: application/json' \
      -d "{\"action\":\"$1\",\"device\":\"$2\",\"mount\":\"$3\"}" \
      >/dev/null 2>&1 || true
  fi
}

# WARP-232: try to unlock a droplet-enrolled LUKS2 drive. Sets the global
# UNLOCKED_MAPPER (/dev/mapper/droplet-usb-<short-uuid>) and returns 0 on
# success; returns 1 for a foreign LUKS container (no droplet token, no
# derivable slot) so the caller can skip it cleanly.
UNLOCKED_MAPPER=""
try_unlock_droplet_luks() {
  local dev="$1"
  local luks_uuid short mapper
  luks_uuid="$(blkid -o value -s UUID "$dev" 2>/dev/null || true)"
  luks_uuid="${luks_uuid//$'\n'/}"
  short="$(printf '%s' "$luks_uuid" | head -c 8)"
  [ -z "$short" ] && short="usb"
  mapper="droplet-usb-${short}"

  # (1) droplet-enrolled? The LUKS2 header carries a systemd-tpm2 token. Attach
  #     via systemd-cryptsetup (uses the TPM keyslot, no passphrase).
  if "$CRYPTSETUP" luksDump "$dev" 2>/dev/null | grep -qi 'systemd-tpm2'; then
    if "$SYSTEMD_CRYPTSETUP" attach "$mapper" "$dev" - tpm2-device=auto 2>/dev/null; then
      UNLOCKED_MAPPER="/dev/mapper/$mapper"
      return 0
    fi
  fi

  # (2) derived-passphrase fallback: an enrolled drive whose TPM keyslot no
  #     longer opens (TPM loss) still has the on-box-derivable recovery slot.
  if [ -x "$USB_ENROLL" ] || command -v "$USB_ENROLL" >/dev/null 2>&1; then
    local pass
    pass="$("$USB_ENROLL" derive "$luks_uuid" 2>/dev/null | head -1 || true)"
    if [ -n "$pass" ] \
       && printf '%s' "$pass" | "$CRYPTSETUP" open --key-file - "$dev" "$mapper" 2>/dev/null; then
      UNLOCKED_MAPPER="/dev/mapper/$mapper"
      return 0
    fi
  fi

  # Foreign LUKS: not droplet-enrolled, no derivable slot.
  return 1
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
  # Args: device mount label uuid [trust] [mapper]
  # WARP-232: `device` is the BACKING partition (/dev/sdX1) — for an enrolled
  # LUKS drive that is the raw partition, NOT the unlocked mapper — so a later
  # udev REMOVE event (which carries the backing partition) matches, and
  # crypto-shred luksErases the real LUKS header. `mapper` (7th arg) is the
  # unlocked dm mapper to `cryptsetup close` on remove; empty for a plain drive.
  # `trust` (5th arg): "enrolled" | "trusted" | "untrusted-ro". Defaults to
  # "trusted" for backward compatibility.
  local device="$1" mount="$2" label="$3" uuid="$4" trust="${5:-trusted}" mapper="${6:-}"
  python3 - "$STATE_FILE" "$device" "$mount" "$label" "$uuid" "$trust" "$mapper" <<'PYEOF'
import json, os, sys
path, device, mount, label, uuid, trust, mapper = sys.argv[1:8]
try:
    with open(path) as f: state = json.load(f)
except Exception:
    state = {"mounts": []}
state["mounts"] = [m for m in state["mounts"] if m.get("device") != device]
entry = {
    "device": device, "mount": mount, "label": label, "uuid": uuid,
    "trust": trust,
}
if mapper:
    entry["mapper"] = mapper
state["mounts"].append(entry)
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f: json.dump(state, f, indent=2)
PYEOF
}

state_remove() {
  local device="$1"
  # Prints, per removed entry, a TAB-separated "<mount>\t<mapper>" line so the
  # remove path can unmount AND close the mapper (mapper empty for plain drives).
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
    print("%s\t%s" % (m.get("mount", ""), m.get("mapper", "")))
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
    # TRUST classifies the mount for the dashboard: enrolled (LUKS we own),
    # trusted (plain drive on the trust list → rw), untrusted-ro (plain drive
    # we don't know → read-only). Set below; defaults to trusted for the
    # historical plain-drive path.
    TRUST="trusted"
    # BACKING_DEVICE tracks the raw partition udev handed us. For a plain drive
    # it stays == DEVICE. For an enrolled LUKS drive, DEVICE is swapped to the
    # unlocked mapper for the mount path below, but BACKING_DEVICE keeps the
    # /dev/sdX1 that (a) the udev REMOVE event will carry (so state_remove
    # matches and we can close the mapper), and (b) crypto-shred must luksErase
    # (the mapper is a plaintext dm node with no LUKS header). WARP-232 finding 7.
    BACKING_DEVICE="$DEVICE"
    MAPPER_DEVICE=""
    case "$TYPE" in
      crypto_LUKS)
        # WARP-232: droplet-enrolled LUKS2 drives unlock here; everything else
        # (foreign LUKS) keeps the clean skip. RAID/LVM/swap fall through to the
        # next case (managed by their own subsystem).
        if try_unlock_droplet_luks "$DEVICE"; then
          MAPPER_DEVICE="$UNLOCKED_MAPPER"
          DEVICE="$UNLOCKED_MAPPER"           # fall through to the mount path
          TYPE="$(blkid -o value -s TYPE "$DEVICE" 2>/dev/null || echo ext4)"
          TRUST="enrolled"
        else
          log "skip $DEVICE (foreign LUKS container — not droplet-enrolled)"
          exit 0
        fi
        ;;
      linux_raid_member|LVM2_member|swap)
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

    # WARP-232 trust decision for PLAIN filesystems (enrolled LUKS is already
    # TRUST=enrolled from the signature switch). A plain drive is rw only if
    # its UUID is on the operator's trust list; otherwise it mounts read-only
    # so an unknown stick can't be written to (and the dashboard can offer
    # "encrypt" / "trust"). Enrolled drives keep TRUST=enrolled.
    if [ "$TRUST" != "enrolled" ]; then
      TRUSTED_LIST="${STATE_DIR}/trusted.list"
      if [ -n "${UUID:-}" ] && [ -f "$TRUSTED_LIST" ] \
         && grep -qxF "$UUID" "$TRUSTED_LIST" 2>/dev/null; then
        TRUST="trusted"
      else
        TRUST="untrusted-ro"
      fi
    fi
    # rw for enrolled/trusted drives, ro for untrusted ones.
    if [ "$TRUST" = "untrusted-ro" ]; then
      RW_MODE="ro"
    else
      RW_MODE="rw"
    fi

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
      # WARP-232: $RW_MODE is ro for untrusted plain drives, rw otherwise.
      case "$TYPE" in
        vfat|exfat|ntfs|msdos)
          mount -o "${RW_MODE},noatime,uid=1000,gid=1000,umask=0002,nofail" \
            "$DEVICE" "$MOUNT" \
            || { log "mount failed for $DEVICE ($TYPE) -> $MOUNT"; rmdir "$MOUNT" 2>/dev/null || true; exit 1; }
          ;;
        *)
          mount -o "${RW_MODE},noatime,nofail" "$DEVICE" "$MOUNT" \
            || { log "mount failed for $DEVICE ($TYPE) -> $MOUNT"; rmdir "$MOUNT" 2>/dev/null || true; exit 1; }
          [ "$RW_MODE" = "rw" ] && chown -R 1000:1000 "$MOUNT" 2>/dev/null || true
          ;;
      esac
      log "mounted $DEVICE ($TYPE, label=$LABEL, trust=$TRUST) -> $MOUNT"
    fi

    # Record the BACKING partition as `device` (so udev remove + crypto-shred
    # match the raw LUKS partition, not the plaintext mapper) and the mapper
    # separately (to close on remove). WARP-232 finding 7.
    state_add "$BACKING_DEVICE" "$MOUNT" "$LABEL" "${UUID:-}" "$TRUST" "$MAPPER_DEVICE"
    if [ "$NEXTCLOUD_AUTO_REGISTER" = "1" ]; then
      nextcloud_add "$MOUNT" "$NAME" || log "nextcloud registration skipped"
    else
      log "nextcloud auto-register disabled (set NEXTCLOUD_AUTO_REGISTER=1 to enable)"
    fi
    notify_bridge add "$BACKING_DEVICE" "$MOUNT"
    ;;

  remove)
    # udev gives us the dev path of the partition that went away — the BACKING
    # partition (/dev/sdX1) for an enrolled LUKS drive, which is exactly what
    # state now records as `device`, so this matches (WARP-232 finding 7).
    # Each state_remove line is "<mount>\t<mapper>"; unmount the mount, then
    # close the mapper (if any) so a replugged enrolled drive isn't blocked by a
    # stale open dm device.
    # `while read` (not mapfile) so this works on bash 3.2 as well as 4+ — the
    # udev/systemd host runs bash 5, but the hermetic tests + dev boxes may be
    # older, and mapfile silently no-ops there.
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      m="${entry%%$'\t'*}"
      mapper="${entry#*$'\t'}"
      [ "$mapper" = "$entry" ] && mapper=""   # no tab → no mapper field
      [ -z "$m" ] && continue
      name="$(basename "$m")"
      nextcloud_remove "$name" || true
      if mountpoint -q "$m"; then
        umount -l "$m" && log "unmounted $m"
      fi
      rmdir "$m" 2>/dev/null || true
      # Close the LUKS mapper so the dm node is released and a replug re-unlocks
      # cleanly (finding 7: without this the mapper lingered and the drive could
      # flip to a stale/read-only state on the next add).
      if [ -n "$mapper" ]; then
        mapper_name="$(basename "$mapper")"
        "$CRYPTSETUP" close "$mapper_name" 2>/dev/null \
          && log "closed LUKS mapper $mapper_name" || true
      fi
    done < <(state_remove "$DEVICE")
    notify_bridge remove "$DEVICE" ""
    ;;

  *)
    log "unknown action $ACTION"
    exit 1 ;;
esac
