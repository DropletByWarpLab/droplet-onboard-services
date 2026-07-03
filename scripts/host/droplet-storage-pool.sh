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
#      (for create) or the array (for destroy/format/level) being erased —
#      each short device name as an exact whole token of the phrase (WARP-848:
#      a substring match let `sda1` ride on a phrase naming `sda10`). The
#      orchestrator builds this phrase from the owner's typed confirmation.
#   3. Refuse — ALWAYS and unconditionally — any target that is (or backs)
#      the OS/boot disk.
#   4. pool_add_spare additionally refuses a member that is currently mounted
#      or holds a filesystem with data. pool_create and drive_adopt do NOT
#      refuse those (WARP-848): first-run drives arrive automounted, and the
#      confirm phrase names every device being erased — so mounted/has-data
#      targets get a MANAGED teardown in the execute step instead: clean,
#      never-lazy unmount (a real EBUSY still dies loudly), then wipefs.
#
# Test/dev hooks (so the pre-flight is unit-testable without root or real md):
#   DROPLET_POOL_DRY_RUN=1        print the mdadm/mkfs command instead of running
#   DROPLET_POOL_TEST_MOUNTED=dev simulate `dev` being mounted
#   DROPLET_POOL_TEST_HASDATA=dev simulate `dev` holding a populated filesystem
#   DROPLET_POOL_TEST_OSDISK=dev  simulate `dev` being the OS disk
#   DROPLET_AUTOMOUNT_STATE=path  override the automount state file the managed
#                                 teardown prunes (WARP-848 unit tests)
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
  # $1 = needle (short device name). EXACT-TOKEN match: the phrase is split on
  # runs of non-alphanumerics and the needle must equal one whole token,
  # case-sensitively. (WARP-848 hardening — a substring match let `sda1` ride
  # on a phrase naming only `sda10`: one typed phrase consenting to a
  # DIFFERENT disk.) After tr the candidates are pure alnum, so the unquoted
  # word-split below can never glob. A needle that itself contains a
  # non-alphanumeric (e.g. dm-0) can never match — that fails CLOSED, and the
  # pool/adopt targets are plain kernel names (sdX / nvmeXnY / mmcblkN / mdN).
  local needle="$1" tok
  for tok in $(printf '%s' "$CONFIRM" | tr -cs '[:alnum:]' ' '); do
    [ "$tok" = "$needle" ] && return 0
  done
  return 1
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

# --- Managed unmount (WARP-848) -----------------------------------------------
# First-run drives arrive automounted (droplet-automount mounts every data
# drive at boot), so the confirm-gated destructive ops must be able to release
# those mounts themselves — cleanly, NEVER lazily (`umount -l` would let a
# wipe race open file handles). These helpers enumerate what is ACTUALLY
# mounted and unwind it; a real unmount failure (EBUSY, open files) still dies
# loudly so the owner closes files and retries.

# Where droplet-automount records what it mounted. Overridable for the unit
# tests only; the shipping path is fixed.
AUTOMOUNT_STATE="${DROPLET_AUTOMOUNT_STATE:-/var/lib/droplet-automount/mounts.json}"

# --- Host mount-namespace escape (WARP-868) ----------------------------------
# The data drives are mounted in the HOST (init) mount namespace, but this
# script runs under droplet-storage-pool-apply.service, whose hardening
# directives (ProtectHome / ProtectKernelTunables / ProtectControlGroups) each
# force systemd to give the unit a PRIVATE mount namespace with SLAVE
# propagation. Verified live on the .87 box: a plain `umount /mnt/droplet/...`
# inside that namespace returns 0 but frees ONLY this namespace's copy — the
# kernel block device stays mounted in the host, so the subsequent
# wipefs/mdadm hit EBUSY (and the teardown's own residual `findmnt` check still
# sees the host mount that never went away, dying "busy"). That is exactly the
# "pool create does nothing after the warning" / 422 regression.
#
# The Nextcloud container bind-mounts /mnt/droplet with shared propagation, so
# every data mount appears TWICE in findmnt (host root + bind peer, same peer
# group) — one host-namespace umount of the shared target clears both peers
# (also verified live).
#
# Fix: run the unmount AND its verification in the host namespace via
# `nsenter -m -t 1` (we are root → have CAP_SYS_ADMIN; the unit has no PID
# namespace → /proc/1 is host init). Only engage it when our mount namespace
# genuinely differs from PID 1's, so dev hosts and the PATH-shim unit tests
# (which set DROPLET_POOL_HOSTNS_DISABLE=1) keep using the plain tools.
HOSTNS=()
if [ "${DROPLET_POOL_HOSTNS_DISABLE:-}" != "1" ] \
   && command -v nsenter >/dev/null 2>&1 \
   && [ -r /proc/1/ns/mnt ] \
   && [ "$(readlink /proc/self/ns/mnt 2>/dev/null)" != "$(readlink /proc/1/ns/mnt 2>/dev/null)" ]; then
  HOSTNS=(nsenter -m -t 1)
