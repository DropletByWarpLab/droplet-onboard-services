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
#   - unmounted whole disks whose fs UUID is on the automount trust list —
#     the drives the box RECORDED as adopted (drive_adopt/pool_format seed the
#     list; the boot reconcile re-seeds it). A disk with no trusted UUID is
#     NOT Droplet-managed and survives, whatever filesystem it carries: a
#     customer's own drive plugged in at reset time is not factory state.
#     The list is consulted in step 3, before step 4 truncates it.
#   - the automount trust list and the mountpoint directories
#   - encrypted bays (WARP-3513, below): the LUKS containers, their open
#     droplet-bay-* mappers, their crypttab lines and escrowed recovery keys
#
# WHAT IS NEVER TOUCHED — the guard that makes this safe to default ON
#   Any device that shares a PHYSICAL disk with /, /boot or /boot/efi. The
#   check resolves both the candidate and each OS mount down to their TYPE=disk
#   leaves, so an LVM/LUKS/md-stacked root is caught (a bare `lsblk -ndo
#   PKNAME` stops at the dm node and silently reports the partition — the trap
#   recorded in automount-hijacks-boot-partitions-on-lvm). This matters
#   concretely: automount's trust list on the lab box contains the ESP and
#   /boot UUIDs, so trust-list membership NARROWS the scope but never widens
#   it — a trusted UUID on the OS disk is still refused by this guard, which
#   always runs first.
#
# The erase is STRUCTURAL, not forensic: stop the array, zero every member's md
# superblock, wipefs each member. That destroys the pool, its metadata and its
# filesystems so nothing re-assembles on the next boot and the next owner
# starts from clean metal. File contents remain recoverable off the raw
# platters — a box moving between customers needs a separate overwrite pass.
#
# ENCRYPTED BAYS (WARP-3513; storage decision record ADR-070)
#   Every drive the dashboard prepares is LUKS2: disk (or md array) -> LUKS
#   container -> /dev/mapper/droplet-bay-<luks8> -> ext4 under /mnt/droplet, with
#   a crypttab line and a root-only escrow of its recovery key. wipefs alone
#   removes only the LUKS MAGIC — the keyslots and the TPM-sealed key stay
#   recoverable by re-writing the signature — so for every device this library
#   erases it also:
#     1. closes any droplet-bay-* mapper open on it, AFTER step 1 released its
#        mounts and BEFORE any wipe, zero-superblock or `mdadm --stop` (the mapper
#        holds the device open: all three hit EBUSY while it is up);
#     2. crypto-erases every LUKS container on it — the disk, an md array, a
#        child — with `cryptsetup luksErase --batch-mode`, BEFORE wipefs. A
#        container whose keyslots cannot be erased is NOT wiped: wipefs would
#        leave exactly the weak erase this exists to avoid (magic gone, keyslots
#        intact). It is refused, and the failure is counted for the reset's record;
#     3. afterwards removes the bay state the box wrote: the droplet-bay-* lines
#        in crypttab and the escrowed recovery keys (SW_BAY_RECOVERY_DIRS,
#        overwrite-then-unlink). A drive that was on the box and could NOT be
#        erased keeps its line and its key: dropping them would leave it neither
#        wiped nor openable.
#   Scope: a disk is Droplet-managed when its filesystem UUID is on the trust list
#   (as before) OR it carries a LUKS container whose UUID is a droplet-bay-*
#   crypttab line OR a droplet-bay-* mapper is open on it. The trust list holds
#   the UUID of the filesystem INSIDE the container, which a disk node never
#   reports (it reports the LUKS UUID), so a locked bay could not be recognised by
#   the trust list alone. A LUKS drive with no such record is NOT ours and
#   survives. The OS-disk guard still runs first for every device, and
#   --keep-storage never reaches any of this (factory-reset.sh skips the library).
#   Privileged calls go through $SW_SUDO, like everything else here.
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
# SW_FSTAB, SW_TEST_OSDISK, SW_SUDO, and for the encrypted bays SW_CRYPTTAB and
# SW_BAY_RECOVERY_DIRS.
# =============================================================================

