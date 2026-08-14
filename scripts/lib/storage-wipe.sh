#!/usr/bin/env bash
# =============================================================================
# Droplet — factory-reset bulk-storage wipe (WARP-1988)
# =============================================================================
#
# A factory reset returns the box to a FACTORY-NEW state. Until now that was
# true of every Docker volume, secret and cert — but NOT of the attached data
# drives. `factory-reset.sh` deliberately never touched them ("data on a pool
# is the owner's, not factory state"), which is the right call for a reset in
# place and the WRONG call for the case a reset is actually used for on the
# bench: wiping a box before it changes hands.
#
# Verified consequence (lab box, 2026-08-13/14): the reset ran, the box was
# rebuilt, and the pre-reset RAID1 pool was still assembled, still mounted,
# still labelled, still carrying its filesystem. Reclaiming a member by hand
# through the dashboard afterwards left the array DEGRADED. The old pool
# survived the wipe and had to be dismantled manually.
#
# So: a reset now erases Droplet-managed bulk storage by default, and
# --keep-storage opts out.
#
# WHAT IS IN SCOPE
#   - md arrays assembled on this box (the storage pools)
#   - filesystems mounted under /mnt/droplet (pools + adopted drives)
#   - the automount trust list and the mountpoint directories
#
# WHAT IS NEVER TOUCHED — the guard that makes this safe to default ON
#   Any device that shares a PHYSICAL disk with /, /boot or /boot/efi. The
#   check resolves both the candidate and each OS mount down to their TYPE=disk
#   leaves, so an LVM/LUKS/md-stacked root is caught (a bare `lsblk -ndo
#   PKNAME` stops at the dm node and silently reports the partition — the trap
#   recorded in automount-hijacks-boot-partitions-on-lvm). This matters
#   concretely: automount's trust list on the lab box contains the ESP and
#   /boot UUIDs, so "everything automount manages" is NOT a safe scope. Backing
#   disk identity is.
#
# The erase is STRUCTURAL, not forensic: stop the array, zero every member's md
# superblock, wipefs each member. That destroys the pool, its metadata and its
# filesystems so nothing re-assembles on the next boot and the next owner
# starts from clean metal. File contents remain recoverable off the raw
# platters — a box moving between customers needs a separate overwrite pass.
#
# This duplicates the OS-disk guard in scripts/host/droplet-storage-pool.sh
# rather than sharing it. That is deliberate: the host script is INSTALLED
# standalone into /usr/local/sbin by install-device-bridge.sh, so it cannot
# source a repo lib. tests/factory-reset-storage-wipe.test.sh pins the
# behaviour of this copy.
#
# Test seams (mirroring DROPLET_POOL_TEST_OSDISK in the host script) let the
# whole discovery + erase path run against a fake /sys tree and stub binaries,
# with no real disks: SW_SYSFS_BLOCK, SW_MDSTAT, SW_MNT_BASE, SW_TRUSTED_LIST,
# SW_FSTAB, SW_TEST_OSDISK, SW_SUDO.
# =============================================================================

SW_SYSFS_BLOCK="${SW_SYSFS_BLOCK:-/sys/block}"
SW_MDSTAT="${SW_MDSTAT:-/proc/mdstat}"
SW_MNT_BASE="${SW_MNT_BASE:-/mnt/droplet}"
SW_TRUSTED_LIST="${SW_TRUSTED_LIST:-/var/lib/droplet-automount/trusted.list}"
SW_FSTAB="${SW_FSTAB:-/etc/fstab}"
SW_SUDO="${SW_SUDO-sudo}"

# Collected for the post-wipe fstab warning.
SW_WIPED_UUIDS=""
SW_WIPED_COUNT=0
SW_SKIPPED_COUNT=0

# --- helpers ----------------------------------------------------------------

_sw_say()  { printf '  %s\n' "$*" >&2; }
_sw_warn() { printf '  ! %s\n' "$*" >&2; }

# sw_ancestor_disks <dev> — every TYPE=disk leaf backing <dev>, one per line.
# Walks dm/LVM/crypt/md so a stacked root resolves to its real physical disks.
sw_ancestor_disks() {
  local dev="$1"
  lsblk -nso NAME,TYPE "$dev" 2>/dev/null | awk '$2 == "disk" { print $1 }' | sort -u
}

