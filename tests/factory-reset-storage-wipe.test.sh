#!/usr/bin/env bash
# =============================================================================
# unit tests for the factory-reset bulk-storage wipe (WARP-1988)
#   scripts/lib/storage-wipe.sh  +  the --keep-storage flag in factory-reset.sh
#
# Defect being pinned: a factory reset erased every Docker volume, secret and
# cert but left the attached data drives completely alone, so a "wiped" box
# still carried its previous storage pool — assembled, mounted, labelled, with
# its filesystem intact. Observed on the lab box 2026-08-13/14; dismantling the
# surviving pool by hand afterwards is what left the array DEGRADED.
#
# These tests need no root, no real disks, no mdadm and no Docker. Every
# external command the wipe touches (findmnt/lsblk/blkid/mdadm/wipefs/umount)
# is stubbed on PATH and records what it was asked to do, and the library's
# documented seams (SW_SYSFS_BLOCK, SW_MDSTAT, SW_MNT_BASE, SW_TRUSTED_LIST,
# SW_FSTAB, SW_TEST_OSDISK, SW_SUDO) point it at a fake tree.
#
# The stub `mdadm --stop` REMOVES the fake /sys/block/<md>/slaves directory —
# exactly the kernel behaviour that made the sibling pool_destroy bug possible
# — so a regression to enumerating members after the stop fails test 3 rather
# than silently zeroing nothing. Mirrors tests/storage-pool-destroy-superblock.test.sh.
#
# Runtime: < 5 seconds.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$REPO_ROOT_REAL/scripts/lib/storage-wipe.sh"
RESET="$REPO_ROOT_REAL/scripts/factory-reset.sh"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ================================================"
echo "  factory-reset — bulk storage wipe (WARP-1988)"
echo "  ================================================"
echo ""

# --- Phase 1: the wiring exists ---------------------------------------------
echo "--- Phase 1: flag + library wiring ---"

if [ -f "$LIB" ]; then
  pass "storage-wipe library exists"
else
  fail "storage-wipe library missing at $LIB"
  echo "FAILURES=$FAILURES"; exit 1
fi

if grep -qF -- '--keep-storage)   KEEP_STORAGE=true' "$RESET"; then
  pass "factory-reset parses --keep-storage"
else
  fail "factory-reset does not parse --keep-storage"
fi

# The whole point of the change: the wipe is the DEFAULT, opt-out. If this ever
# flips back to opt-in the shipped box keeps its old pool again.
if grep -qF 'KEEP_STORAGE=false' "$RESET"; then
  pass "storage wipe defaults ON (KEEP_STORAGE=false)"
else
  fail "storage wipe is not defaulted ON"
fi

if grep -qF 'sw_wipe_droplet_storage' "$RESET"; then
  pass "factory-reset calls the wipe"
else
  fail "factory-reset never calls sw_wipe_droplet_storage"
fi

if "$RESET" --help 2>/dev/null | grep -qF -- '--keep-storage'; then
  pass "--keep-storage is documented in --help"
else
  fail "--keep-storage missing from --help output"
fi