SW_SYSFS_BLOCK="${SW_SYSFS_BLOCK:-/sys/block}"
SW_MDSTAT="${SW_MDSTAT:-/proc/mdstat}"
SW_MNT_BASE="${SW_MNT_BASE:-/mnt/droplet}"
SW_TRUSTED_LIST="${SW_TRUSTED_LIST:-/var/lib/droplet-automount/trusted.list}"
SW_FSTAB="${SW_FSTAB:-/etc/fstab}"
SW_SUDO="${SW_SUDO-sudo}"
# WARP-3513. The crypttab the host script adds a `droplet-bay-<luks8> UUID=<luks-uuid>
# none tpm2-device=auto,...` line to for every bay it prepares.
SW_CRYPTTAB="${SW_CRYPTTAB:-/etc/crypttab}"
# Where that script escrows each bay's recovery key — root-only, one
# `<luks-uuid>__<fs-uuid>.key` plus a `.retrieved` / `.expired` tombstone per
# drive, under the ENCRYPTED /data only (ADR-070: a key is never held on the
# unencrypted OS disk; Prepare refuses on a box whose /data is not encrypted).
# Whitespace-separated, so a test can point it at several directories.
SW_BAY_RECOVERY_DIRS="${SW_BAY_RECOVERY_DIRS:-/data/droplet/secrets/bay-recovery}"
# The mapper / crypttab name prefix every bay gets (droplet-bay-<first 8 chars of
# the LUKS UUID>). Not a seam: it is the box's own naming, shared with the host script.
SW_BAY_PREFIX="droplet-bay-"

# Collected for the post-wipe fstab warning.
SW_WIPED_UUIDS=""
SW_WIPED_COUNT=0
SW_SKIPPED_COUNT=0
# Backing devices of mounts we could NOT release in step 1. Step 2 consults
# this before tearing an array down: a pool we failed to unmount is a pool with
# a live writer on it, and stopping/wiping underneath one corrupts more than it
# cleans — the same reasoning that makes sw_unmount non-lazy.
SW_BUSY_SOURCES=""

# WARP-3513 bookkeeping for the reset's own record. COUNTS and UUIDs only —
# never a key (rule 19): an escrowed recovery key is never read, let alone printed.
SW_CRYPTO_ERASED_COUNT=0    # LUKS containers `cryptsetup luksErase` succeeded on
SW_CRYPTO_FAILED_COUNT=0    # ...and the ones it FAILED on: keyslots still intact
SW_BAY_MAPPERS_CLOSED=0
SW_CRYPTTAB_REMOVED=0       # droplet-bay-* lines taken out of $SW_CRYPTTAB
SW_ESCROW_REMOVED=0         # escrowed recovery-key files (and tombstones) removed
# LUKS UUIDs this run crypto-erased, and the bay LUKS UUIDs that were on the box
# when it started (snapshotted before anything is closed or wiped). The state of
# a drive that was present and is NOT in the first list is kept: see
# sw_bay_keep_uuids.
SW_CRYPTO_ERASED_UUIDS=""
SW_BAY_PRESENT_UUIDS=""

# --- helpers ----------------------------------------------------------------

_sw_say()  { printf '  %s\n' "$*" >&2; }
_sw_warn() { printf '  ! %s\n' "$*" >&2; }

