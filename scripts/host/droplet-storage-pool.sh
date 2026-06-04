#!/usr/bin/env bash
# =============================================================================
# BUG-3 / ADR-019 — Droplet storage-pool (mdadm software RAID) host executor
# =============================================================================
#
# The ONLY place mdadm/mkfs runs. Repo-tracked (architecture-guard rule 20) and
# installed to /usr/local/sbin/droplet-storage-pool.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box.
#
# Invoked ONLY by the device-bridge's auth-gated POST /pools/command, which the
# orchestrator reaches ONLY after an owner session + a valid single-use
# confirm-token. The AI can never reach this — the destructive ops are not in
# packages/tools-core at all.
#
# Usage:
#   droplet-storage-pool.sh <operation> '<json-params>'
#
# Operations (all DATA-DESTROYING):
#   pool_create     {device, level, members[], confirm_phrase}
#   pool_destroy    {device, confirm_phrase}
#   pool_format     {device, fstype?, confirm_phrase}
#   pool_set_level  {device, level, confirm_phrase}
#   pool_add_spare  {device, member, confirm_phrase}
#   pool_remove_disk{device, member, confirm_phrase}
#
# HARD PRE-FLIGHT (this is the last line of defense — NEVER run blind):
#   1. Operation must be in the allow-list.
#   2. A typed double-confirm phrase MUST be present AND must name the disks
#      (for create) or the array (for destroy/format/level) being erased. The
#      orchestrator builds this phrase from the owner's typed confirmation.
#   3. Refuse any target member disk that is:
#        - currently mounted, OR
#        - holds a filesystem with data, OR
#        - is (or backs) the OS/boot disk.
#
# Test/dev hooks (so the pre-flight is unit-testable without root or real md):
#   DROPLET_POOL_DRY_RUN=1        print the mdadm/mkfs command instead of running
#   DROPLET_POOL_TEST_MOUNTED=dev simulate `dev` being mounted
#   DROPLET_POOL_TEST_HASDATA=dev simulate `dev` holding a populated filesystem
#   DROPLET_POOL_TEST_OSDISK=dev  simulate `dev` being the OS disk
# In a real (non-dry-run) invocation these hooks are empty and the script uses
# the real probes (findmnt / lsblk / blkid).
#
# Output: a single JSON object on stdout on success; a human refusal on stderr
# + a non-zero exit on any pre-flight failure.
# =============================================================================
set -euo pipefail

OP="${1:-}"
PARAMS_JSON="${2:-}"

DRY_RUN="${DROPLET_POOL_DRY_RUN:-}"

err() { printf 'droplet-storage-pool: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# --- Operation allow-list ----------------------------------------------------
case "$OP" in
  pool_create|pool_destroy|pool_format|pool_set_level|pool_add_spare|pool_remove_disk) ;;
  # WARP-662: adopt a previously-used disk — deliberately wipe + reformat +
  # mount it into the Droplet ("like a new OS install"). Data-destroying.
  drive_adopt) ;;
  "") die "no operation given" ;;
  *)  die "unknown operation: $OP" ;;
esac

# --- JSON field extraction (python3 is a host dep; see install-device-bridge) -
# Reads one top-level string field from $PARAMS_JSON. Arrays are emitted as
# newline-separated values. Never evals; pure json.loads.
json_field() {
  PARAMS_JSON="$PARAMS_JSON" python3 - "$1" <<'PY'
import json, os, sys
key = sys.argv[1]
try:
    data = json.loads(os.environ.get("PARAMS_JSON") or "{}")
except Exception:
    sys.exit(0)
val = data.get(key)
# Always end lines with a bare \n (never \r\n) so callers on a CRLF host
# (Git-Bash) don't inherit a trailing \r into device paths.
sys.stdout.reconfigure(newline="\n")
if isinstance(val, list):
    for v in val:
        sys.stdout.write(str(v) + "\n")
elif val is not None:
    sys.stdout.write(str(val) + "\n")
PY
}

DEVICE="$(json_field device)"
LEVEL="$(json_field level)"
FSTYPE="$(json_field fstype)"
MEMBER="$(json_field member)"
CONFIRM="$(json_field confirm_phrase)"
WIPE_METHOD="$(json_field wipe_method)"   # WARP-662 drive_adopt: quick|secure
LABEL="$(json_field label)"               # WARP-662 drive_adopt: optional fs label
mapfile -t MEMBERS < <(json_field members)

[ -n "$DEVICE" ] || die "missing 'device'"

# --- Confirm-phrase gate (typed double-confirm) ------------------------------
# Never run blind: the confirm phrase must be present and must name what's
# being erased. For create, it must name every member's short device; for the
# array-level ops, it must name the array device.
[ -n "$CONFIRM" ] || die "missing confirm_phrase — refusing to run blind"

short() { basename "$1"; }