# --- Fixture ----------------------------------------------------------------
# A box shaped like the real one: NVMe OS disk (nvme0n1, LVM root) plus two
# 2 TB spinners in an md pool, mounted under /mnt/droplet.
make_fixture() {
  TMP="$(mktemp -d)"
  export TMP
  mkdir -p "$TMP/bin" "$TMP/sys/block/md0/slaves" "$TMP/mnt/droplet/mass-storage-cadf51ee"
  : > "$TMP/sys/block/md0/slaves/sda"
  : > "$TMP/sys/block/md0/slaves/sdb"
  printf 'md0 : active raid1 sda[2] sdb[1]\n      1953382464 blocks super 1.2 [2/2] [UU]\n' \
    > "$TMP/mdstat"
  # TARGET<TAB>SOURCE
  printf '%s\t%s\n' "$TMP/mnt/droplet/mass-storage-cadf51ee" "/dev/md0" > "$TMP/mounts"
  # NAME<TAB>TYPE<TAB>FSTYPE
  printf 'sda\tdisk\tlinux_raid_member\nsdb\tdisk\tlinux_raid_member\nnvme0n1\tdisk\tLVM2_member\n' \
    > "$TMP/disks"
  # The OS mounts, exactly the shape the real box has: an LVM root on NVMe
  # plus a separate /boot and ESP partition on the SAME physical disk. This is
  # what makes the guard non-trivial — a bare PKNAME lookup on the LVM root
  # returns the PARTITION and never reaches nvme0n1.
  # MOUNTPOINT<TAB>SOURCE
  printf '/\t/dev/mapper/ubuntu--vg-ubuntu--lv\n/boot\t/dev/nvme0n1p2\n/boot/efi\t/dev/nvme0n1p1\n' \
    > "$TMP/osmounts"
  # DEV<TAB>backing TYPE=disk leaves (what `lsblk -nso NAME,TYPE` walks to)
  cat > "$TMP/ancestors" <<ANC
/dev/md0	sda sdb
/dev/sda	sda
/dev/sdb	sdb
/dev/nvme0n1	nvme0n1
/dev/nvme0n1p1	nvme0n1
/dev/nvme0n1p2	nvme0n1
/dev/mapper/ubuntu--vg-ubuntu--lv	nvme0n1
ANC
  # The trust list as pool_format/drive_adopt/the boot reconcile actually
  # leave it: the pool's fs UUID, one per line. Step 3's scope is exactly
  # this file, and the "trust list is cleared" test below is only meaningful
  # when the list starts non-empty.
  printf 'cadf51ee-d482-4984-a5b9-a9c47028f9e8\n' > "$TMP/trusted.list"
  printf 'UUID=cadf51ee-d482-4984-a5b9-a9c47028f9e8 /mnt/droplet/mass-storage-cadf51ee ext4 defaults,nofail 0 2\n' \
    > "$TMP/fstab"
  # DEV<TAB>fs UUID (what `blkid -o value -s UUID <dev>` answers). Only /dev/md0
  # carries one out of the box: raid members expose no fs UUID of their own,
  # and the OS disk's UUIDs are never asked for.
  printf '/dev/md0\tcadf51ee-d482-4984-a5b9-a9c47028f9e8\n' > "$TMP/uuids"
  : > "$TMP/calls"
  : > "$TMP/busy"

  cat > "$TMP/bin/findmnt" <<'STUB'
#!/usr/bin/env bash
# -rn -o TARGET                     → every mountpoint
# -rn -o SOURCE --mountpoint <mp>   → that mount's source
# -rn -o SOURCE --target <mp>       → the OS mounts (/, /boot, /boot/efi)
MODE=all
for a in "$@"; do
  case "$a" in --mountpoint) MODE=mp ;; --target) MODE=target ;; esac
done
case "$MODE" in
  mp)     awk -F'\t' -v t="${!#}" '$1 == t { print $2 }' "$TMP/mounts" ;;
  target) awk -F'\t' -v t="${!#}" '$1 == t { print $2 }' "$TMP/osmounts" ;;
  all)    cut -f1 "$TMP/mounts" ;;
esac
STUB

  cat > "$TMP/bin/lsblk" <<'STUB'
#!/usr/bin/env bash
# -nso NAME,TYPE <dev>  → the TYPE=disk leaves backing <dev> (ancestor walk)
# -ndo NAME,TYPE        → every whole disk
# -ndo FSTYPE <dev>     → that disk's fs signature
case "$*" in
  -nso*)
    for d in $(awk -F'\t' -v k="${!#}" '$1 == k { print $2 }' "$TMP/ancestors"); do
      printf '%s disk\n' "$d"
    done
    ;;
  *FSTYPE*) awk -F'\t' -v d="$(basename "${!#}")" '$1 == d { print $3 }' "$TMP/disks" ;;
  *"NAME,TYPE"*) awk -F'\t' '{ print $1"\t"$2 }' "$TMP/disks" ;;
esac
STUB

  cat > "$TMP/bin/blkid" <<'STUB'
#!/usr/bin/env bash
awk -F'\t' -v d="${!#}" '$1 == d { print $2 }' "$TMP/uuids"
STUB

  # --stop removes the slaves dir, exactly as the kernel does.
  cat > "$TMP/bin/mdadm" <<'STUB'