# sw_ancestor_disks <dev> — every TYPE=disk leaf backing <dev>, one per line.
# Walks dm/LVM/crypt/md so a stacked root resolves to its real physical disks.
# `-r` (raw) is load-bearing: `lsblk -s` DRAWS A TREE otherwise, so every leaf
# below the first line comes back as "└─nvme0n1", and a whole-disk candidate
# ("nvme0n1") never equalled the stacked root's leaf — the guard missed the OS
# disk itself in the one case it exists for. Same flag, same reason, as
# ancestor_disks() in scripts/host/droplet-storage-pool.sh.
sw_ancestor_disks() {
  local dev="$1"
  lsblk -rnso NAME,TYPE "$dev" 2>/dev/null | awk '$2 == "disk" { print $1 }' | sort -u
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
    if [ -z "$os_disks" ]; then
      # Fail CLOSED, same as the candidate side above. The old fallback here
      # compared `basename "$src"` — a partition or dm name — against the
      # candidate's TYPE=disk leaves, a comparison that can never match. An
      # unresolvable OS mount would therefore have silently reported "not an OS
      # disk" for every candidate, which is the opposite of this guard's
      # documented contract.
      _sw_warn "cannot resolve backing disks for $mp ($src) — treating $dev as OS-backed and skipping"
      return 0
    fi
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

# sw_is_busy_source <devnode> — 0 if <devnode> backs a mount step 1 could not
# release. Step 1 and step 2 otherwise iterate with no shared state, so a pool
# that refused to unmount was still handed to `mdadm --stop` — busy by
# definition, and therefore straight into the failed-stop path below.
#
# WARP-3513: "backs" includes THROUGH a mapper. A bay is mounted from
# /dev/mapper/droplet-bay-<luks8>, not from the disk or md array under it, so the
# busy source recorded in step 1 is the mapper's name — which never equals the
# device the later steps ask about. Anything stacked on <devnode> counts.
sw_is_busy_source() {
  local want b name
  want="$(basename "$1")"
  for b in $SW_BUSY_SOURCES; do
    [ "$want" = "$(basename "$b")" ] && return 0
  done
  [ -n "$SW_BUSY_SOURCES" ] || return 1
  while read -r name _; do
    for b in $SW_BUSY_SOURCES; do
      [ "$(basename "$name")" = "$(basename "$b")" ] && return 0
    done
  done < <(sw_stack_of "$1")
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

# sw_is_droplet_disk <dev> — 0 if the box RECORDED <dev>'s filesystem as
# Droplet-managed: its fs UUID is on automount's trust list, where
# drive_adopt/pool_format seed every adopted drive and pool (whole-device
# filesystems, so the UUID sits on the disk node — matches `grep -qxF`, the
# exact shape trusted_list_add writes). Fails CLOSED for the wipe's purposes:
# no UUID, or no trust list, means NOT ours — never "carries a signature, so
# probably ours". This is what keeps a never-adopted drive plugged in at
# reset time out of step 3's blast radius.
sw_is_droplet_disk() {
  local uuid
  uuid="$(blkid -o value -s UUID "$1" 2>/dev/null || true)"
  [ -n "$uuid" ] || return 1
  [ -f "$SW_TRUSTED_LIST" ] || return 1
  grep -qxF "$uuid" "$SW_TRUSTED_LIST" 2>/dev/null
}

# sw_standalone_droplet_disks — the disks ONLY step 3 will erase: recorded as
# Droplet-managed on the trust list, not a member of an assembled array, not
# currently backing a mount under $SW_MNT_BASE, not the OS disk. The
# confirmation prompt threads these in so every drive is NAMED before the
# operator types RESET — pools and mounted drives are already named by
# sw_assembled_arrays/sw_droplet_mounts, and without this list an unmounted
# adopted drive was erased unnamed.
sw_standalone_droplet_disks() {
  local mounted mp disk node src d
  mounted=" "
  for mp in $(sw_droplet_mounts); do
    src="$(sw_source_of "$mp")"
    mounted="${mounted}$(basename "$src") "
    # WARP-3513: a bay is mounted from its dm-crypt mapper, not from the disk
    # under it, so the basename above would never equal the disk's. Resolve the
    # mount back to its physical disks too — otherwise a MOUNTED bay is named
    # twice, once by its mountpoint and once as an "unmounted adopted" drive.
    if [ -n "$src" ]; then
      for d in $(sw_ancestor_disks "$src"); do
        mounted="${mounted}${d} "
      done
    fi
  done
  for disk in $(lsblk -ndo NAME,TYPE 2>/dev/null | awk '$2 == "disk" { print $1 }'); do
    node="/dev/$disk"
    case "$mounted" in *" $disk "*) continue ;; esac
    sw_is_os_disk "$node" && continue
    sw_is_array_member "$node" && continue
    # Same two gates as step 3 — keep them in step, or the prompt names a
    # different set of drives than the wipe erases.
    if sw_is_droplet_disk "$node" || sw_is_bay_disk "$node"; then
      printf '%s\n' "$node"
    fi
  done
  return 0
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

# --- encrypted bays (WARP-3513) ---------------------------------------------
# See "ENCRYPTED BAYS" in the header for the model. Everything here is read-only
# until sw_release_encryption / sw_purge_bay_state are called, and every one of
# those is only ever reached from sw_wipe_droplet_storage, after the OS-disk guard.

# UUIDs are compared case-insensitively — crypttab is hand-editable.
_sw_lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# sw_stack_of <dev> — "NAME TYPE" lines for <dev> itself and every device
# stacked ON it (partitions, md arrays, dm-crypt mappers), as full /dev paths.
# `-r` (raw) so no tree glyphs reach the parser. Prints nothing when lsblk cannot
# resolve <dev>; callers that act on the answer treat that as "cannot tell".
sw_stack_of() {
  lsblk -rnpo NAME,TYPE "$1" 2>/dev/null || true
}

# sw_stack_crypt_names <dev> — the name of every dm-crypt mapper stacked on <dev>.
sw_stack_crypt_names() {
  local name type
  while read -r name type; do
    [ "$type" = "crypt" ] && printf '%s\n' "${name##*/}"
  done < <(sw_stack_of "$1")
  return 0
}

# sw_open_bay_mappers <dev> — the droplet-bay-* mappers open on <dev>.
sw_open_bay_mappers() {
  local name
  for name in $(sw_stack_crypt_names "$1"); do
    case "$name" in "$SW_BAY_PREFIX"*) printf '%s\n' "$name" ;; esac
  done
  return 0
}

# sw_luks_containers <dev> — the LUKS containers in <dev>'s stack: <dev> itself
# and anything stacked on it whose superblock is crypto_LUKS (a low-level probe,
# as root — the same privilege the erase needs). A mapper is skipped: its content
# is the PLAINTEXT side of a container, never a container of its own.
sw_luks_containers() {
  local name type
  while read -r name type; do
    [ "$type" = "crypt" ] && continue
    if [ "$($SW_SUDO blkid -p -o value -s TYPE "$name" 2>/dev/null || true)" = "crypto_LUKS" ]; then
      printf '%s\n' "$name"
    fi
  done < <(sw_stack_of "$1")
  return 0
}

# sw_luks_uuid <dev> — the LUKS container's own UUID (what crypttab names).
sw_luks_uuid() {
  _sw_lc "$($SW_SUDO blkid -p -o value -s UUID "$1" 2>/dev/null || true)"
}

# sw_crypttab_bay_uuids — the LUKS UUID of every droplet-bay-* line in crypttab,
# one per line. A comment mentioning a bay is not a line ($1 is "#"), and a
# device spelled `UUID=` or `/dev/disk/by-uuid/` is understood; anything else
# (a hand-written /dev/sdX) names no UUID and so matches nothing.
sw_crypttab_bay_uuids() {
  [ -r "$SW_CRYPTTAB" ] || return 0
  awk -v p="$SW_BAY_PREFIX" '
    substr($1, 1, length(p)) == p {
      if ($2 ~ /^UUID=/) { print tolower(substr($2, 6)) }
      else if ($2 ~ /^\/dev\/disk\/by-uuid\//) { d = $2; sub(/^.*\//, "", d); print tolower(d) }
    }
  ' "$SW_CRYPTTAB" 2>/dev/null || true
  return 0
}

# sw_crypttab_has_uuid <luks-uuid> — 0 if a droplet-bay-* crypttab line names it.
# (Captured to a variable and matched with `case`, not piped into `grep -q`: an
# early-exiting grep SIGPIPEs the writer, which under pipefail is a false "no".)
sw_crypttab_has_uuid() {
  local u known
  u="$(_sw_lc "$1")"
  [ -n "$u" ] || return 1
  known=" $(sw_crypttab_bay_uuids | tr '\n' ' ') "
  case "$known" in *" $u "*) return 0 ;; esac
  return 1
}

# sw_is_bay_disk <dev> — 0 if the box made <dev> an encrypted bay: a droplet-bay-*
# mapper is open on it, or it carries a LUKS container whose UUID is a
# droplet-bay-* crypttab line. Read-only. This is what puts a LOCKED bay in
# scope — the trust list holds the filesystem UUID inside the container, which a
# disk node never reports.
sw_is_bay_disk() {
  local c
  [ -n "$(sw_open_bay_mappers "$1")" ] && return 0
  for c in $(sw_luks_containers "$1"); do
    sw_crypttab_has_uuid "$(sw_luks_uuid "$c")" && return 0
  done
  return 1
}

# sw_release_encryption <dev> — release everything encrypted that sits on <dev>
# so it can be wiped: close its droplet-bay-* mapper(s), then crypto-erase every
# LUKS container in its stack. Returns 0 when <dev> now carries no live
# encryption (including: it never did), 1 — having said why — when it still
# does, in which case the caller must NOT wipe it. FAILS CLOSED throughout:
#   - a stack lsblk cannot list is a refusal, not "nothing encrypted";
#   - a mapper that will not close is a refusal (erasing keyslots under a live
#     mapping, then failing to wipe, is the worst of both);
#   - any other dm-crypt mapper still open on it (a hot-plug droplet-usb-*, a
#     foreign one) is not ours to close, so it is a refusal too;
#   - keyslots that cannot be erased are a refusal: wipefs would then remove only
#     the magic and leave them recoverable.
sw_release_encryption() {
  local dev="$1" stack name left c uuid rc=0
  stack="$(sw_stack_of "$dev")"
  if [ -z "$stack" ]; then
    _sw_warn "cannot list what is stacked on $dev — not closing, erasing or wiping it"
    return 1
  fi
  for name in $(sw_open_bay_mappers "$dev"); do
    if $SW_SUDO cryptsetup close "$name" >/dev/null 2>&1; then
      _sw_say "closed encrypted volume $name"
      SW_BAY_MAPPERS_CLOSED=$((SW_BAY_MAPPERS_CLOSED + 1))
    else
      _sw_warn "could not close encrypted volume $name — something still holds it open"
      return 1
    fi
  done
  left="$(sw_stack_crypt_names "$dev" | tr '\n' ' ')"
  if [ -n "${left// /}" ]; then
    _sw_warn "$dev still has an open encrypted volume ($left) — not a ${SW_BAY_PREFIX}* bay, so not ours to close"
    return 1
  fi
  for c in $(sw_luks_containers "$dev"); do
    uuid="$(sw_luks_uuid "$c")"
    if $SW_SUDO cryptsetup luksErase --batch-mode "$c" >/dev/null 2>&1; then
      _sw_say "crypto-erased the LUKS keyslots on $c"
      SW_CRYPTO_ERASED_COUNT=$((SW_CRYPTO_ERASED_COUNT + 1))
      [ -n "$uuid" ] && SW_CRYPTO_ERASED_UUIDS="$SW_CRYPTO_ERASED_UUIDS $uuid"
    else
      _sw_warn "could not crypto-erase $c (cryptsetup luksErase failed) — its LUKS keyslots are still intact"
      SW_CRYPTO_FAILED_COUNT=$((SW_CRYPTO_FAILED_COUNT + 1))
      rc=1
    fi
  done
  return "$rc"
}

# _sw_shred_file <path> — overwrite-then-unlink one escrowed key file as
# $SW_SUDO (the escrow is root-only). `shred -u`; where that is absent or fails,
# one zero pass over the file's OWN blocks (`conv=notrunc` keeps the extents —
# truncating first would free them and overwrite nothing), then unlink. The same
# shape as secw_shred_file in secrets-wipe.sh, which cannot be reused here: it
# retries under SECW_SUDO, this library has one privilege seam. 0 when gone.
_sw_shred_file() {
  local f="$1" sz blocks
  if command -v shred >/dev/null 2>&1 && $SW_SUDO shred -u "$f" >/dev/null 2>&1; then
    return 0
  fi
  sz="$($SW_SUDO wc -c "$f" 2>/dev/null | awk '{ print $1 }' || true)"
  sz="${sz//[![:digit:]]/}"
  if [ -n "$sz" ] && [ "$sz" -gt 0 ]; then
    blocks=$(( (sz + 4095) / 4096 ))
    $SW_SUDO dd if=/dev/zero "of=$f" bs=4096 "count=$blocks" conv=notrunc >/dev/null 2>&1 || true
  fi
  $SW_SUDO rm -f "$f" >/dev/null 2>&1 || true
  ! $SW_SUDO test -e "$f"
}

# sw_escrow_files <dir> — every file in an escrow dir, one per line. Looks as
# root: the dir is 0700 root. Returns non-zero (and says so) when it exists but
# cannot be listed, so a failure is never mistaken for an empty escrow.
sw_escrow_files() {
  local dir="$1" listing
  if ! { [ -d "$dir" ] || $SW_SUDO test -d "$dir" 2>/dev/null; }; then
    return 0
  fi
  if ! listing="$($SW_SUDO find "$dir" -mindepth 1 -type f 2>/dev/null)"; then
    _sw_warn "could not list the escrowed recovery keys in $dir — remove its contents by hand"
    return 1
  fi
  [ -z "$listing" ] || printf '%s\n' "$listing"
  return 0
}

# sw_bay_state_uuids — every LUKS UUID the box holds bay STATE for: crypttab
# lines and escrowed key files (named `<luks-uuid>__<fs-uuid>.key|.retrieved`).
sw_bay_state_uuids() {
  local dir f base
  {
    sw_crypttab_bay_uuids
    for dir in $SW_BAY_RECOVERY_DIRS; do
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        base="${f##*/}"
        _sw_lc "${base%%__*}"
        printf '\n'
      done < <(sw_escrow_files "$dir" 2>/dev/null || true)
    done
  } | sort -u
  return 0
}

# sw_snapshot_bay_state — record which of those UUIDs are PRESENT on the box
# (a device carries that LUKS UUID right now). Taken before anything is closed
# or wiped, so it never depends on what a wipe left behind in blkid's cache.
sw_snapshot_bay_state() {
  local u
  SW_BAY_PRESENT_UUIDS=""
  for u in $(sw_bay_state_uuids); do
    [ -n "$u" ] || continue
    if $SW_SUDO blkid -U "$u" >/dev/null 2>&1; then
      SW_BAY_PRESENT_UUIDS="$SW_BAY_PRESENT_UUIDS $u"
    fi
  done
  return 0
}

# sw_bay_keep_uuids — the bay LUKS UUIDs whose crypttab line and escrowed key
# must SURVIVE the reset: present when it started, and not crypto-erased by it.
# A drive in that state is still encrypted and still on the box (refused: busy,
# OS disk, a mapper that would not close, a luksErase that failed), and dropping
# its line and key would leave it neither wiped nor openable. State for a drive
# that is gone — erased now, erased by an earlier run, or unplugged — has
# nothing left to protect and goes.
sw_bay_keep_uuids() {
  local u keep=""
  for u in $SW_BAY_PRESENT_UUIDS; do
    case " $SW_CRYPTO_ERASED_UUIDS " in
      *" $u "*) ;;
      *) keep="$keep $u" ;;
    esac
  done
  printf '%s' "$keep"
}