confirm_names() {
  # $1 = needle (short name). Case-sensitive substring match in $CONFIRM.
  case "$CONFIRM" in
    *"$1"*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$OP" = "pool_create" ]; then
  [ "${#MEMBERS[@]}" -ge 1 ] || die "pool_create requires at least one member"
  [ -n "$LEVEL" ] || die "pool_create requires a level"
  for m in "${MEMBERS[@]}"; do
    confirm_names "$(short "$m")" \
      || die "confirm_phrase must name every disk being erased (missing $(short "$m"))"
  done
else
  # Array-level pool ops AND drive_adopt: the phrase must name the single
  # target device (the array, or the disk being adopted/wiped).
  confirm_names "$(short "$DEVICE")" \
    || die "confirm_phrase must name the target being erased ($(short "$DEVICE"))"
fi

# --- Disk safety probes ------------------------------------------------------
# Real probes use findmnt/lsblk/blkid; the DROPLET_POOL_TEST_* hooks let the
# unit tests force a positive result without a real block device.

is_mounted() {
  local dev="$1"
  if [ -n "${DROPLET_POOL_TEST_MOUNTED:-}" ]; then
    [ "$dev" = "$DROPLET_POOL_TEST_MOUNTED" ] && return 0 || return 1
  fi
  # Real: findmnt resolves the source; also catches partitions of the disk.
  findmnt -rn --source "$dev" >/dev/null 2>&1 && return 0
  lsblk -rno MOUNTPOINT "$dev" 2>/dev/null | grep -q . && return 0
  return 1
}

has_data() {
  local dev="$1"
  if [ -n "${DROPLET_POOL_TEST_HASDATA:-}" ]; then
    [ "$dev" = "$DROPLET_POOL_TEST_HASDATA" ] && return 0 || return 1
  fi
  # Real: a detectable filesystem signature means there may be data on it.
  # blkid prints a TYPE= when a filesystem is present.
  blkid -p -o value -s TYPE "$dev" 2>/dev/null | grep -q . && return 0
  return 1
}

is_os_disk() {
  local dev="$1"
  if [ -n "${DROPLET_POOL_TEST_OSDISK:-}" ]; then
    [ "$dev" = "$DROPLET_POOL_TEST_OSDISK" ] && return 0 || return 1
  fi
  # Real: the disk (or a partition of it) that backs the root or /boot mount
  # must never be a RAID member. Resolve the backing source of / and /boot and
  # compare its parent disk to this device's parent disk.
  local this_disk
  this_disk="$(lsblk -ndo PKNAME "$dev" 2>/dev/null || true)"
  [ -n "$this_disk" ] || this_disk="$(basename "$dev")"
  for mp in / /boot /boot/efi; do
    local src parent
    src="$(findmnt -rn -o SOURCE --target "$mp" 2>/dev/null || true)"
    [ -n "$src" ] || continue
    parent="$(lsblk -ndo PKNAME "$src" 2>/dev/null || true)"
    [ -n "$parent" ] || parent="$(basename "$src")"
    [ "$parent" = "$this_disk" ] && return 0
  done
  return 1
}

preflight_member() {
  local dev="$1"
  if is_mounted "$dev"; then die "refusing: $dev is mounted — unmount it first"; fi
  if is_os_disk "$dev"; then die "refusing: $dev is (or backs) the OS/boot/system disk"; fi
  if has_data   "$dev"; then die "refusing: $dev holds a filesystem with data — erase it deliberately first"; fi
  return 0
}

# pool_create wipes every member; the array-level ops act on the array (md
# device) but a remove/add touches a specific member disk. Pre-flight every
# disk we are about to write to.
case "$OP" in
  pool_create)
    for m in "${MEMBERS[@]}"; do preflight_member "$m"; done
    ;;
  pool_add_spare|pool_remove_disk)
    [ -n "$MEMBER" ] || die "$OP requires a 'member'"
    # add_spare writes to the new disk → full pre-flight; remove_disk only
    # detaches, but we still refuse if that disk is independently mounted.
    if [ "$OP" = "pool_add_spare" ]; then
      preflight_member "$MEMBER"
    else
      if is_mounted "$MEMBER"; then die "refusing: $MEMBER is mounted"; fi
    fi
    ;;
  pool_destroy|pool_format|pool_set_level)
    # Acting on the assembled array device. Refuse if the OS lives on it.
    if is_os_disk "/dev/$DEVICE"; then die "refusing: /dev/$DEVICE backs the OS disk"; fi
    ;;
  drive_adopt)
    # Adopt = deliberately reclaim a previously-used disk: wipe + reformat +
    # mount it into the Droplet. The OS/boot/system disk is NEVER eligible —
    # this is the last-line, server-side guard (the dashboard also excludes it,
    # but we must never trust the client). Unlike the pool ops, we do NOT refuse
    # on has_data: erasing existing data is the whole point and is gated by the
    # typed confirm_phrase naming this disk above. A mounted target is unmounted
    # in the execute step (it's the "reclaim this disk" intent), not refused.
    if is_os_disk "/dev/$DEVICE"; then
      die "refusing: /dev/$DEVICE is (or backs) the OS/boot/system disk — never adoptable"
    fi
    ;;
esac