#!/usr/bin/env bash
echo "mdadm $*" >> "$TMP/calls"
case "$1" in
  --stop) rm -rf "$TMP/sys/block/$(basename "$2")/slaves" ;;
esac
exit 0
STUB

  # A real wipefs clears the signature, so the disk no longer reports an
  # FSTYPE. Model that, otherwise the standalone-disk sweep re-wipes members
  # the array teardown already handled and the call counts below are fiction.
  cat > "$TMP/bin/wipefs" <<'STUB'
#!/usr/bin/env bash
echo "wipefs $*" >> "$TMP/calls"
d="$(basename "${!#}")"
awk -F'\t' -v d="$d" 'BEGIN{OFS="\t"} $1 == d { $3 = "" } { print }' "$TMP/disks" > "$TMP/disks.new"
mv "$TMP/disks.new" "$TMP/disks"
# ...and its fs UUID goes with the signature — blkid answers nothing after.
awk -F'\t' -v d="/dev/$d" '$1 != d' "$TMP/uuids" > "$TMP/uuids.new"
mv "$TMP/uuids.new" "$TMP/uuids"
exit 0
STUB

  cat > "$TMP/bin/umount" <<'STUB'
#!/usr/bin/env bash
echo "umount $*" >> "$TMP/calls"
grep -qxF "$1" "$TMP/busy" && exit 1
grep -v -F "$1" "$TMP/mounts" > "$TMP/mounts.new" || true
mv "$TMP/mounts.new" "$TMP/mounts"
exit 0
STUB

  chmod +x "$TMP/bin/"*
  PATH="$TMP/bin:$PATH"
  export PATH
  SW_SYSFS_BLOCK="$TMP/sys/block"
  SW_MDSTAT="$TMP/mdstat"
  SW_MNT_BASE="$TMP/mnt/droplet"
  SW_TRUSTED_LIST="$TMP/trusted.list"
  SW_FSTAB="$TMP/fstab"
  SW_SUDO=""
  # The prompt tests exec factory-reset.sh, whose logging.sh would otherwise
  # append to <repo>/.data/setup.log — keep test side-effects inside $TMP.
  LOG_FILE="$TMP/setup.log"
  export SW_SYSFS_BLOCK SW_MDSTAT SW_MNT_BASE SW_TRUSTED_LIST SW_FSTAB SW_SUDO LOG_FILE
  unset SW_TEST_OSDISK
  # shellcheck disable=SC1090
  source "$LIB"
}

# os_disk_member <disk> — re-point a fixture disk at the OS disk, so the REAL
# sw_is_os_disk guard (not the test seam) has to catch it.
os_disk_member() {
  grep -v "^/dev/$1[[:space:]]" "$TMP/ancestors" > "$TMP/a.tmp"
  printf '/dev/%s\tnvme0n1\n' "$1" >> "$TMP/a.tmp"
  mv "$TMP/a.tmp" "$TMP/ancestors"
}

# add_disk <name> <fstype> <uuid> [trusted] — attach a standalone whole disk to
# the fixture (its own backing disk, no array, no mount). "trusted" also puts
# its fs UUID on the automount trust list — i.e. the box ADOPTED this drive at
# some point (drive_adopt/pool_format seed the list; the reconcile re-seeds it
# every boot). Without "trusted" it models a drive the box never managed:
# a customer's own disk that happens to be plugged in at reset time.
add_disk() {
  printf '%s\tdisk\t%s\n' "$1" "$2" >> "$TMP/disks"
  printf '/dev/%s\t%s\n' "$1" "$1" >> "$TMP/ancestors"
  printf '/dev/%s\t%s\n' "$1" "$3" >> "$TMP/uuids"
  if [ "${4:-}" = "trusted" ]; then
    printf '%s\n' "$3" >> "$TMP/trusted.list"
  fi
  return 0
}

# stub_docker — factory-reset.sh probes `docker compose version` before the
# confirmation prompt; stub it so the prompt tests reach the banner on a
# runner with no Docker.
stub_docker() {
  cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$TMP/bin/docker"
}