fi
# Run umount / findmnt / mount in the host mount namespace (no-op prefix off-box).
host_umount()  { "${HOSTNS[@]}" umount "$@"; }
host_findmnt() { "${HOSTNS[@]}" findmnt "$@"; }
host_mount()   { "${HOSTNS[@]}" mount "$@"; }

# mounts_backed_by <node>: every current mount whose SOURCE is <node> itself
# or a partition of it, as "SOURCE TARGET" lines — partitions first (deepest
# target first), the node itself LAST. findmnt enumerates real mount SOURCES;
# the old code instead asked `lsblk -rno MOUNTPOINT <disk>`, which lists CHILD
# partition mountpoints, then umounted the never-mounted disk node and died
# (the WARP-848 live failure). Child-ness comes from the kernel topology
# (lsblk PKNAME), never name-pattern guessing. findmnt -r escapes blanks in
# targets as \xHH; callers unescape with printf %b at use time.
mounts_backed_by() {
  local node="$1" base src tgt pk grp slashes
  base="$(basename "$node")"
  # WARP-868: enumerate the HOST mount table (host_findmnt) so we see the real
  # mounts holding the block device, not this private namespace's diverged copy.
  { host_findmnt -rn -o SOURCE,TARGET 2>/dev/null || true; } | {
    while read -r src tgt; do
      [ -n "$src" ] && [ -n "$tgt" ] || continue
      if [ "$src" = "$node" ]; then
        grp=1
      else
        pk="$(lsblk -ndo PKNAME "$src" 2>/dev/null || true)"
        [ "$pk" = "$base" ] || continue
        grp=0
      fi
      slashes="${tgt//[!\/]/}"
      printf '%d %05d %s %s\n' "$grp" "$((99999 - ${#slashes}))" "$src" "$tgt"
    done
  } | sort | cut -d' ' -f3-
}

# prune_automount_state <source-device> <target>: WARP-612 parity. The guarded
# eject path (device-bridge eject_drive) "forgets" a drive it unmounted by
# dropping its entry from the automount state file; a managed unmount does the
# same so the state stays honest. Best-effort: a missing/unreadable state file
# is fine — the bridge's drives snapshot self-heals stale entries via its
# ismount check, and the bridge invalidates that snapshot after every
# successful pool command anyway. Nextcloud external-storage registrations are
# NOT touched here, matching eject_drive: auto-registration is opt-in
# (NEXTCLOUD_AUTO_REGISTER, default off) and deregistration belongs to
# droplet-automount's udev remove handler.
prune_automount_state() {
  local src="$1" tgt="$2"
  if [ -f "$AUTOMOUNT_STATE" ]; then
    # The device travels via env in a JSON envelope — same posture as
    # PARAMS_JSON in json_field. A bare "/dev/sdX1" value would LOOK like an
    # absolute path and gets rewritten by the path-converting shims between
    # bash and a native python on dev hosts (Git-Bash/MSYS env conversion);
    # a JSON blob never does. Pure json.loads, no eval.
    STATE_PATH="$AUTOMOUNT_STATE" PRUNE_JSON="{\"device\": \"$src\"}" \
      python3 - <<'PY' || true
import json, os, sys
path = os.environ["STATE_PATH"]
try:
    device = json.loads(os.environ.get("PRUNE_JSON") or "{}").get("device") or ""
except Exception:
    sys.exit(0)
if not device:
    sys.exit(0)
try:
    with open(path) as f:
        state = json.load(f)
except Exception:
    sys.exit(0)
mounts = state.get("mounts", [])
kept = [m for m in mounts if m.get("device") != device]
if len(kept) != len(mounts):
    state["mounts"] = kept
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)
PY
  fi
  # The now-empty mountpoint dir (mirrors automount's remove handler). rmdir
  # refuses a non-empty dir, so this can never delete data.
  rmdir "$tgt" 2>/dev/null || true
}