# --- Build the real command --------------------------------------------------
MD="/dev/$DEVICE"
build_cmd() {
  case "$OP" in
    pool_create)
      # mdadm --create with an explicit level + member count; --run avoids the
      # interactive "continue creating array?" prompt. No auto-anything.
      printf 'mdadm --create %s --level=%s --raid-devices=%s --run %s' \
        "$MD" "$LEVEL" "${#MEMBERS[@]}" "${MEMBERS[*]}"
      ;;
    pool_destroy)
      printf 'mdadm --stop %s && mdadm --zero-superblock (members)' "$MD"
      ;;
    pool_format)
      printf 'mkfs.%s %s' "${FSTYPE:-ext4}" "$MD"
      ;;
    pool_set_level)
      printf 'mdadm --grow %s --level=%s' "$MD" "$LEVEL"
      ;;
    pool_add_spare)
      printf 'mdadm --add %s %s' "$MD" "$MEMBER"
      ;;
    pool_remove_disk)
      printf 'mdadm %s --fail %s --remove %s' "$MD" "$MEMBER" "$MEMBER"
      ;;
    drive_adopt)
      # unmount (if mounted) → wipe (quick: wipefs / secure: blkdiscard) →
      # mkfs → mount under /mnt/droplet.
      printf 'adopt %s: unmount -> wipe(%s) -> mkfs.%s%s -> mount /mnt/droplet' \
        "$MD" "${WIPE_METHOD:-quick}" "${FSTYPE:-ext4}" \
        "$([ -n "$LABEL" ] && printf ' -L %s' "$LABEL")"
      ;;
  esac
}

CMD="$(build_cmd)"

emit_ok() {
  # Single-line JSON the bridge parses with json.loads.
  printf '{"ok": true, "device": "%s", "operation": "%s", "dry_run": %s}\n' \
    "$DEVICE" "$OP" "$([ -n "$DRY_RUN" ] && echo true || echo false)"
}

if [ -n "$DRY_RUN" ]; then
  err "dry-run: would execute: $CMD"
  emit_ok
  exit 0
fi

# --- Execute (real) ----------------------------------------------------------
# Pre-flight passed and confirm matched. Run the actual command. Each op is
# spelled out (not eval of $CMD) so we never execute a string we built loosely.
case "$OP" in
  pool_create)
    mdadm --create "$MD" --level="$LEVEL" \
      --raid-devices="${#MEMBERS[@]}" --run "${MEMBERS[@]}"
    ;;
  pool_destroy)
    # Stop the array, then wipe each member's md superblock so the disk is
    # reusable and no stale array re-assembles on the next boot.
    mdadm --stop "$MD"
    for slave in /sys/block/"$DEVICE"/slaves/*; do
      [ -e "$slave" ] || continue
      mdadm --zero-superblock "/dev/$(basename "$slave")" || true
    done
    ;;
  pool_format)
    "mkfs.${FSTYPE:-ext4}" "$MD"
    ;;
  pool_set_level)
    mdadm --grow "$MD" --level="$LEVEL"
    ;;
  pool_add_spare)
    mdadm --add "$MD" "$MEMBER"
    ;;
  pool_remove_disk)
    mdadm "$MD" --fail "$MEMBER" --remove "$MEMBER"
    ;;
  drive_adopt)
    # 1) Unmount the target disk + any of its partitions if currently mounted
    #    (e.g. it was auto-mounted on plug). Adopt is allowed to reclaim it.
    if findmnt -rn --source "$MD" >/dev/null 2>&1; then
      umount "$MD" 2>/dev/null || umount -l "$MD" 2>/dev/null || true
    fi
    for part in "$MD"?*; do
      [ -b "$part" ] || continue
      if findmnt -rn --source "$part" >/dev/null 2>&1; then
        umount "$part" 2>/dev/null || umount -l "$part" 2>/dev/null || true
      fi
    done
    # 2) Wipe. quick = clear fs/partition signatures (wipefs); secure = discard
    #    the whole device first (TRIM-based erase for flash), then wipefs.
    case "${WIPE_METHOD:-quick}" in
      secure) blkdiscard -f "$MD" 2>/dev/null || true; wipefs -a "$MD" ;;
      *)      wipefs -a "$MD" ;;
    esac
    # 3) Fresh whole-device filesystem (no partition table — matches how the
    #    automount enumerates by-uuid). Optional owner-chosen label.
    if [ -n "$LABEL" ]; then
      "mkfs.${FSTYPE:-ext4}" -L "$LABEL" "$MD"
    else
      "mkfs.${FSTYPE:-ext4}" "$MD"
    fi
    # 4) Mount under the shared /mnt/droplet namespace so it's usable now and
    #    the device-bridge surfaces it; the udev automount re-mounts on reboot.
    adopt_uuid="$(blkid -o value -s UUID "$MD" 2>/dev/null || true)"
    adopt_mnt="/mnt/droplet/${LABEL:-${adopt_uuid:-$(basename "$MD")}}"
    mkdir -p "$adopt_mnt"
    mount "$MD" "$adopt_mnt"
    ;;
esac

emit_ok