# --- Phase 2: the happy path ------------------------------------------------
echo ""
echo "--- Phase 2: a Droplet pool is actually erased ---"

( make_fixture
  sw_wipe_droplet_storage >/dev/null 2>&1

  grep -qF "mdadm --stop /dev/md0" "$TMP/calls" || { echo "NOSTOP"; exit 1; }
  grep -qF "mdadm --zero-superblock /dev/sda" "$TMP/calls" || { echo "NOZEROA"; exit 1; }
  grep -qF "mdadm --zero-superblock /dev/sdb" "$TMP/calls" || { echo "NOZEROB"; exit 1; }
  grep -qF "wipefs -a /dev/sda" "$TMP/calls" || { echo "NOWIPEA"; exit 1; }
  grep -qF "wipefs -a /dev/sdb" "$TMP/calls" || { echo "NOWIPEB"; exit 1; }
) >/dev/null 2>&1 && pass "array stopped, both members zeroed and wiped" \
                 || fail "array teardown incomplete"

( make_fixture
  sw_wipe_droplet_storage >/dev/null 2>&1
  grep -qF "umount $TMP/mnt/droplet/mass-storage-cadf51ee" "$TMP/calls"
) >/dev/null 2>&1 && pass "the pool mount is released first" \
                 || fail "pool mount was never unmounted"

( make_fixture
  sw_wipe_droplet_storage >/dev/null 2>&1
  [ ! -s "$TMP/trusted.list" ]
) >/dev/null 2>&1 && pass "automount trust list is cleared" \
                 || fail "trust list survived the wipe"

# --- Phase 3: members captured BEFORE --stop --------------------------------
echo ""
echo "--- Phase 3: members are captured before the array is stopped ---"

# The stub --stop deletes the slaves dir. If the implementation ever moves the
# sw_md_members call to after the stop, it enumerates nothing and zeroes
# nothing — the array silently re-assembles on the next boot.
( make_fixture
  sw_wipe_droplet_storage >/dev/null 2>&1
  n="$(grep -c 'zero-superblock' "$TMP/calls" || true)"
  [ "$n" -eq 2 ]
) >/dev/null 2>&1 && pass "both superblocks zeroed after --stop removed sysfs" \
                 || fail "superblocks not zeroed — members were read after --stop"

# --- Phase 4: the OS disk is never in scope ---------------------------------
echo ""
echo "--- Phase 4: OS/boot disk refusals ---"

# These exercise the REAL guard (no SW_TEST_OSDISK): the fixture's root is an
# LVM volume whose only backing disk is nvme0n1, and /boot + the ESP are
# partitions of that same disk.

# An array with a member on the OS disk must be refused WHOLE, not partly torn
# down — a half-stopped array is worse than an untouched one.
( make_fixture
  os_disk_member sda
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -q "mdadm --stop" "$TMP/calls" && ! grep -q "zero-superblock" "$TMP/calls"
) >/dev/null 2>&1 && pass "array with an OS-disk member is refused whole" \
                 || fail "an array containing the OS disk was torn down"

# ...and the standalone-disk sweep must not wipe it either.
( make_fixture
  os_disk_member sda
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -qF "wipefs -a /dev/sda" "$TMP/calls"
) >/dev/null 2>&1 && pass "the OS disk itself is never wipefs-ed" \
                 || fail "wipefs was run on the OS disk"

# The regression this change's own first draft shipped: when an array is
# refused, its OTHER member is still an assembled md member. The standalone
# sweep must not wipefs it — that does not free the disk, it DEGRADES the
# mirror, which is exactly how the lab box lost a leg on 2026-08-14.
( make_fixture
  os_disk_member sda
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -qF "wipefs -a /dev/sdb" "$TMP/calls"
) >/dev/null 2>&1 && pass "a still-assembled array member is never wiped standalone" \
                 || fail "wipefs degraded a live array by wiping one member"