# sw_purge_crypttab <keep-uuid>... — remove every droplet-bay-* line from
# $SW_CRYPTTAB except the kept UUIDs'. Every other line — comments, the /data
# volume's, swap — is carried over verbatim. Rewritten IN PLACE (a temp copy
# `tee`d back over the file) so its mode and owner are preserved, and only when
# there is something to remove. Best-effort-but-loud.
sw_purge_crypttab() {
  local tmp before after
  [ -f "$SW_CRYPTTAB" ] || return 0
  if ! tmp="$(mktemp 2>/dev/null)"; then
    _sw_warn "could not stage a copy of $SW_CRYPTTAB — remove its ${SW_BAY_PREFIX}* lines by hand"
    return 0
  fi
  if ! awk -v p="$SW_BAY_PREFIX" -v keep=" $* " '
       substr($1, 1, length(p)) == p {
         u = ""
         if ($2 ~ /^UUID=/) { u = tolower(substr($2, 6)) }
         else if ($2 ~ /^\/dev\/disk\/by-uuid\//) { u = $2; sub(/^.*\//, "", u); u = tolower(u) }
         if (u != "" && index(keep, " " u " ") > 0) { print }
         next
       }
       { print }
     ' "$SW_CRYPTTAB" > "$tmp" 2>/dev/null; then
    _sw_warn "could not read $SW_CRYPTTAB — remove its ${SW_BAY_PREFIX}* lines by hand"
    rm -f "$tmp"
    return 0
  fi
  if cmp -s "$SW_CRYPTTAB" "$tmp"; then
    rm -f "$tmp"
    return 0
  fi
  before="$(grep -c '' "$SW_CRYPTTAB" 2>/dev/null || true)"
  after="$(grep -c '' "$tmp" 2>/dev/null || true)"
  if $SW_SUDO tee "$SW_CRYPTTAB" < "$tmp" >/dev/null 2>&1; then
    SW_CRYPTTAB_REMOVED=$(( ${before:-0} - ${after:-0} ))
    _sw_say "removed $SW_CRYPTTAB_REMOVED ${SW_BAY_PREFIX}* line(s) from $SW_CRYPTTAB"
  else
    _sw_warn "could not rewrite $SW_CRYPTTAB — remove its ${SW_BAY_PREFIX}* lines by hand"
  fi
  rm -f "$tmp"
  return 0
}

# sw_purge_bay_recovery <keep-uuid>... — overwrite-then-unlink the escrowed
# recovery keys (and `.retrieved` tombstones) in every SW_BAY_RECOVERY_DIRS
# directory, except the kept UUIDs'. Contents only: the directories stay, and the
# host script re-creates them 0700 on demand. A file is judged by the LUKS UUID
# its name starts with; an unrecognisable file in there is removed too. Key
# values are never read or printed (rule 19).
sw_purge_bay_recovery() {
  local keep=" $* " dir f base luks
  for dir in $SW_BAY_RECOVERY_DIRS; do
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      base="${f##*/}"
      luks="$(_sw_lc "${base%%__*}")"
      case "$keep" in *" $luks "*) continue ;; esac
      if _sw_shred_file "$f"; then
        SW_ESCROW_REMOVED=$((SW_ESCROW_REMOVED + 1))
      else
        _sw_warn "could not remove the escrowed recovery key file $f — remove it by hand"
      fi
    done < <(sw_escrow_files "$dir" || true)
  done
  if [ "$SW_ESCROW_REMOVED" -gt 0 ]; then
    _sw_say "removed $SW_ESCROW_REMOVED escrowed recovery-key file(s)"
  fi
  return 0
}

