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
# SW_FSTAB, SW_TEST_OSDISK, SW_SUDO, and for the encrypted bays SW_CRYPTTAB and
# SW_BAY_RECOVERY_DIRS) point it at a fake tree.
#
# The stub `mdadm --stop` REMOVES the fake /sys/block/<md>/slaves directory —
# exactly the kernel behaviour that made the sibling pool_destroy bug possible
# — so a regression to enumerating members after the stop fails test 3 rather
# than silently zeroing nothing. Mirrors tests/storage-pool-destroy-superblock.test.sh.
#
# WARP-3513 (Phase 9+): every prepared bay drive is now LUKS2. wipefs alone only
# removes the LUKS magic — the keyslots and the TPM-sealed key stay recoverable by
# re-writing the signature — so a reset must CRYPTO-ERASE (`cryptsetup luksErase`)
# every container it erases, close the droplet-bay-* mapper that holds it open
# first (wipefs / `mdadm --stop` hit EBUSY otherwise), and leave no bay
# encryption state behind: no crypttab line, no escrowed recovery key. The stubs
# model the kernel's refusals (EBUSY while a mapper is stacked on a device), so a
# regression that skips the close fails here instead of passing on call order.
#
# Runtime: < 5 seconds on Linux (fork-bound: minutes on a loaded Windows Git Bash).
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
  # WARP-3513 tables (empty unless a test builds an encrypted bay with add_bay /
  # encrypt_pool below):
  #   types        DEV<TAB>blkid TYPE            (crypto_LUKS, ext4)
  #   stack        DEV<TAB>child<TAB>child TYPE  (what `lsblk -rnpo NAME,TYPE DEV`
  #                                               lists UNDER the device: the mapper)
  #   busy_mappers one mapper name per line whose `cryptsetup close` refuses
  #   luks_fail    one device per line whose `cryptsetup luksErase` fails
  #   erased       devices luksErase succeeded on, wiped: devices wipefs cleared
  : > "$TMP/types"
  : > "$TMP/stack"
  : > "$TMP/busy_mappers"
  : > "$TMP/luks_fail"
  : > "$TMP/erased"
  : > "$TMP/wiped"

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
# -[r]nso NAME,TYPE <dev>  → the TYPE=disk leaves backing <dev> (inverse walk).
#                            Like the real tool it draws a TREE unless -r is given:
#                            a leaf below the first line is printed "  └─name",
#                            and `awk '{ print $1 }'` then yields "└─name".
# -rnpo NAME,TYPE <dev>    → <dev> and everything stacked ON it (WARP-3513: the
#                            droplet-bay-* mapper over a disk or an md array)
# -ndo NAME,TYPE           → every whole disk
# -ndo FSTYPE <dev>        → that disk's fs signature
case "$*" in
  -rnso*|-nso*)
    dev="${!#}"
    case "$1" in -*r*) raw=1 ;; *) raw=0 ;; esac
    for d in $(awk -F'\t' -v k="$dev" '$1 == k { print $2 }' "$TMP/ancestors"); do
      if [ "$raw" = 1 ] || [ "$d" = "$(basename "$dev")" ]; then
        printf '%s disk\n' "$d"
      else
        printf '  └─%s disk\n' "$d"
      fi
    done
    ;;
  -rnpo*)
    dev="${!#}"
    case "$dev" in
      /dev/md*)     t=raid1 ;;
      /dev/mapper/*) t=crypt ;;
      *)            t=disk ;;
    esac
    printf '%s %s\n' "$dev" "$t"
    awk -F'\t' -v k="$dev" '$1 == k { print $2 " " $3 }' "$TMP/stack"
    ;;
  *FSTYPE*) awk -F'\t' -v d="$(basename "${!#}")" '$1 == d { print $3 }' "$TMP/disks" ;;
  *"NAME,TYPE"*) awk -F'\t' '{ print $1"\t"$2 }' "$TMP/disks" ;;
esac
STUB

  # blkid [-p] -o value -s UUID|TYPE <dev>  → that device's UUID / TYPE
  # blkid [-p] -o value -U <uuid>           → the device carrying it; exit 2 and no
  #                                           output when none does (the real tool)
  cat > "$TMP/bin/blkid" <<'STUB'
#!/usr/bin/env bash
field=UUID
byuuid=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    -s) field="${args[$((i + 1))]}" ;;
    -U) byuuid="${args[$((i + 1))]}" ;;
  esac
done
if [ -n "$byuuid" ]; then
  dev="$(awk -F'\t' -v u="$byuuid" '$2 == u { print $1; exit }' "$TMP/uuids")"
  [ -n "$dev" ] || exit 2
  printf '%s\n' "$dev"
  exit 0
fi
case "$field" in
  TYPE) awk -F'\t' -v d="${!#}" '$1 == d { print $2 }' "$TMP/types" ;;
  *)    awk -F'\t' -v d="${!#}" '$1 == d { print $2 }' "$TMP/uuids" ;;
esac
STUB

  # --stop removes the slaves dir, exactly as the kernel does — and, like the
  # kernel, refuses (EBUSY) while a dm-crypt mapper is still stacked on the array.
  cat > "$TMP/bin/mdadm" <<'STUB'
#!/usr/bin/env bash
echo "mdadm $*" >> "$TMP/calls"
case "$1" in
  --stop)
    if awk -F'\t' -v k="$2" '$1 == k && $3 == "crypt" { f = 1 } END { exit !f }' "$TMP/stack"; then
      echo "mdadm: Cannot get exclusive access to $2: Perhaps a running process, mounted filesystem or active volume group?" >&2
      exit 1
    fi
    rm -rf "$TMP/sys/block/$(basename "$2")/slaves" ;;
esac
exit 0
STUB

  # A real wipefs clears the signature, so the disk no longer reports an
  # FSTYPE. Model that, otherwise the standalone-disk sweep re-wipes members
  # the array teardown already handled and the call counts below are fiction.
  # It also refuses (EBUSY) a device with a dm-crypt mapper stacked on it.
  cat > "$TMP/bin/wipefs" <<'STUB'
#!/usr/bin/env bash
echo "wipefs $*" >> "$TMP/calls"
dev="${!#}"
if awk -F'\t' -v k="$dev" '$1 == k && $3 == "crypt" { f = 1 } END { exit !f }' "$TMP/stack"; then
  echo "wipefs: error: $dev: probing initialization failed: Device or resource busy" >&2
  exit 1
fi
d="$(basename "$dev")"
awk -F'\t' -v d="$d" 'BEGIN{OFS="\t"} $1 == d { $3 = "" } { print }' "$TMP/disks" > "$TMP/disks.new"
mv "$TMP/disks.new" "$TMP/disks"
# ...and its fs UUID goes with the signature — blkid answers nothing after.
awk -F'\t' -v d="/dev/$d" '$1 != d' "$TMP/uuids" > "$TMP/uuids.new"
mv "$TMP/uuids.new" "$TMP/uuids"
awk -F'\t' -v d="/dev/$d" '$1 != d' "$TMP/types" > "$TMP/types.new"
mv "$TMP/types.new" "$TMP/types"
echo "$dev" >> "$TMP/wiped"
exit 0
STUB

  # cryptsetup close <name> / luksErase --batch-mode <dev>. Models what the real
  # tool refuses: a mapper that is still MOUNTED (or listed in busy_mappers) will
  # not close, and keyslots cannot be erased under an open mapping. STRICT_SUDO
  # (set by use_strict_sudo) models a non-root caller: the call must arrive via
  # the sudo stub.
  cat > "$TMP/bin/cryptsetup" <<'STUB'
#!/usr/bin/env bash
echo "cryptsetup $*" >> "$TMP/calls"
if [ -n "${STRICT_SUDO:-}" ] && [ -z "${VIA_SUDO:-}" ]; then
  echo "cryptsetup: permission denied (not root)" >&2
  exit 1
fi
case "$1" in
  close)
    if grep -qxF "$2" "$TMP/busy_mappers" || awk -F'\t' -v s="/dev/mapper/$2" '$2 == s { f = 1 } END { exit !f }' "$TMP/mounts"; then
      echo "Device $2 is still in use." >&2
      exit 5
    fi
    awk -F'\t' -v n="/dev/mapper/$2" '$2 != n' "$TMP/stack" > "$TMP/stack.new"
    mv "$TMP/stack.new" "$TMP/stack"
    exit 0 ;;
  luksErase)
    dev="${!#}"
    if awk -F'\t' -v k="$dev" '$1 == k && $3 == "crypt" { f = 1 } END { exit !f }' "$TMP/stack"; then
      echo "Device $dev is in use." >&2
      exit 5
    fi
    grep -qxF "$dev" "$TMP/luks_fail" && exit 1
    echo "$dev" >> "$TMP/erased"
    exit 0 ;;
esac
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
  # WARP-3513: the encrypted-bay state the reset must not leave behind. Pointed
  # inside $TMP for EVERY test — a run that fell through to the real
  # /etc/crypttab or /data/droplet/secrets/bay-recovery would rewrite a box.
  SW_CRYPTTAB="$TMP/crypttab"
  SW_BAY_RECOVERY_DIRS="$TMP/recovery-data $TMP/recovery-var"
  SW_SUDO=""
  # The prompt tests exec factory-reset.sh, whose logging.sh would otherwise
  # append to <repo>/.data/setup.log — keep test side-effects inside $TMP.
  LOG_FILE="$TMP/setup.log"
  export SW_SYSFS_BLOCK SW_MDSTAT SW_MNT_BASE SW_TRUSTED_LIST SW_FSTAB SW_SUDO LOG_FILE
  export SW_CRYPTTAB SW_BAY_RECOVERY_DIRS
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
  -rnso*|-nso*)
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

# =============================================================================
# WARP-3513 — encrypted bays
# =============================================================================
# Every drive prepared through the dashboard is now LUKS2 on the whole disk (or
# on the md array of a pool): disk -> LUKS container -> /dev/mapper/droplet-bay-
# <luks8> -> ext4 mounted at /mnt/droplet/<label>-<fs8>. The box also holds a
# crypttab line for it and a ROOT-ONLY escrow of its recovery key. A reset that
# only wipefs-ed it would leave the keyslots (and the TPM-sealed key) intact.

# Obviously-fake identifiers. NOTHING here is a real key: the escrowed "recovery
# key" is a marker string, grepped for in the output (rule 19).
BAY_LUKS_A="1a2b3c4d-1111-4222-8333-444444444444"   # LUKS container -> droplet-bay-1a2b3c4d
BAY_FS_A="ab12cd34-5555-4666-8777-888888888888"     # ext4 inside    -> drive-ab12cd34
BAY_LUKS_B="9f8e7d6c-1111-4222-8333-444444444444"
BAY_FS_B="0f1e2d3c-5555-4666-8777-888888888888"
FAKE_RECOVERY_KEY='FAKE-recovery-key-warp3513-do-not-use'
CRYPTTAB_BAY_OPTS='none tpm2-device=auto,luks,discard,nofail,headless=true,x-systemd.device-timeout=30s'

# add_bay <disk> <luks-uuid> <fs-uuid> [open|locked] — a drive WARP-3513 prepared:
# LUKS on the whole disk (so blkid answers the LUKS uuid for the disk node, NOT
# the filesystem's), the crypttab line the host script writes, and the escrowed
# recovery key + tombstone. "open" (default) also has its droplet-bay-<luks8>
# mapper up with the ext4 mounted under /mnt/droplet; "locked" is the container
# at rest: no mapper, not mounted. The automount trust list is deliberately NOT
# touched — it holds the FILESYSTEM uuid, which the disk node never reports.
add_bay() {
  local disk="$1" luks="$2" fs="$3" state="${4:-open}"
  local mapper="droplet-bay-${luks:0:8}"
  add_disk "$disk" crypto_LUKS "$luks"
  printf '/dev/%s\tcrypto_LUKS\n' "$disk" >> "$TMP/types"
  printf '%s UUID=%s %s\n' "$mapper" "$luks" "$CRYPTTAB_BAY_OPTS" >> "$TMP/crypttab"
  mkdir -p "$TMP/recovery-data"
  printf '%s\n' "$FAKE_RECOVERY_KEY" > "$TMP/recovery-data/${luks}__${fs}.key"
  : > "$TMP/recovery-data/${luks}__${fs}.retrieved"
  if [ "$state" = "open" ]; then
    mkdir -p "$TMP/mnt/droplet/drive-${fs:0:8}"
    printf '/dev/mapper/%s\t%s\n' "$mapper" "$disk" >> "$TMP/ancestors"
    printf '/dev/mapper/%s\t%s\n' "$mapper" "$fs" >> "$TMP/uuids"
    printf '/dev/mapper/%s\text4\n' "$mapper" >> "$TMP/types"
    printf '/dev/%s\t/dev/mapper/%s\tcrypt\n' "$disk" "$mapper" >> "$TMP/stack"
    printf '%s\t%s\n' "$TMP/mnt/droplet/drive-${fs:0:8}" "/dev/mapper/$mapper" >> "$TMP/mounts"
  fi
  return 0
}

# encrypt_pool <luks-uuid> — turn the fixture's md0 pool into the WARP-3513 shape:
# LUKS on /dev/md0, the droplet-bay-<luks8> mapper over it, the pool's ext4 inside
# and mounted where the plain pool was, plus crypttab + escrow.
encrypt_pool() {
  local luks="$1" mapper="droplet-bay-${1:0:8}"
  local fs="cadf51ee-d482-4984-a5b9-a9c47028f9e8"
  printf '/dev/md0\tcrypto_LUKS\n/dev/mapper/%s\text4\n' "$mapper" >> "$TMP/types"
  # blkid on the array now answers the LUKS uuid; the fs uuid moved inside.
  { grep -v '^/dev/md0[[:space:]]' "$TMP/uuids" || true; } > "$TMP/uuids.tmp"
  mv "$TMP/uuids.tmp" "$TMP/uuids"
  printf '/dev/md0\t%s\n/dev/mapper/%s\t%s\n' "$luks" "$mapper" "$fs" >> "$TMP/uuids"
  printf '/dev/mapper/%s\tsda sdb\n' "$mapper" >> "$TMP/ancestors"
  printf '/dev/md0\t/dev/mapper/%s\tcrypt\n' "$mapper" >> "$TMP/stack"
  # the pool's mount is now backed by the mapper, not the array
  { grep -vF "$TMP/mnt/droplet/mass-storage-cadf51ee" "$TMP/mounts" || true; } > "$TMP/mounts.tmp"
  mv "$TMP/mounts.tmp" "$TMP/mounts"
  printf '%s\t%s\n' "$TMP/mnt/droplet/mass-storage-cadf51ee" "/dev/mapper/$mapper" >> "$TMP/mounts"
  printf '%s UUID=%s %s\n' "$mapper" "$luks" "$CRYPTTAB_BAY_OPTS" >> "$TMP/crypttab"
  mkdir -p "$TMP/recovery-var"
  printf '%s\n' "$FAKE_RECOVERY_KEY" > "$TMP/recovery-var/${luks}__${fs}.key"
}

# The unrelated crypttab content a real box carries: the /data volume, a swap, a
# comment that merely MENTIONS a bay, indented lines. None of it may change.
crypttab_head() {
  printf '%s\n' \
    '# <target name> <source device> <key file> <options>' \
    'droplet-data-crypt UUID=0a1b2c3d-0000-4000-8000-00000000d474 none tpm2-device=auto,luks,discard,nofail,headless=true'
}
crypttab_tail() {
  printf '%s\n' \
    'swap /dev/disk/by-partuuid/00000000-0000-4000-8000-0000000051ab /dev/urandom swap,cipher=aes-xts-plain64,size=256' \
    '# droplet-bay-deadbeef is only a comment about a bay and must survive' \
    '   other-crypt /dev/sdq1 none luks'
}

called() { grep -qF -- "$1" "$TMP/calls"; }
wiped()  { grep -qxF "$1" "$TMP/wiped"; }
erased() { grep -qxF "$1" "$TMP/erased"; }
# order_ok <pattern>... — each pattern is in the calls log, first occurrences in
# the order given (the log is appended to by every stub, in invocation order).
order_ok() {
  local last=0 n pat
  for pat in "$@"; do
    n="$(grep -nF -- "$pat" "$TMP/calls" | head -n 1 | cut -d: -f1)" || true
    { [ -n "$n" ] && [ "$n" -gt "$last" ]; } || return 1
    last="$n"
  done
  return 0
}
# (absolute path: the strict-sudo harness below shadows `find` on PATH for the
# escrow dirs, and a counter that its own refusal silently turned into "0" would
# make every "the escrow is gone" assertion vacuous)
escrow_files() { /usr/bin/find "$TMP/recovery-data" "$TMP/recovery-var" -mindepth 1 -type f 2>/dev/null | wc -l | tr -d ' '; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# use_strict_sudo — model the NON-ROOT caller the dashboard and an operator both
# are: cryptsetup / tee / shred / find-in-the-escrow-dir refuse unless the call
# arrives through the sudo stub. A privileged call the library forgot to prefix
# with $SW_SUDO passes every other test (they run as root, or on a fake tree) and
# fails only on a real box — this is the harness for that.
use_strict_sudo() {
  cat > "$TMP/bin/sudo" <<'STUB'
#!/usr/bin/env bash
echo "sudo $*" >> "$TMP/calls"
VIA_SUDO=1 exec "$@"
STUB
  local t real
  for t in tee shred; do
    real="$(PATH="/usr/bin:/bin" command -v "$t")"
    cat > "$TMP/bin/$t" <<STUB
#!/usr/bin/env bash
if [ -z "\${VIA_SUDO:-}" ]; then echo "$t: permission denied" >&2; exit 1; fi
exec "$real" "\$@"
STUB
  done
  real="$(PATH="/usr/bin:/bin" command -v find)"
  cat > "$TMP/bin/find" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *recovery-*) [ -n "\${VIA_SUDO:-}" ] || { echo "find: permission denied" >&2; exit 1; } ;;
esac
exec "$real" "\$@"
STUB
  chmod +x "$TMP/bin/"*
  SW_SUDO="$TMP/bin/sudo"
  STRICT_SUDO=1
  export SW_SUDO STRICT_SUDO
}

# run_phase3 <true|false> — runs the REAL "Phase 3: Erasing bulk storage" block of
# factory-reset.sh (log_* stubbed), with KEEP_STORAGE as given. Extracted rather
# than re-implemented, so the --keep-storage branch and the call into the library
# are the shipped ones. Fails (99) when the block cannot be found, so a refactor
# of factory-reset.sh cannot turn the assertions below vacuous.
run_phase3() {
  local block
  block="$(awk '/^log_step 3 5 "Erasing bulk storage"/ { f = 1 } f { print } f && /^log_divider$/ { exit }' "$RESET")"
  [ -n "$block" ] || return 99
  KEEP_STORAGE="$1"
  log_step() { :; }
  log_divider() { :; }
  log_info() { printf 'INFO %s\n' "$*"; }
  log_success() { printf 'OK %s\n' "$*"; }
  log_warn() { printf 'WARN %s\n' "$*"; }
  log_error() { printf 'ERR %s\n' "$*"; }
  eval "$block"
}

echo ""
echo "--- Phase 9: an encrypted bay is closed, crypto-erased, THEN wiped ---"

# The order is the whole point. The mapper holds the device open: wipefs and
# `mdadm --stop` hit EBUSY while it is up (the stubs refuse exactly that), and a
# wipefs that DID run first would remove only the LUKS magic — leaving every
# keyslot and the TPM-sealed key recoverable by re-writing the signature.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  sw_wipe_droplet_storage >/dev/null 2>&1
  order_ok "umount $TMP/mnt/droplet/drive-ab12cd34" \
           "cryptsetup close droplet-bay-1a2b3c4d" \
           "cryptsetup luksErase --batch-mode /dev/sdc" \
           "wipefs -a /dev/sdc" || exit 1
  # the wipe LANDED: wipefs refuses while the mapper is stacked on the disk
  erased /dev/sdc && wiped /dev/sdc
) >/dev/null 2>&1 && pass "open bay: unmount, close the mapper, luksErase --batch-mode, THEN wipefs" \
                 || fail "the bay was not torn down in unmount -> close -> luksErase -> wipefs order"

# The mapper is closed only for a bay (droplet-bay-*). A hot-plug USB mapper
# (droplet-usb-*) or anything else stacked on an in-scope disk is never closed
# by name and the disk is REFUSED, not half-erased under it.
( make_fixture
  add_disk sde crypto_LUKS "7ac3d2e1-1111-4222-8333-444444444444" trusted
  printf '/dev/sde\tcrypto_LUKS\n' >> "$TMP/types"
  printf '/dev/mapper/droplet-usb-7ac3d2e1\tsde\n' >> "$TMP/ancestors"
  printf '/dev/sde\t/dev/mapper/droplet-usb-7ac3d2e1\tcrypt\n' >> "$TMP/stack"
  sw_wipe_droplet_storage >"$TMP/out" 2>&1
  ! called "cryptsetup close droplet-usb-" && ! called "luksErase" \
    && ! called "wipefs -a /dev/sde" && [ "$SW_SKIPPED_COUNT" -ge 1 ] \
    && grep -qF "refusing" "$TMP/out"
) >/dev/null 2>&1 && pass "a non-bay mapper on an in-scope disk is never closed — the disk is refused" \
                 || fail "the wipe closed/erased/wiped under a mapper that is not a droplet-bay-*"

# OS-disk guard FIRST: nothing about the bay — close, erase, wipe — may precede
# the guard's verdict on the disk. Wraps the real guard to record when it runs.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  eval "_orig_$(declare -f sw_is_os_disk)"
  sw_is_os_disk() { printf 'GUARD %s\n' "$1" >> "$TMP/calls"; _orig_sw_is_os_disk "$@"; }
  sw_wipe_droplet_storage >/dev/null 2>&1
  order_ok "GUARD /dev/sdc" \
           "cryptsetup close droplet-bay-1a2b3c4d" \
           "cryptsetup luksErase --batch-mode /dev/sdc" \
           "wipefs -a /dev/sdc"
) >/dev/null 2>&1 && pass "the OS-disk guard runs on the disk BEFORE its mapper is closed or its keyslots erased" \
                 || fail "a bay was closed/erased before the OS-disk guard ruled on its disk"

# ...and when the guard says OS disk, NOTHING about the bay is touched: not the
# mount, not the mapper, not the keyslots, not the config or the escrowed key
# (the drive is still there, still encrypted, and still needs both).
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  os_disk_member sdc
  grep -v '^/dev/mapper/droplet-bay-1a2b3c4d[[:space:]]' "$TMP/ancestors" > "$TMP/a.tmp"
  printf '/dev/mapper/droplet-bay-1a2b3c4d\tnvme0n1\n' >> "$TMP/a.tmp"
  mv "$TMP/a.tmp" "$TMP/ancestors"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! called "umount $TMP/mnt/droplet/drive-ab12cd34" && ! called "cryptsetup" \
    && ! called "wipefs -a /dev/sdc" \
    && grep -q '^droplet-bay-1a2b3c4d ' "$TMP/crypttab" \
    && [ -f "$TMP/recovery-data/${BAY_LUKS_A}__${BAY_FS_A}.key" ]
) >/dev/null 2>&1 && pass "a bay on the OS disk is refused whole: no unmount, close, luksErase, wipe — config and key kept" \
                 || fail "the guard did not hold the line for an encrypted bay on the OS disk"

# The pool shape: LUKS sits on the md ARRAY, so it has to be erased THROUGH the
# array's device node — after `mdadm --stop` the node is gone — and the mapper
# has to be closed before the stop (the stub refuses a stop while it is up).
( make_fixture
  encrypt_pool "$BAY_LUKS_A"
  sw_wipe_droplet_storage >/dev/null 2>&1
  order_ok "umount $TMP/mnt/droplet/mass-storage-cadf51ee" \
           "cryptsetup close droplet-bay-1a2b3c4d" \
           "cryptsetup luksErase --batch-mode /dev/md0" \
           "mdadm --stop /dev/md0" \
           "mdadm --zero-superblock /dev/sda" || exit 1
  erased /dev/md0 && wiped /dev/sda && wiped /dev/sdb \
    && [ "$(grep -c 'zero-superblock' "$TMP/calls")" = "2" ]
) >/dev/null 2>&1 && pass "encrypted pool: close, luksErase the array node, stop, then zero + wipe both members" \
                 || fail "the LUKS-over-md pool was not torn down in close -> luksErase -> stop -> wipe order"

# A pool whose mapper is still MOUNTED (busy) is a live writer: no close, no
# erase, no stop — the existing busy refusal now has to see THROUGH the mapper
# (the mount's source is /dev/mapper/droplet-bay-*, not /dev/md0).
( make_fixture
  encrypt_pool "$BAY_LUKS_A"
  echo "$TMP/mnt/droplet/mass-storage-cadf51ee" > "$TMP/busy"
  sw_wipe_droplet_storage >"$TMP/out" 2>&1
  ! called "cryptsetup" && ! called "mdadm --stop" && ! called "zero-superblock" \
    && [ "$SW_SKIPPED_COUNT" -ge 1 ] \
    && grep -q '^droplet-bay-1a2b3c4d ' "$TMP/crypttab" \
    && [ -f "$TMP/recovery-var/${BAY_LUKS_A}__cadf51ee-d482-4984-a5b9-a9c47028f9e8.key" ]
) >/dev/null 2>&1 && pass "an encrypted pool behind a busy mount is left whole (config and key kept)" \
                 || fail "a busy encrypted pool was closed, erased or stopped anyway"

# A busy whole-disk bay: same.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  echo "$TMP/mnt/droplet/drive-ab12cd34" > "$TMP/busy"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! called "cryptsetup" && ! called "wipefs -a /dev/sdc" && [ "$SW_SKIPPED_COUNT" -ge 1 ] \
    && grep -q '^droplet-bay-1a2b3c4d ' "$TMP/crypttab" \
    && [ -f "$TMP/recovery-data/${BAY_LUKS_A}__${BAY_FS_A}.key" ]
) >/dev/null 2>&1 && pass "a bay behind a busy mount is left alone (no close, erase, wipe; config and key kept)" \
                 || fail "a bay whose mount never released was closed/erased/wiped"

# A mapper that will not close (something still has it open) must stop the
# erase: luksErase under a live mapping, then a failing wipefs, would leave the
# worst of both worlds. The OTHER bay is independent and is still erased.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" open
  echo "droplet-bay-1a2b3c4d" > "$TMP/busy_mappers"
  sw_wipe_droplet_storage >"$TMP/out" 2>&1
  called "cryptsetup close droplet-bay-1a2b3c4d" \
    && ! erased /dev/sdc && ! wiped /dev/sdc \
    && erased /dev/sdd && wiped /dev/sdd \
    && grep -q '^droplet-bay-1a2b3c4d ' "$TMP/crypttab" \
    && ! grep -q '^droplet-bay-9f8e7d6c ' "$TMP/crypttab" \
    && [ -f "$TMP/recovery-data/${BAY_LUKS_A}__${BAY_FS_A}.key" ] \
    && [ ! -e "$TMP/recovery-data/${BAY_LUKS_B}__${BAY_FS_B}.key" ] \
    && grep -qF "refusing" "$TMP/out" && [ "$SW_SKIPPED_COUNT" -ge 1 ]
) >/dev/null 2>&1 && pass "a mapper that will not close: that bay is refused whole, its sibling is still erased" \
                 || fail "a failed mapper close did not stop the erase (or took the sibling bay down with it)"

# luksErase failing means the keyslots are STILL INTACT. wipefs would then
# remove only the magic — the weak erase this whole change exists to avoid — so
# the device is left exactly as it is, and the failure is loud.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" open
  echo "/dev/sdc" > "$TMP/luks_fail"
  sw_wipe_droplet_storage >"$TMP/out" 2>&1
  called "cryptsetup luksErase --batch-mode /dev/sdc" \
    && ! called "wipefs -a /dev/sdc" \
    && erased /dev/sdd && wiped /dev/sdd \
    && grep -q '^droplet-bay-1a2b3c4d ' "$TMP/crypttab" \
    && [ -f "$TMP/recovery-data/${BAY_LUKS_A}__${BAY_FS_A}.key" ] \
    && grep -qF "could not crypto-erase" "$TMP/out" \
    && [ "$SW_CRYPTO_FAILED_COUNT" = "1" ] && [ "$SW_CRYPTO_ERASED_COUNT" = "1" ]
) >/dev/null 2>&1 && pass "luksErase failing: no wipefs on that drive (never a weak erase), reported, config + key kept" \
                 || fail "a failed luksErase was followed by wipefs, or went unreported"

# The wipe still returns 0 through all of the above.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  echo "/dev/sdc" > "$TMP/luks_fail"
  sw_wipe_droplet_storage >/dev/null 2>&1
) >/dev/null 2>&1 && pass "wipe returns 0 even when a drive could not be crypto-erased" \
                 || fail "a failed crypto-erase aborted the wipe (the reset would half-finish)"

# FAILS CLOSED: when lsblk cannot list what is stacked on a disk the reset is
# about to erase, it cannot tell whether a mapper or a LUKS container is there —
# and wipefs on a LUKS drive it did not recognise is the weak erase. Refuse.
( make_fixture
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa" trusted
  mv "$TMP/bin/lsblk" "$TMP/bin/lsblk.real"
  cat > "$TMP/bin/lsblk" <<'STUB'
#!/usr/bin/env bash
case "$*" in -rnpo*) exit 1 ;; esac
exec "$(dirname "$0")/lsblk.real" "$@"
STUB
  chmod +x "$TMP/bin/lsblk"
  hash -r
  sw_wipe_droplet_storage >"$TMP/out" 2>&1
  ! called "wipefs -a /dev/sdc" && grep -q "cannot list what is stacked on /dev/sdc" "$TMP/out" \
    && [ "$SW_SKIPPED_COUNT" -ge 1 ]
) >/dev/null 2>&1 && pass "a stack lsblk cannot list is a refusal, not 'nothing encrypted' (fails closed)" \
                 || fail "a disk was wiped although lsblk could not say whether it carries LUKS"

echo ""
echo "--- Phase 10: which encrypted drives are in scope ---"

# A LOCKED bay (container at rest: no mapper, not mounted). The disk node reports
# the LUKS uuid, which the trust list (it holds the filesystem uuid) never has —
# so the old gate silently skipped it. The box made it, and says so in crypttab.
( make_fixture
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" locked
  sw_wipe_droplet_storage >/dev/null 2>&1
  order_ok "cryptsetup luksErase --batch-mode /dev/sdd" "wipefs -a /dev/sdd" \
    && ! called "cryptsetup close" && erased /dev/sdd && wiped /dev/sdd
) >/dev/null 2>&1 && pass "a locked bay carrying a droplet-bay-* crypttab entry is Droplet-managed: erased" \
                 || fail "a locked bay survived the reset (crypttab entry did not put it in scope)"

# ...but a LUKS drive the box has NO record of (a customer's own) is not ours.
( make_fixture
  add_disk sde crypto_LUKS "7ac3d2e1-1111-4222-8333-444444444444"
  printf '/dev/sde\tcrypto_LUKS\n' >> "$TMP/types"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! called "cryptsetup" && ! called "wipefs -a /dev/sde"
) >/dev/null 2>&1 && pass "a LUKS drive with no crypttab entry and no trust-list record is left alone" \
                 || fail "a foreign LUKS drive was crypto-erased or wiped"

# ...and a crypttab line for a DIFFERENT uuid does not pull an unrelated disk in.
( make_fixture
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" locked
  add_disk sde crypto_LUKS "7ac3d2e1-1111-4222-8333-444444444444"
  printf '/dev/sde\tcrypto_LUKS\n' >> "$TMP/types"
  sw_wipe_droplet_storage >/dev/null 2>&1
  erased /dev/sdd && ! erased /dev/sde && ! called "wipefs -a /dev/sde"
) >/dev/null 2>&1 && pass "only the disk whose LUKS uuid is in crypttab is pulled in (a foreign LUKS sibling is not)" \
                 || fail "scope leaked from a crypttab entry to a disk it does not name"

# The existing trust-list rule still applies to a LUKS disk: trust narrows, and
# a trusted LUKS disk gets the same close/crypto-erase treatment.
( make_fixture
  add_disk sde crypto_LUKS "7ac3d2e1-1111-4222-8333-444444444444" trusted
  printf '/dev/sde\tcrypto_LUKS\n' >> "$TMP/types"
  sw_wipe_droplet_storage >/dev/null 2>&1
  order_ok "cryptsetup luksErase --batch-mode /dev/sde" "wipefs -a /dev/sde" && erased /dev/sde
) >/dev/null 2>&1 && pass "a trust-listed LUKS disk is crypto-erased before it is wiped" \
                 || fail "a trust-listed LUKS disk was wiped without a luksErase"

# A plain (pre-WARP-3513) adopted drive is erased exactly as before: no
# cryptsetup call at all.
( make_fixture
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa" trusted
  sw_wipe_droplet_storage >/dev/null 2>&1
  wiped /dev/sdc && ! called "cryptsetup"
) >/dev/null 2>&1 && pass "a plain (unencrypted) adopted drive is erased as before, with no cryptsetup call" \
                 || fail "the plain-drive path changed (or called cryptsetup)"

echo ""
echo "--- Phase 11: no bay encryption state is left behind ---"

# crypttab: every droplet-bay-* line goes; everything else is byte-for-byte what
# it was — comments (including one that mentions a bay), the /data volume's
# line, swap, an indented line — and the file keeps its mode (it is rewritten in
# place via a temp file, not replaced).
( make_fixture
  crypttab_head > "$TMP/crypttab"
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" locked
  crypttab_tail >> "$TMP/crypttab"
  { crypttab_head; crypttab_tail; } > "$TMP/crypttab.expected"
  chmod 0640 "$TMP/crypttab"
  before_mode="$(mode_of "$TMP/crypttab")"
  sw_wipe_droplet_storage >/dev/null 2>&1
  cmp -s "$TMP/crypttab" "$TMP/crypttab.expected" || exit 1
  ! grep -q '^droplet-bay-' "$TMP/crypttab" || exit 1
  [ "$(mode_of "$TMP/crypttab")" = "$before_mode" ]
) >/dev/null 2>&1 && pass "crypttab: droplet-bay-* lines removed, every other line byte-identical, mode kept" \
                 || fail "crypttab was mangled (or a bay line survived the reset)"

# A reset on a box with no bays leaves crypttab untouched — not even rewritten.
( make_fixture
  { crypttab_head; crypttab_tail; } > "$TMP/crypttab"
  cp "$TMP/crypttab" "$TMP/crypttab.before"
  touch -d '2001-01-01 00:00:00' "$TMP/crypttab" 2>/dev/null || true
  stamp_before="$(ls -l --time-style=+%s "$TMP/crypttab" 2>/dev/null | awk '{ print $6 }' || true)"
  sw_wipe_droplet_storage >/dev/null 2>&1
  cmp -s "$TMP/crypttab" "$TMP/crypttab.before" || exit 1
  [ "$(ls -l --time-style=+%s "$TMP/crypttab" 2>/dev/null | awk '{ print $6 }' || true)" = "$stamp_before" ]
) >/dev/null 2>&1 && pass "crypttab with no bay lines is not rewritten" \
                 || fail "crypttab was rewritten although it held no droplet-bay-* line"

# The escrow: the recovery keys and their tombstones, in EVERY directory of the
# SW_BAY_RECOVERY_DIRS list (the production default is the one /data directory;
# the list is a seam), are gone — the directories themselves are not.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" locked
  # drive B's escrow lives in the SECOND configured directory (recovery-var);
  # drive A's in the first (recovery-data)
  mkdir -p "$TMP/recovery-var"
  mv "$TMP/recovery-data/${BAY_LUKS_B}__${BAY_FS_B}.key" \
     "$TMP/recovery-data/${BAY_LUKS_B}__${BAY_FS_B}.retrieved" "$TMP/recovery-var/"
  [ "$(escrow_files)" = "4" ] || exit 1
  [ -n "$(ls "$TMP/recovery-var")" ] && [ -n "$(ls "$TMP/recovery-data")" ] || exit 1
  sw_wipe_droplet_storage >/dev/null 2>&1
  [ "$(escrow_files)" = "0" ] && [ -d "$TMP/recovery-data" ] && [ -d "$TMP/recovery-var" ]
) >/dev/null 2>&1 && pass "escrowed recovery keys + tombstones are removed from both directories (the dirs stay)" \
                 || fail "an escrowed recovery key or tombstone survived the reset"

# Overwrite-then-unlink, like secrets-wipe.sh: with no usable shred the fallback
# overwrites the file's own blocks (dd conv=notrunc) before it unlinks.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  cat > "$TMP/bin/shred" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
  cat > "$TMP/bin/dd" <<'STUB'
#!/usr/bin/env bash
printf 'dd %s\n' "$*" >> "$TMP/calls"
exit 0
STUB
  chmod +x "$TMP/bin/shred" "$TMP/bin/dd"
  hash -r
  sw_wipe_droplet_storage >/dev/null 2>&1
  grep -qF "conv=notrunc" "$TMP/calls" \
    && grep -qF "of=$TMP/recovery-data/${BAY_LUKS_A}__${BAY_FS_A}.key" "$TMP/calls" \
    && [ "$(escrow_files)" = "0" ]
) >/dev/null 2>&1 && pass "with no usable shred the key is overwritten in place (dd conv=notrunc), then unlinked" \
                 || fail "the escrow fallback did not overwrite the key's own blocks before unlinking"

# State for a drive that is NOT on this box any more (unplugged, or erased by an
# earlier run) has nothing to protect: its line and its key go too.
( make_fixture
  printf 'droplet-bay-feedface UUID=feedface-0000-4000-8000-000000000000 %s\n' "$CRYPTTAB_BAY_OPTS" >> "$TMP/crypttab"
  mkdir -p "$TMP/recovery-var"
  printf '%s\n' "$FAKE_RECOVERY_KEY" > "$TMP/recovery-var/feedface-0000-4000-8000-000000000000__00000000-0000-4000-8000-000000000001.key"
  sw_wipe_droplet_storage >/dev/null 2>&1
  ! grep -q '^droplet-bay-' "$TMP/crypttab" && [ "$(escrow_files)" = "0" ]
) >/dev/null 2>&1 && pass "crypttab line and key for a drive no longer on the box are removed" \
                 || fail "orphaned bay state survived the reset"

# A drive the reset could NOT erase keeps its crypttab line and its key: removing
# them would leave a drive that is neither wiped nor openable. (The refusal
# cases above assert this per cause; this is the unrelated-config companion.)
( make_fixture
  crypttab_head > "$TMP/crypttab"
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  echo "/dev/sdc" > "$TMP/luks_fail"
  sw_wipe_droplet_storage >"$TMP/out" 2>&1
  { crypttab_head; printf 'droplet-bay-1a2b3c4d UUID=%s %s\n' "$BAY_LUKS_A" "$CRYPTTAB_BAY_OPTS"; } > "$TMP/crypttab.expected"
  cmp -s "$TMP/crypttab" "$TMP/crypttab.expected" \
    && grep -qF "$BAY_LUKS_A" "$TMP/out"
) >/dev/null 2>&1 && pass "a drive that could not be erased keeps its crypttab line and key, and the output names it" \
                 || fail "state for a still-encrypted drive was removed (or not reported)"

# Idempotent: the second run finds nothing to do and touches nothing.
( make_fixture
  crypttab_head > "$TMP/crypttab"
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  crypttab_tail >> "$TMP/crypttab"
  sw_wipe_droplet_storage >/dev/null 2>&1
  cp "$TMP/crypttab" "$TMP/crypttab.after1"
  calls1="$(grep -c 'cryptsetup' "$TMP/calls" || true)"
  sw_wipe_droplet_storage >/dev/null 2>&1
  rc=$?
  [ "$rc" = "0" ] && cmp -s "$TMP/crypttab" "$TMP/crypttab.after1" \
    && [ "$(grep -c 'cryptsetup' "$TMP/calls" || true)" = "$calls1" ]
) >/dev/null 2>&1 && pass "a second reset is a no-op: no further cryptsetup call, crypttab unchanged, exit 0" \
                 || fail "the encrypted-bay wipe is not idempotent"

# Rule 19: nothing it destroys is ever printed — the escrowed key included.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  encrypt_pool "$BAY_LUKS_B"
  out="$(sw_wipe_droplet_storage 2>&1)" || true
  # non-vacuous: the escrow really was found and destroyed, and said so
  erased /dev/sdc && erased /dev/md0 && [ "$(escrow_files)" = "0" ] \
    && [ -n "$out" ] && ! printf '%s' "$out" | grep -qF "$FAKE_RECOVERY_KEY"
) >/dev/null 2>&1 && pass "no escrowed key value reaches any output line (rule 19)" \
                 || fail "a recovery key VALUE appeared in the wipe output (rule 19)"

# A non-root caller: every privileged call must go through $SW_SUDO. The strict
# stubs refuse cryptsetup / tee (crypttab) / shred and find (escrow) otherwise.
( make_fixture
  use_strict_sudo
  crypttab_head > "$TMP/crypttab"
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  sw_wipe_droplet_storage >/dev/null 2>&1
  erased /dev/sdc && wiped /dev/sdc \
    && called "sudo cryptsetup close droplet-bay-1a2b3c4d" \
    && called "sudo cryptsetup luksErase --batch-mode /dev/sdc" \
    && called "sudo tee $TMP/crypttab" \
    && called "sudo shred" \
    && ! grep -q '^droplet-bay-' "$TMP/crypttab" \
    && [ "$(escrow_files)" = "0" ]
) >/dev/null 2>&1 && pass "every privileged step (close, luksErase, crypttab rewrite, key shred) runs through \$SW_SUDO" \
                 || fail "a privileged bay step ran without \$SW_SUDO — it would fail for a non-root reset"

echo ""
echo "--- Phase 12: the reset's own Phase 3 + the prompt ---"

# The REAL Phase 3 block, default path: the bay is erased and the transcript says
# how many encrypted volumes were crypto-erased.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  run_phase3 false >"$TMP/p3.out" 2>&1
  # (the reset's OWN summary line — "OK ..." in this stub — not the library's
  # per-device "crypto-erased the LUKS keyslots on ..." line)
  erased /dev/sdc && wiped /dev/sdc && ! grep -q '^droplet-bay-' "$TMP/crypttab" \
    && [ "$(escrow_files)" = "0" ] \
    && grep -q '^OK Erased Droplet-managed bulk storage (.*1 encrypted volume(s) crypto-erased)' "$TMP/p3.out"
) >/dev/null 2>&1 && pass "factory-reset's Phase 3 crypto-erases the bay, clears its state and reports it" \
                 || fail "the reset's Phase 3 did not erase the encrypted bay (or did not report it)"

# --keep-storage: NOTHING about bays is touched — no mount, mapper, keyslot,
# crypttab line or escrowed key. (Same as every other drive: the owner keeps them.)
( make_fixture
  crypttab_head > "$TMP/crypttab"
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" locked
  cp "$TMP/crypttab" "$TMP/crypttab.before"
  run_phase3 true >"$TMP/p3.out" 2>&1
  [ ! -s "$TMP/calls" ] && cmp -s "$TMP/crypttab" "$TMP/crypttab.before" \
    && [ "$(escrow_files)" = "4" ] && grep -qF -- '--keep-storage' "$TMP/p3.out"
) >/dev/null 2>&1 && pass "--keep-storage: no unmount, close, erase or wipe; crypttab and escrow untouched" \
                 || fail "--keep-storage touched an encrypted bay"

# A failed crypto-erase is an ERROR in the reset's own record — not just a line
# in the library's output: the box still carries recoverable keyslots.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  echo "/dev/sdc" > "$TMP/luks_fail"
  run_phase3 false >"$TMP/p3.out" 2>&1
  grep -q '^ERR .*crypto-erase' "$TMP/p3.out"
) >/dev/null 2>&1 && pass "a failed crypto-erase is logged as an ERROR by the reset (do not hand the box on)" \
                 || fail "the reset does not report a drive whose keyslots survived"

# The prompt names every drive the reset will crypto-erase. A MOUNTED bay is
# already named by its mountpoint (its source is the mapper, not the disk, so
# the disk must be resolved back to be recognised as that same drive); a locked
# bay is only reached by step 3 and must be named; a foreign LUKS drive is not
# in scope and must not be.
( make_fixture
  add_bay sdc "$BAY_LUKS_A" "$BAY_FS_A" open
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" locked
  add_disk sde crypto_LUKS "7ac3d2e1-1111-4222-8333-444444444444"
  printf '/dev/sde\tcrypto_LUKS\n' >> "$TMP/types"
  [ "$(sw_standalone_droplet_disks)" = "/dev/sdd" ]
) >/dev/null 2>&1 && pass "standalone candidates: the locked bay only (the mounted bay is named by its mountpoint)" \
                 || fail "sw_standalone_droplet_disks misnames the encrypted drives"

( make_fixture
  add_bay sdd "$BAY_LUKS_B" "$BAY_FS_B" locked
  stub_docker
  out="$(printf 'no\n' | "$RESET" 2>&1 || true)"
  printf '%s' "$out" | grep -qF "/dev/sdd" && [ ! -s "$TMP/calls" ]
) >/dev/null 2>&1 && pass "the RESET prompt names a locked bay, and the discovery pass runs no mutating command" \
                 || fail "a locked bay was never named before the operator types RESET (or discovery mutated something)"

echo ""
echo "--- Phase 13: the OS-disk guard sees through lsblk's tree drawing ---"

# Real `lsblk -s` DRAWS A TREE unless told -r: every leaf below the first line is
# printed "  └─nvme0n1", and `awk '{ print $1 }'` hands back "└─nvme0n1". Without
# -r the guard compared a bare "nvme0n1" (the whole-disk candidate) against a
# glyph-prefixed one (the stacked root) and could NEVER match — for exactly the
# case it exists for: the OS disk itself, root on LVM. The stub above prints
# glyphs unless -r is given, like the real tool.
( make_fixture
  unset SW_TEST_OSDISK
  sw_is_os_disk /dev/nvme0n1
) >/dev/null 2>&1 && pass "the guard recognises the OS disk itself when root is stacked (LVM) on it" \
                 || fail "sw_is_os_disk missed the OS disk: lsblk's tree glyphs defeat the comparison"

( make_fixture
  unset SW_TEST_OSDISK
  add_disk sdc ext4 "7a30be6e-6f0a-4b6e-9a3c-2f8f6f6c21aa"
  ! sw_is_os_disk /dev/sdc
) >/dev/null 2>&1 && pass "...and still clears a disk that is not behind /, /boot or the ESP" \
                 || fail "the guard now flags an unrelated disk as the OS disk"

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