# A mount under /mnt/droplet backed by the OS disk must be left mounted. This
# is the automount-trust-list trap made concrete: on the real box that list
# contains the ESP and /boot UUIDs, so "whatever automount manages" is NOT a
# safe scope — backing-disk identity is.
( make_fixture
  printf '%s\t%s\n' "$TMP/mnt/droplet/drive-13EE-1E3" "/dev/nvme0n1p1" >> "$TMP/mounts"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -qF "umount $TMP/mnt/droplet/drive-13EE-1E3" "$TMP/calls"
) >/dev/null 2>&1 && pass "an OS-backed mount under /mnt/droplet is not unmounted" \
                 || fail "the boot partition was unmounted by the wipe"

# Unresolvable device → fail closed (treated as OS disk).
( make_fixture
  unset SW_TEST_OSDISK
  cat > "$TMP/bin/lsblk" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$TMP/bin/lsblk"
  sw_is_os_disk /dev/sdz
) >/dev/null 2>&1 && pass "an unresolvable device fails CLOSED (treated as OS disk)" \
                 || fail "unresolvable device was treated as safe to wipe"

# --- Phase 5: busy mounts and fstab ------------------------------------------
echo ""
echo "--- Phase 5: busy mounts, fstab warning ---"

# A busy mount must NOT be lazy-detached and then wiped underneath a writer.
( make_fixture
  echo "$TMP/mnt/droplet/mass-storage-cadf51ee" > "$TMP/busy"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -qE 'umount .*-l' "$TMP/calls"
) >/dev/null 2>&1 && pass "a busy mount is never lazy-unmounted" \
                 || fail "the wipe fell back to a lazy unmount"

( make_fixture
  out="$(sw_wipe_droplet_storage 2>&1)"
  printf '%s' "$out" | grep -qF "cadf51ee-d482-4984-a5b9-a9c47028f9e8"
) >/dev/null 2>&1 && pass "warns that fstab still names the wiped UUID" \
                 || fail "no warning for the dead nofail fstab entry"

# The reset must survive a drive that refuses to release.
( make_fixture
  echo "$TMP/mnt/droplet/mass-storage-cadf51ee" > "$TMP/busy"
  sw_wipe_droplet_storage >/dev/null 2>&1
) >/dev/null 2>&1 && pass "wipe returns 0 even when a target is skipped" \
                 || fail "a skipped target aborted the wipe (reset would half-finish)"

# --- Phase 6: a refused --stop must gate the member wipe ---------------------
echo ""
echo "--- Phase 6: a failed array stop leaves its members alone ---"

# stop_fails — mdadm --stop exits non-zero and, like a real EBUSY refusal,
# leaves /sys/block/<md>/slaves in place. Every other subcommand still works.
# The shipped suite's stub always succeeded, so this whole path was uncovered.
stop_fails() {
  cat > "$TMP/bin/mdadm" <<'STUB'
#!/usr/bin/env bash
echo "mdadm $*" >> "$TMP/calls"
case "$1" in
  --stop) exit 1 ;;
esac
exit 0
STUB
  chmod +x "$TMP/bin/mdadm"
}

# The critical one. `mdadm --stop` refusing (array mounted or resyncing) used
# to select a warning message and then fall straight into the member loop:
# zero-superblock + wipefs against every member of a STILL-ASSEMBLED array.
# That does not free the disks, it degrades the mirror — the 2026-08-14 lab-box
# incident reached from a second entry point.
( make_fixture
  stop_fails
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -q "zero-superblock" "$TMP/calls"
) >/dev/null 2>&1 && pass "a failed --stop zeroes no superblocks" \
                 || fail "superblocks were zeroed under a still-assembled array"

( make_fixture
  stop_fails
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -qF "wipefs -a /dev/sda" "$TMP/calls" \
    && ! grep -qF "wipefs -a /dev/sdb" "$TMP/calls"
) >/dev/null 2>&1 && pass "a failed --stop wipes no members" \
                 || fail "wipefs ran on members of an array that never stopped"

# ...and it must say so, not report a bare warning and continue silently.
( make_fixture
  stop_fails
  out="$(sw_wipe_droplet_storage 2>&1)"
  printf '%s' "$out" | grep -qF "refusing: could not stop /dev/md0"
) >/dev/null 2>&1 && pass "a failed --stop is reported as a refusal" \
                 || fail "the failed stop was not surfaced as a refusal"