# sw_is_os_disk <dev> — 0 if <dev> shares a physical disk with /, /boot or
# /boot/efi. Fails CLOSED: if the candidate cannot be resolved at all we treat
# it as an OS disk rather than risk erasing the boot device.
sw_is_os_disk() {
  local dev="$1"
  if [ -n "${SW_TEST_OSDISK:-}" ]; then
    local base t
    base="$(basename "$dev")"
    for t in $SW_TEST_OSDISK; do
      [ "$base" = "$(basename "$t")" ] && return 0
    done
    return 1
  fi
  local this_disks os_disks d o src mp
  this_disks="$(sw_ancestor_disks "$dev")"
  if [ -z "$this_disks" ]; then
    _sw_warn "cannot resolve backing disks for $dev — treating as OS disk and skipping"
    return 0
  fi
  for mp in / /boot /boot/efi; do
    src="$(findmnt -rn -o SOURCE --target "$mp" 2>/dev/null || true)"
    [ -n "$src" ] || continue
    src="${src%%[*}"   # btrfs/bind SOURCE is /dev/sdX[/subvol] (WARP-857)
    os_disks="$(sw_ancestor_disks "$src")"
    [ -n "$os_disks" ] || os_disks="$(basename "$src")"
    for o in $os_disks; do
      for d in $this_disks; do
        [ "$o" = "$d" ] && return 0
      done
    done
  done
  return 1
}

# sw_md_members <mdname> — member device nodes of an assembled array.
# Read from sysfs BEFORE any --stop: `mdadm --stop` removes /sys/block/<md>,
# so enumerating afterwards matches nothing and no superblock gets zeroed —
# the exact defect tests/storage-pool-destroy-superblock.test.sh pins.
sw_md_members() {
  local md="$1" slave
  [ -d "$SW_SYSFS_BLOCK/$md/slaves" ] || return 0
  for slave in "$SW_SYSFS_BLOCK/$md/slaves"/*; do
    [ -e "$slave" ] || continue
    printf '/dev/%s\n' "$(basename "$slave")"
  done
}

# sw_is_array_member <devnode> — 0 if the disk is STILL a member of some
# assembled array. Guards the standalone sweep: if an array was refused (an
# OS-disk member) or failed to stop, wipefs-ing one of its members underneath
# it does not free the disk, it DEGRADES the array — which is precisely how the
# lab box ended up with a one-legged mirror on 2026-08-14.
sw_is_array_member() {
  local base slave
  base="$(basename "$1")"
  for slave in "$SW_SYSFS_BLOCK"/*/slaves/"$base"; do
    [ -e "$slave" ] && return 0
  done
  return 1
}

# sw_assembled_arrays — md devices currently assembled, from /proc/mdstat.
sw_assembled_arrays() {
  [ -r "$SW_MDSTAT" ] || return 0
  awk '/^md[0-9]+ *:/ { sub(/ *:.*/, "", $1); print $1 }' "$SW_MDSTAT"
}

# sw_droplet_mounts — mountpoints under $SW_MNT_BASE, deepest first so a
# nested mount is released before its parent.
sw_droplet_mounts() {
  findmnt -rn -o TARGET 2>/dev/null \
    | awk -v base="$SW_MNT_BASE/" 'index($0, base) == 1' \
    | awk '{ print length($0), $0 }' | sort -rn | cut -d' ' -f2-
}

# sw_source_of <mountpoint> — backing device node.
sw_source_of() {
  local src
  src="$(findmnt -rn -o SOURCE --mountpoint "$1" 2>/dev/null || true)"
  printf '%s' "${src%%[*}"
}

# sw_note_uuid <dev> — remember a UUID we are about to destroy so the caller
# can warn about fstab entries that will become dead-but-nofail (a silent
# failure generator: the mount just never appears and nothing logs).
sw_note_uuid() {
  local uuid
  uuid="$(blkid -o value -s UUID "$1" 2>/dev/null || true)"
  [ -n "$uuid" ] && SW_WIPED_UUIDS="$SW_WIPED_UUIDS $uuid"
  return 0
}

# --- erase primitives -------------------------------------------------------

# sw_unmount <mountpoint> — non-lazy. A real EBUSY is reported and the target
# is skipped rather than force-detached: silently lazy-unmounting a busy
# filesystem and then wipefs-ing it underneath a live writer corrupts more
# than it cleans.
sw_unmount() {
  local mp="$1"
  if $SW_SUDO umount "$mp" 2>/dev/null; then
    _sw_say "unmounted $mp"
    return 0
  fi
  _sw_warn "could not unmount $mp (busy) — leaving it and its device alone"
  return 1
}

# sw_wipe_device <dev> — clear filesystem + md signatures from one device.
sw_wipe_device() {
  local dev="$1"
  $SW_SUDO mdadm --zero-superblock "$dev" 2>/dev/null || true
  if $SW_SUDO wipefs -a "$dev" >/dev/null 2>&1; then
    _sw_say "wiped signatures on $dev"
    SW_WIPED_COUNT=$((SW_WIPED_COUNT + 1))
    return 0
  fi
  _sw_warn "wipefs failed on $dev"
  return 1
}