# sw_purge_bay_state — step 3b/3c of the wipe: leave no bay encryption state
# behind. Runs after every erase, so the keep-list reflects what actually
# happened. A drive that stays encrypted is named, never dropped silently.
sw_purge_bay_state() {
  local keep u
  keep="$(sw_bay_keep_uuids)"
  for u in $keep; do
    _sw_warn "keeping the crypttab line and escrowed recovery key for $u — that drive is still encrypted and was NOT erased (see the refusals above)"
  done
  # shellcheck disable=SC2086  # a word list on purpose: one argument per UUID
  sw_purge_crypttab $keep
  # shellcheck disable=SC2086
  sw_purge_bay_recovery $keep
  return 0
}

# --- the wipe ---------------------------------------------------------------

# sw_wipe_droplet_storage — discover and erase Droplet-managed bulk storage.
# Always returns 0: a factory reset must complete. Every refusal and every
# failure is reported, and the caller reports the totals.
# >>> factory-reset storage wipe
sw_wipe_droplet_storage() {
  local mp src md members m skip

  # 0) WARP-3513: note which encrypted bays are on the box BEFORE anything is
  #    closed or wiped (read-only) — step 3b keeps the state of any that survive.
  sw_snapshot_bay_state

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
    if ! sw_unmount "$mp"; then
      [ -n "$src" ] && SW_BUSY_SOURCES="$SW_BUSY_SOURCES $src"
    fi
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
    # A mount we could not release in step 1 means a live writer. Don't even
    # attempt the stop — say so plainly instead of reporting a stop failure
    # whose real cause is two steps back.
    if sw_is_busy_source "/dev/$md"; then
      _sw_warn "refusing: array $md still backs a mount we could not release — not touching it"
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    sw_note_uuid "/dev/$md"
    # WARP-3513: a LUKS pool has its droplet-bay-* mapper over the array. Close
    # it (the stop below is EBUSY while it is up) and crypto-erase the container
    # through the ARRAY's device node — after the stop that node is gone.
    if ! sw_release_encryption "/dev/$md"; then
      _sw_warn "refusing: could not release the encryption on /dev/$md — not stopping it or wiping its members"
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    # Members were captured above, BEFORE --stop removes /sys/block/$md.
    #
    # The stop MUST gate the wipe. `mdadm --stop` genuinely refuses (EBUSY on a
    # mounted or resyncing array), and zeroing superblocks under a still-
    # assembled array does not free its disks — it DEGRADES the mirror, which
    # is the 2026-08-14 lab-box incident this file exists to prevent, reached
    # from a second entry point. Step 3 already refuses on exactly this
    # condition; step 2 now refuses too.
    if ! $SW_SUDO mdadm --stop "/dev/$md" >/dev/null 2>&1; then
      _sw_warn "refusing: could not stop /dev/$md — leaving its members alone"
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    _sw_say "stopped array /dev/$md"
    for m in $members; do
      # Belt and braces: a stop that exits 0 but leaves the array assembled
      # would put us back in the degrade-the-mirror case. sysfs is the
      # authority on whether the disk is actually free, so ask it.
      if sw_is_array_member "$m"; then
        _sw_warn "refusing: $m is still an array member after the stop — not wiping it"
        SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
        continue
      fi
      sw_wipe_device "$m"
    done
  done

  # 3) Any remaining whole disk the box RECORDED as Droplet-managed but that
  #    is no longer mounted or arrayed — the adopted drives. "Recorded" means
  #    automount's trust list (sw_is_droplet_disk), consulted here BEFORE
  #    step 4 truncates it. The old gate — "reports any FSTYPE" — was wider
  #    than this file's own contract: it erased a never-adopted drive that
  #    happened to be plugged in at reset time, and leaned on whether lsblk
  #    reports a bare partition table as an FSTYPE, which varies by
  #    util-linux version. A trusted UUID does not bypass the guards: the
  #    OS-disk check still runs first (the lab box's trust list contains the
  #    ESP and /boot UUIDs).
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
    # Not ours (never adopted, or already erased above so its UUID is gone) —
    # silently out of scope, like the OS disk. WARP-3513: an encrypted bay is
    # also ours — see sw_is_bay_disk — because the trust list holds the UUID of
    # the filesystem inside the container, never the LUKS UUID this node reports.
    sw_is_droplet_disk "$node" || sw_is_bay_disk "$node" || continue
    # A mount we could not release in step 1 means a live writer on this very
    # disk. sw_unmount promised "leaving it and its device alone" — honor it,
    # same refusal step 2 applies to arrays behind busy mounts. (A bay's mount is
    # from its mapper; sw_is_busy_source sees through that.)
    if sw_is_busy_source "$node"; then
      _sw_warn "refusing: $node still backs a mount we could not release — not wiping it"
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    # WARP-3513: close its bay mapper and crypto-erase its LUKS container(s)
    # BEFORE the wipe — wipefs alone leaves the keyslots recoverable, and it is
    # EBUSY while the mapper is open. Failing either, the disk is left as it is.
    if ! sw_release_encryption "$node"; then
      _sw_warn "refusing: could not release the encryption on $node — not wiping it"
      SW_SKIPPED_COUNT=$((SW_SKIPPED_COUNT + 1))
      continue
    fi
    sw_note_uuid "$node"
    sw_wipe_device "$node"
  done

  # 3b) WARP-3513: leave no bay encryption state behind — the droplet-bay-*
  #     crypttab lines and the escrowed recovery keys. After every erase, so the
  #     state of a drive that could NOT be erased is kept (it still needs both).
  sw_purge_bay_state

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
    if [ -n "$u" ] && grep -qF "$u" "$SW_FSTAB" 2>/dev/null; then
      _sw_warn "$SW_FSTAB still references the wiped UUID $u — remove that line or the next boot mounts nothing (silently, under nofail)"
    fi
  done

  return 0
}
# <<< factory-reset storage wipe