# The reset must still finish — a refusal is not an abort.
( make_fixture
  stop_fails
  sw_wipe_droplet_storage >/dev/null 2>&1
) >/dev/null 2>&1 && pass "wipe returns 0 when an array refuses to stop" \
                 || fail "a failed stop aborted the wipe"

# Compounding case: step 1 and step 2 used to share no state, so a pool that
# refused to unmount was still handed to --stop — busy by definition.
( make_fixture
  echo "$TMP/mnt/droplet/mass-storage-cadf51ee" > "$TMP/busy"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -q "mdadm --stop" "$TMP/calls" && ! grep -q "zero-superblock" "$TMP/calls"
) >/dev/null 2>&1 && pass "an array behind a busy mount is never torn down" \
                 || fail "a busy pool's array was stopped/wiped anyway"

# Belt and braces: a stop that exits 0 but leaves the array assembled must not
# reach the member wipe either — sysfs, not the exit code, is the authority.
( make_fixture
  cat > "$TMP/bin/mdadm" <<'STUB'
#!/usr/bin/env bash
echo "mdadm $*" >> "$TMP/calls"
exit 0
STUB
  chmod +x "$TMP/bin/mdadm"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -q "zero-superblock" "$TMP/calls"
) >/dev/null 2>&1 && pass "a lying --stop (exit 0, still assembled) wipes nothing" \
                 || fail "members were wiped while sysfs still listed them"

# The OS-mount side of sw_is_os_disk must fail closed too. When lsblk cannot
# resolve /'s own source, the old fallback compared a partition basename
# against TYPE=disk names — a comparison that can never match, so every
# candidate silently passed the guard.
( make_fixture
  unset SW_TEST_OSDISK
  # Resolves every device EXCEPT /'s own LVM source — the transient dm/partition
  # lookup failure the fallback was there to paper over. The candidate (sda)
  # still resolves, so this isolates the OS-mount side of the guard.
  cat > "$TMP/bin/lsblk" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  -nso*)
    [ "${!#}" = "/dev/mapper/ubuntu--vg-ubuntu--lv" ] && exit 0
    for d in $(awk -F'\t' -v k="${!#}" '$1 == k { print $2 }' "$TMP/ancestors"); do
      printf '%s disk\n' "$d"
    done
    ;;
esac
exit 0
STUB
  chmod +x "$TMP/bin/lsblk"
  sw_is_os_disk /dev/sda
) >/dev/null 2>&1 && pass "an unresolvable OS mount fails CLOSED" \
                 || fail "an unresolvable OS mount let a candidate through"

# --- Phase 7: step 3 wipes ONLY what the box recorded as Droplet-managed -----
echo ""
echo "--- Phase 7: the standalone sweep is scoped to the automount trust list ---"

# The positive case: a drive the box ADOPTED (fs UUID on the trust list) that
# is attached but not mounted and not in an array — exactly the step-3
# customer. It must be erased. This also pins the read-before-truncate
# ordering: step 4 truncates the trust list, so a step 3 that consulted the
# list after truncation would find nothing trusted and wipe nothing.
( make_fixture
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa" trusted
  sw_wipe_droplet_storage >/dev/null 2>&1
  grep -qF "wipefs -a /dev/sdc" "$TMP/calls" \
    && grep -qF "mdadm --zero-superblock /dev/sdc" "$TMP/calls"
) >/dev/null 2>&1 && pass "an adopted (trust-listed) unmounted drive is erased" \
                 || fail "the adopted unmounted drive survived — step 3 lost its positive case"

# The blast-radius case the review flagged: a disk the box NEVER adopted — a
# customer's own drive plugged in at reset time. It carries a filesystem, it
# is not the OS disk, it is not in an array, and under the old FSTYPE-only
# gate step 3 erased it. It must SURVIVE: "Droplet-managed" means what the
# box recorded as managed, not "anything with a signature".
( make_fixture
  add_disk sdd ntfs "01D9432EBCE2F260"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -qF "wipefs -a /dev/sdd" "$TMP/calls" \
    && ! grep -qF "mdadm --zero-superblock /dev/sdd" "$TMP/calls"
) >/dev/null 2>&1 && pass "a never-adopted disk survives the wipe" \
                 || fail "step 3 erased a disk the box never managed"