# --- the wipe ---------------------------------------------------------------

# sw_wipe_droplet_storage — discover and erase Droplet-managed bulk storage.
# Always returns 0: a factory reset must complete. Every refusal and every
# failure is reported, and the caller reports the totals.
# >>> factory-reset storage wipe
sw_wipe_droplet_storage() {
  local mp src md members m skip

  # 1) Release every mount under the shared namespace first, so the arrays and
  #    disks below are free. Deepest-first.
  for mp in $(sw_droplet_mounts); do
    src="$(sw_source_of "$mp")"
    if [ -n "$src" ] && sw_is_os_disk "$src"; then
      _sw_warn "refusing: $mp is backed by the OS/boot disk ($src) — not touching it"
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    [ -n "$src" ] && sw_note_uuid "$src"
    sw_unmount "$mp" || true
  done

  # 2) Tear down every assembled array whose members are all non-OS disks.
  for md in $(sw_assembled_arrays); do
    members="$(sw_md_members "$md")"
    if [ -z "$members" ]; then
      _sw_warn "array $md reports no members — skipping"
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    skip=0
    for m in $members; do
      if sw_is_os_disk "$m"; then
        _sw_warn "refusing: array $md has an OS/boot-disk member ($m) — not touching it"
        skip=1
        break
      fi
    done
    if [ "$skip" -eq 1 ]; then
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    sw_note_uuid "/dev/$md"
    # Members were captured above, BEFORE --stop removes /sys/block/$md.
    $SW_SUDO mdadm --stop "/dev/$md" >/dev/null 2>&1 \
      && _sw_say "stopped array /dev/$md" \
      || _sw_warn "could not stop /dev/$md"
    for m in $members; do
      sw_wipe_device "$m"
    done
  done

  # 3) Any remaining whole disk that is not an OS disk and carries a Droplet
  #    filesystem signature but is no longer mounted or arrayed — the adopted
  #    drives. Enumerated from lsblk, guarded the same way.
  local disk node
  for disk in $(lsblk -ndo NAME,TYPE 2>/dev/null | awk '$2 == "disk" { print $1 }'); do
    node="/dev/$disk"
    sw_is_os_disk "$node" && continue
    # Never wipe a disk still held by an array — see sw_is_array_member. An
    # array we refused (OS-disk member) or could not stop keeps its members,
    # and wiping one here would degrade it instead of freeing it.
    if sw_is_array_member "$node"; then
      _sw_warn "refusing: $node is still a member of an assembled array — not wiping it"
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    # Already handled above (its signatures are gone) — wipefs is a no-op then.
    if [ -n "$(lsblk -ndo FSTYPE "$node" 2>/dev/null)" ]; then
      sw_note_uuid "$node"
      sw_wipe_device "$node"
    fi
  done

  # 4) Automount trust list — the UUIDs are gone, so the entries are stale.
  #    Truncate rather than delete: services/automount/install.sh owns the file
  #    and its root:root ownership (WARP-843 root-unit LPE invariant).
  if [ -f "$SW_TRUSTED_LIST" ]; then
    $SW_SUDO truncate -s 0 "$SW_TRUSTED_LIST" 2>/dev/null \
      && _sw_say "cleared the automount trust list" \
      || _sw_warn "could not clear $SW_TRUSTED_LIST"
  fi

  # 5) Empty mountpoint stubs under the namespace. rmdir only — a directory
  #    that still has content is a mount we failed to release, and deleting
  #    through it would destroy data on a filesystem we could not verify.
  if [ -d "$SW_MNT_BASE" ]; then
    for mp in "$SW_MNT_BASE"/*; do
      [ -d "$mp" ] || continue
      $SW_SUDO rmdir "$mp" 2>/dev/null || true
    done
  fi

  # 6) fstab entries naming a UUID we just destroyed would mount nothing on the
  #    next boot. Under `nofail` that fails SILENTLY — the documented way this
  #    box lost its bulk storage for a month. Warn; never rewrite an operator's
  #    fstab during a reset.
  local u
  for u in $SW_WIPED_UUIDS; do
    if [ -n "$u" ] && grep -q "$u" "$SW_FSTAB" 2>/dev/null; then
      _sw_warn "$SW_FSTAB still references the wiped UUID $u — remove that line or the next boot mounts nothing (silently, under nofail)"
    fi
  done

  return 0
}
# <<< factory-reset storage wipe