# unmount_mount_or_die <source> <target> <context>: one clean, NON-lazy
# unmount. Tolerates the mount having vanished since enumeration (something
# raced us — that is success, not busy). A REAL failure dies with the
# "close open files and retry" message the dashboard's friendly-error
# mapping recognises, naming the mountpoint.
unmount_mount_or_die() {
  local src="$1" tgt="$2" ctx="$3"
  # WARP-868: a shared-propagation duplicate (Nextcloud's /mnt/droplet bind
  # peer) means `mounts_backed_by` enumerates the same target twice; one
  # host-namespace umount clears both peers, so a second umount of an
  # already-cleared target returns "not mounted". Treat host-side-already-gone
  # as success: re-check the HOST table and only die if the target truly
  # persists (a real EBUSY with open file handles).
  if ! host_umount "$tgt"; then
    host_findmnt -rn --mountpoint "$tgt" >/dev/null 2>&1 || return 0
    die "$ctx: $src is busy at $tgt (unmount failed) — close open files and retry"
  fi
  prune_automount_state "$src" "$tgt"
}

# teardown_mounts_of <node> <context>: release everything mounted from <node>
# — partitions first, the node itself only if it is genuinely a mount source.
# Verifies nothing re-appeared before returning, so a wipe can never hit a
# live mount.
teardown_mounts_of() {
  local node="$1" ctx="$2" line src tgt
  # Fail loudly if the host-namespace gateway is broken — silent nsenter failures
  # would let teardown proceed with live host mounts (EBUSY on wipefs/mdadm).
  if [ "${#HOSTNS[@]}" -gt 0 ] && ! "${HOSTNS[@]}" true 2>/dev/null; then
    die "nsenter to host mount namespace failed — cannot safely proceed with mount teardown"
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    src="${line%% *}"
    tgt="$(printf '%b' "${line#* }")"   # findmnt -r escapes blanks as \xHH
    unmount_mount_or_die "$src" "$tgt" "$ctx"
  done < <(mounts_backed_by "$node")
  if [ -n "$(mounts_backed_by "$node")" ]; then
    die "$ctx: $node is still mounted after unmount — close open files and retry"
  fi
}

# pool_create wipes every member; the array-level ops act on the array (md
# device) but a remove/add touches a specific member disk. Pre-flight every
# disk we are about to write to.
case "$OP" in
  pool_create)
    # WARP-848: mounted / has-data members are NO LONGER a pre-flight refusal
    # here — first-run drives arrive automounted, so refusing them dead-ended
    # the wizard with no unmount path. The confirm phrase already names every
    # member (the gate above), so the execute step performs a managed teardown:
    # clean non-lazy unmount of each member's mounts, then wipefs, then mdadm.
    # The OS-disk refusal stays unconditional and runs HERE — before any
    # unmount or wipe can touch anything.
    for m in "${MEMBERS[@]}"; do
      if is_os_disk "$m"; then die "refusing: $m is (or backs) the OS/boot/system disk"; fi
    done
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
      # Managed teardown (unmount + wipefs every member) first, then mdadm
      # --create with an explicit level + member count; --run avoids the
      # interactive "continue creating array?" prompt. No auto-anything.
      printf 'unmount+wipefs members -> mdadm --create %s --level=%s --raid-devices=%s --run %s' \
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
    # WARP-848 managed teardown. Two phases so NOTHING is destroyed until
    # EVERY member has released cleanly: (1) unmount each member's mounts —
    # non-lazy; a real EBUSY dies naming the mountpoint before any wipe —
    # then (2) clear each member's filesystem signature so mdadm starts from
    # clean metal. The OS-disk refusal already ran in the pre-flight, before
    # any of this. The typed confirm phrase naming every member is the
    # consent for the erase.
    for m in "${MEMBERS[@]}"; do
      teardown_mounts_of "$m" "refusing: pool_create member $m"
    done
    # WARP-848 belt-and-braces: members are expected to be WHOLE-DISK nodes
    # (the dashboard sends them, and tearing one down releases every child
    # partition via the kernel PKNAME topology). If some OTHER caller sends a
    # PARTITION member, the teardown above released only that partition's own
    # mounts — a SIBLING partition on the same physical disk can still be
    # mounted (and would re-automount every boot), so wipefs+mdadm below would
    # silently under-deliver the whole-disk erase the confirm phrase promised.
    # Fail CLOSED before anything is wiped. ("mounted"/"busy" keeps the
    # message inside the dashboard's friendlyCreateError mapping.)
    for m in "${MEMBERS[@]}"; do
      parent="$(lsblk -ndo PKNAME "$m" 2>/dev/null || true)"
      [ -n "$parent" ] || continue   # whole-disk node — fully covered above
      if [ -n "$(mounts_backed_by "/dev/$parent")" ]; then
        die "refusing: pool_create member $m is a partition of /dev/$parent and another filesystem on that disk is still mounted (busy) — pool members must be whole disks"
      fi
    done
    for m in "${MEMBERS[@]}"; do
      wipefs -a "$m"
    done
    mdadm --create "$MD" --level="$LEVEL" \
      --raid-devices="${#MEMBERS[@]}" --run "${MEMBERS[@]}"
    ;;
  pool_destroy)
    # Validate $DEVICE is a bare md name (e.g. md0) to prevent path-traversal
    # attacks where a crafted value like "md0/../md1" passes the confirm-phrase
    # gate (basename reduces it to "md1") but the sysfs glob resolves to the
    # wrong array, stopping and zeroing unintended members.
    [[ "$DEVICE" =~ ^md[0-9]+$ ]] || die "invalid device '$DEVICE': must match md[0-9]+"
    # Capture members BEFORE --stop, then stop, then wipe each member's md
    # superblock so the disk is reusable and no stale array re-assembles on the
    # next boot. Order matters: `mdadm --stop` tears down the md device and
    # removes /sys/block/$DEVICE, so the slaves glob must be read first — read
    # it after --stop and it matches nothing, leaving every superblock intact.
    # >>> pool_destroy member wipe (capture members BEFORE --stop)
    members=()
    for slave in /sys/block/"$DEVICE"/slaves/*; do
      [ -e "$slave" ] || continue
      members+=("/dev/$(basename "$slave")")
    done
    mdadm --stop "$MD" || true
    for member in "${members[@]}"; do
      mdadm --zero-superblock "$member" || true
    done
    # <<< pool_destroy member wipe
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
    # 1) Release everything actually mounted from this disk (e.g. it was
    #    auto-mounted on plug): partitions first, the disk node itself ONLY if
    #    it is genuinely a mount source. WARP-848: the old code asked
    #    is_mounted() about the whole-disk node — whose lsblk fallback reports
    #    CHILD partition mountpoints — then ran `umount /dev/sdX` on a node
    #    that was never mounted and died on "not mounted" before its partition
    #    loop could run. teardown_mounts_of enumerates real mount sources via
    #    findmnt, tolerates "not mounted", and STILL FAILS LOUDLY on a busy
    #    device — a destructive wipe must never lazy-unmount a drive with open
    #    file handles (mirrors eject_drive's policy; adopt is MORE destructive).
    teardown_mounts_of "$MD" "refusing to adopt $MD"
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
    #    the device-bridge surfaces it. Reboot persistence comes from the udev
    #    automount rule, which matches WHOLE-DISK nodes as of WARP-936 —
    #    before that it matched partitions only, so this whole-device
    #    filesystem went dark on every reboot despite the old comment's claim.
    #    WARP-868: use host_mount so the mount lands in the HOST namespace, not
    #    this unit's private slave-propagation namespace (which is destroyed on
    #    unit exit, leaving the drive unmounted until the next udev automount).
    adopt_uuid="$(blkid -o value -s UUID "$MD" 2>/dev/null || true)"
    adopt_mnt="/mnt/droplet/${LABEL:-${adopt_uuid:-$(basename "$MD")}}"
    mkdir -p "$adopt_mnt"
    host_mount "$MD" "$adopt_mnt"
    ;;
esac

emit_ok