# Whether `lsblk -ndo FSTYPE` reports a partition-table-only disk as empty is
# util-linux-version-dependent — the trust-list gate must make that variance
# irrelevant. A partitioned foreign disk has no whole-disk fs UUID, so it can
# never match the list, whatever lsblk says its FSTYPE is.
( make_fixture
  add_disk sde gpt ""
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -qF "wipefs -a /dev/sde" "$TMP/calls"
) >/dev/null 2>&1 && pass "a partition-table-only disk survives (lsblk FSTYPE variance is moot)" \
                 || fail "a bare partition table was enough for step 3 to erase the disk"

# An adopted drive whose mount refused to release has a live writer on it.
# sw_unmount's own warning promises "leaving it and its device alone" — step 3
# must honor that, not wipe the device out from under the writer.
( make_fixture
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa" trusted
  printf '%s\t%s\n' "$TMP/mnt/droplet/drive-7a30be6e" "/dev/sdc" >> "$TMP/mounts"
  echo "$TMP/mnt/droplet/drive-7a30be6e" > "$TMP/busy"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -qF "wipefs -a /dev/sdc" "$TMP/calls"
) >/dev/null 2>&1 && pass "a trusted drive behind a busy mount is left alone" \
                 || fail "step 3 wiped a device whose mount never released"

# --- Phase 8: the prompt names every step-3 target ---------------------------
echo ""
echo "--- Phase 8: the confirmation prompt names the step-3 drives ---"

# sw_standalone_droplet_disks is what the prompt threads in: the disks ONLY
# step 3 will erase. Pool members and mounted drives are already named by
# sw_assembled_arrays / sw_droplet_mounts.
( make_fixture
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa" trusted
  add_disk sdd ntfs "01D9432EBCE2F260"
  [ "$(sw_standalone_droplet_disks)" = "/dev/sdc" ]
) >/dev/null 2>&1 && pass "standalone candidates: exactly the unmounted adopted drive" \
                 || fail "sw_standalone_droplet_disks named the wrong disks"

# A mounted adopted drive is already named by its mountpoint — listing its
# device node again would read as a THIRD drive to the operator.
( make_fixture
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa" trusted
  printf '%s\t%s\n' "$TMP/mnt/droplet/drive-7a30be6e" "/dev/sdc" >> "$TMP/mounts"
  [ -z "$(sw_standalone_droplet_disks)" ]
) >/dev/null 2>&1 && pass "a mounted adopted drive is not double-named" \
                 || fail "a drive already named by its mountpoint was listed again"

# The contract the review held the prompt to: name the drives BEFORE the
# operator types RESET. A drive only step 3 touches used to be erased without
# ever being named. Run the real script up to the prompt, decline, and check
# the banner named the step-3 target.
( make_fixture
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa" trusted
  stub_docker
  out="$(printf 'no\n' | "$RESET" 2>&1 || true)"
  printf '%s' "$out" | grep -qF "/dev/sdc"
) >/dev/null 2>&1 && pass "the RESET prompt names the unmounted adopted drive" \
                 || fail "a step-3 drive was never named before the operator types RESET"

# Declining the prompt must leave every device untouched — the banner's
# discovery pass is read-only (the calls log only records mutating stubs).
( make_fixture
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa" trusted
  stub_docker
  printf 'no\n' | "$RESET" >/dev/null 2>&1 || true
  [ ! -s "$TMP/calls" ]
) >/dev/null 2>&1 && pass "declining the prompt runs no mutating command" \
                 || fail "the prompt's discovery pass touched a device"

# --- Summary -----------------------------------------------------------------
echo ""
echo "  ------------------------------------------------"
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mAll %d tests passed\033[0m\n" "$TESTS"
else
  printf "  \033[31m%d of %d tests FAILED\033[0m\n" "$FAILURES" "$TESTS"
fi
echo "  ------------------------------------------------"
echo ""

[ "$FAILURES" -eq 0 ]
