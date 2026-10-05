#!/bin/bash
# droplet-automount.sh — auto-mount USB drives on the inference host and register them
# with Nextcloud + the device-bridge. Invoked by a systemd template unit
# triggered from a udev rule on add/remove.
#
# Called as:
#   droplet-automount.sh add    /dev/sda1
#   droplet-automount.sh remove /dev/sda1
#   droplet-automount.sh reconcile          (WARP-1338/WARP-1361 — oneshot,
#                                            boot-time: mount assembled-but-
#                                            unmounted droplet pool arrays,
#                                            then register already-mounted
#                                            /mnt/droplet/* paths with
#                                            Nextcloud; never mounts foreign
#                                            or untrusted media)
#
# Mount point convention: /mnt/droplet/<label>-<short-uuid> (human-friendly
# but unambiguous). State file at /var/lib/droplet-automount/mounts.json
# tracks what we've mounted so we clean up on remove.
#
# WARP-3513 — encrypted BAY drives. Every drive prepared through the dashboard
# is LUKS2 (TPM2 + recovery key) with an ext4 `-O quota,project` inside, and has
# an /etc/crypttab line `droplet-bay-<luks8> UUID=<luks-uuid> ...`. That line is
# what makes a LUKS container a BAY here (hot-plugged USB LUKS drives have none
# and keep today's droplet-usb-<luks8> behaviour). systemd-cryptsetup normally
# unlocks the bay before this script runs; a hot-plugged or late-unlocked bay is
# unlocked here with ONE bounded TPM attach. A bay is named from the
# filesystem INSIDE the container, mounts prjquota, is never chowned, and is
# registered with Nextcloud at <mount>/files only. A missing or locked bay is
# logged and skipped with exit 0 — it must never block boot.

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
# WARP-1361 seam: where block-device nodes live. The reconcile's pool-mount
# safety net enumerates md array nodes here; tests point it at a tmp dir.
DEV_DIR="${DROPLET_AUTOMOUNT_DEV_DIR:-/dev}"

# WARP-232 seams (test-only overrides; production uses the defaults).
USB_ENROLL="${DROPLET_AUTOMOUNT_USB_ENROLL:-/usr/local/sbin/droplet-usb-enroll.sh}"
SYSTEMD_CRYPTSETUP="${DROPLET_SYSTEMD_CRYPTSETUP_BIN:-/usr/lib/systemd/systemd-cryptsetup}"
CRYPTSETUP="${DROPLET_CRYPTSETUP_BIN:-cryptsetup}"

# WARP-3513 seam (test-only override; production uses the default): the crypttab
# whose `droplet-bay-<luks8>` lines mark a LUKS container as an encrypted bay.
CRYPTTAB="${DROPLET_AUTOMOUNT_CRYPTTAB:-/etc/crypttab}"

# WARP-3513: the ext4 project id of a bay's files/ directory (the household
# files Nextcloud sees). WARP-3514 puts the recordings' nvr/ at 4096 and sets the
# byte limits; this is the same constant the prepare script uses
# (droplet-storage-pool.sh BAY_FILES_PROJID) - keep the two in step.
BAY_FILES_PROJID=4097

# WARP-1338: the shipping compose project is `droplet`, so the container is
# droplet-nextcloud-1 (the old docker-nextcloud-1 default never matched a
# live box). Provisioning still pins it via /etc/droplet/automount.env, which
# the root units load with EnvironmentFile=.
NEXTCLOUD_CONTAINER="${NEXTCLOUD_CONTAINER:-droplet-nextcloud-1}"
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

# WARP-1361: every line goes to the log file AND the journal (logger tag
# droplet-automount). The live md127 no-mount was undiagnosable because the
# only trace lived in a file nobody tails — `journalctl -t droplet-automount`
# must tell the whole story, including every skip reason.
log() {
  printf "%s [%s] %s\n" "$(date -Iseconds)" "$ACTION" "$*" >> "$LOG_FILE"
  command -v logger >/dev/null 2>&1 \
    && logger -t droplet-automount -- "[$ACTION] $*" 2>/dev/null || true
}

# WARP-3513: WARNING-priority log() for the conditions an operator must not
# miss (a prjquota mount that was refused, a files/ directory that could not be
# given its project id). Same file + journal destinations, but the journal entry
# carries priority daemon.warning so
# `journalctl -p warning -t droplet-automount` finds it.
log_warn() {
  printf "%s [%s] WARNING: %s\n" "$(date -Iseconds)" "$ACTION" "$*" >> "$LOG_FILE"
  command -v logger >/dev/null 2>&1 \
    && logger -p daemon.warning -t droplet-automount -- "[$ACTION] WARNING: $*" 2>/dev/null || true
}

if [ -z "$ACTION" ] || { [ "$ACTION" != "reconcile" ] && [ -z "$DEVICE" ]; }; then
  log "usage: $0 add|remove /dev/sdX1 | reconcile"
  exit 1
fi

# WARP-2151: resolve the PHYSICAL DISK(S) beneath any block node by walking
# lsblk's inverse tree. One PKNAME hop is NOT enough — on an LVM root the
# source is /dev/mapper/<vg>-<lv>, whose PKNAME is the PV *partition*
# (nvme0n1p3), so the old sibling comparisons matched nothing and the ESP +
# /boot were unmounted and re-adopted as user drives (fresh 0.2.2.1 install
# 2026-08-24; the same silent /boot divergence was found on the customer box
# 2026-08-13). Same walk the device-bridge uses for whole-disk resolution.
phys_disks_of() {
  # `|| true`: under set -e/pipefail a device that vanished mid-event must
  # yield an empty set (guard stands down), not abort the whole script.
  lsblk -rnso NAME,TYPE "$1" 2>/dev/null | awk '$2 == "disk" { print $1 }' | sort -u || true
}

# WARP-2152: the live install medium is not user storage. The stick stays
# plugged in (WARP-2143 flips boot priority instead of demanding a pull), so
# every boot delivers add events for the hybrid-ISO disk node, its ESP and
# its 'writable' persistence partition — the disk node's mount attempt fails
# EBUSY (a red unit every boot) and the persistence partition surfaced in the
# dashboard as a ~55 GB USB drive. Any node whose disk ancestry carries an
# iso9660 filesystem labelled DROPLET_* (the volid the ISO build stamps) is
# install media.
is_install_medium() {
  local _disk
  for _disk in $(phys_disks_of "$1"); do
    if lsblk -rno FSTYPE,LABEL "/dev/${_disk}" 2>/dev/null \
         | grep -q '^iso9660 DROPLET_'; then
      return 0
    fi
  done
  return 1
}

# The per-device guards below only make sense for udev add/remove events;
# `reconcile` carries no device (it walks the already-mounted paths).
if [ "$ACTION" != "reconcile" ]; then

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
# WARP-2151: compare PHYSICAL DISK SETS (phys_disks_of), not one PKNAME hop —
# the one-hop comparison never matched the ESP/boot partitions on an LVM
# root. WARP-1361 semantics preserved: an unresolvable root (overlay,
# still-assembling md) leaves the boot set empty and the guard stands down
# rather than skipping the device that most needed mounting, and an md
# array's ancestry resolves to its member disks, never the OS disk.
boot_src="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
boot_disks="$(phys_disks_of "$boot_src")"
dev_disks="$(phys_disks_of "$DEVICE")"
skip_boot_sibling=0
if [ "$DEVICE" = "$boot_src" ]; then
  skip_boot_sibling=1
elif [ -n "$boot_disks" ]; then
  for _d in $dev_disks; do
    if printf '%s\n' "$boot_disks" | grep -qxF "$_d"; then
      skip_boot_sibling=1
      break
    fi
  done
fi
if [ "$skip_boot_sibling" = 1 ]; then
  log "skip $DEVICE (holds rootfs / sibling of boot device)"
  exit 0
fi

# WARP-2152: never adopt the droplet install medium (see is_install_medium).
if is_install_medium "$DEVICE"; then
  log "skip $DEVICE (droplet install medium — not user storage)"
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

fi # per-device guards (add/remove only)

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

# WARP-3513: bay_crypttab_has <luks8> — true iff the (readable) crypttab has a
# line whose FIRST field is exactly droplet-bay-<luks8> with something after it
# (the device column). That line is the whole bay discriminator: the prepare
# script writes it for every encrypted drive, a hot-plugged USB LUKS drive never
# has one. Plain string comparison on the first field — the LUKS uuid prefix
# comes off a drive's header, so it is never fed to a regex; a comment or a
# longer name that merely starts with ours cannot match. A missing crypttab is
# simply "no".
bay_crypttab_has() {
  local short="$1" ct_name="" ct_rest=""
  [ -n "$short" ] && [ -r "$CRYPTTAB" ] || return 1
  while read -r ct_name ct_rest || [ -n "$ct_name" ]; do
    if [ "$ct_name" = "droplet-bay-${short}" ] && [ -n "$ct_rest" ]; then
      return 0
    fi
  done < "$CRYPTTAB"
  return 1
}

# WARP-232: try to unlock a droplet-enrolled LUKS2 drive. Sets the global
# UNLOCKED_MAPPER (/dev/mapper/droplet-usb-<short-uuid>) and returns 0 on
# success; returns 1 for a foreign LUKS container (no droplet token, no
# derivable slot) so the caller can skip it cleanly.
#
# WARP-3513: a container with a crypttab `droplet-bay-<luks8>` line is an
# encrypted BAY and takes its own branch: it returns 0 with UNLOCKED_MAPPER =
# /dev/mapper/droplet-bay-<luks8> and IS_BAY=1 — either because systemd-
# cryptsetup already unlocked it (the live mapper node is reused, nothing is
# attached or opened again) or after ONE bounded, non-interactive TPM attach —
# or returns 2 when it is still locked, so the caller can log the LOCKED line
# and exit 0 (a locked bay must never block boot). A bay never takes the
# derived-passphrase fallback below: its only keys are the TPM slot and the
# owner-held recovery key. BAY_NAME / BAY_UNLOCK_DETAIL feed the caller's log.
UNLOCKED_MAPPER=""
IS_BAY=0
BAY_NAME=""
BAY_UNLOCK_DETAIL=""
try_unlock_droplet_luks() {
  local dev="$1"
  local luks_uuid short mapper
  luks_uuid="$(blkid -o value -s UUID "$dev" 2>/dev/null || true)"
  luks_uuid="${luks_uuid//$'\n'/}"
  short="$(printf '%s' "$luks_uuid" | head -c 8)"
  [ -z "$short" ] && short="usb"
  mapper="droplet-usb-${short}"

  if [ -n "$luks_uuid" ] && bay_crypttab_has "$short"; then
    BAY_NAME="droplet-bay-${short}"
    local bay_node="${DEV_DIR}/mapper/${BAY_NAME}" attach_out="" attach_rc=0
    if [ ! -e "$bay_node" ]; then
      # One attempt, bounded (a wedged TPM must not hold the unit), headless
      # (never prompt: nobody is at the console) and tries=1. stdin is
      # /dev/null for the same reason; stderr is kept for the LOCKED line.
      attach_out="$(timeout 60 "$SYSTEMD_CRYPTSETUP" attach "$BAY_NAME" "$dev" - \
        tpm2-device=auto,headless=true,tries=1 </dev/null 2>&1)" || attach_rc=$?
      attach_out="${attach_out%%$'\n'*}"
      attach_out="${attach_out//$'\r'/}"
      BAY_UNLOCK_DETAIL="systemd-cryptsetup attach exit ${attach_rc}${attach_out:+: ${attach_out:0:200}}"
    fi
    # Re-check the node rather than trusting the exit status: a racing
    # systemd-cryptsetup@ unit may have unlocked it while we were attaching
    # (our attach then fails "already exists" — and the drive is open).
    if [ -e "$bay_node" ]; then
      UNLOCKED_MAPPER="/dev/mapper/${BAY_NAME}"
      IS_BAY=1
      return 0
    fi
    return 2
  fi

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

# WARP-1361: md-node helpers.
# is_md_node <dev>: true for an md array node (any path — the tests point
# DEV_DIR at a tmp dir, so never match on the /dev prefix alone).
is_md_node() {
  case "$(basename "$1")" in
    md[0-9]*) return 0 ;;
  esac
  return 1
}

# is_droplet_md <dev>: true iff the array carries the droplet raid signature.
# Droplet pools are created ON the box by droplet-storage-pool.sh (mdadm
# --create with no --name/--homehost override), so the superblock name is
# "<box-hostname>:<N>" — mdadm's "local to host" convention; the shipping
# hostname is droplet-sys. A foreign array (hot-plugged disk set carrying an
# alien superblock — mdadm's incremental-assembly udev rules WILL
# auto-assemble it, WARP-936) carries some other homehost and must never be
# blanket-trusted. Fails closed: no mdadm / no name → not ours.
is_droplet_md() {
  local dev="$1" md_name md_home host
  md_name="$({ mdadm --detail --export "$dev" 2>/dev/null || true; } \
    | grep -E '^MD_NAME=' | head -1 | cut -d= -f2- || true)"
  md_name="${md_name//$'\n'/}"; md_name="${md_name//$'\r'/}"
  [ -n "$md_name" ] || return 1
  md_home="${md_name%%:*}"
  host="$(hostname 2>/dev/null || true)"
  if [ -n "$host" ] && [ "$md_home" = "$host" ]; then
    return 0
  fi
  # Accept the shipping droplet-sys convention even when the box hostname
  # has since changed — a renamed box must not orphan its own pool. EXACTLY
  # droplet-sys, never a droplet* prefix: "dropletnas" et al. are strangers.
  # WARP-1361 review: the homehost signature is attacker-writable (a crafted
  # superblock can claim droplet-sys:N or the box hostname) — it is a
  # CONVENTION, not a security boundary. The planned follow-up tightens md
  # trust to trusted.list / StoragePool state and drops this fallback once
  # live boxes have converged (the reconcile seeds trusted.list every boot).
  if [ "$md_home" = "droplet-sys" ]; then
    return 0
  fi
  return 1
}

# WARP-3513: fs_has_project_quota <dev> — true iff <dev> is an ext4 whose
# superblock carries the `project` feature (what `mkfs.ext4 -O quota,project`
# sets on every drive prepared since the encrypted-bay work). Only then is it
# mounted prjquota, so the per-directory byte limits the recordings allocation
# sets are ENFORCED. Parsed from the "Filesystem features:" line of
# `tune2fs -l` as a whole word; the output is captured FIRST (never
# `tune2fs -l | grep -q`: under pipefail a match closes the pipe early and the
# SIGPIPE turns a MATCH into a failed pipeline). A tune2fs that is not
# installed (exit 127) or cannot read the superblock is "no" — logged, never
# fatal: the drive then simply mounts without prjquota.
fs_has_project_quota() {
  local dev="$1" out line feats rc=0
  out="$(tune2fs -l "$dev" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "tune2fs -l $dev failed (exit $rc; 127 = tune2fs not installed) — cannot check the ext4 project-quota feature; mounting without prjquota"
    return 1
  fi
  while IFS= read -r line; do
    case "$line" in
      "Filesystem features:"*)
        feats=" ${line#Filesystem features:} "
        feats="${feats//$'\t'/ }"
        case "$feats" in
          *" project "*) return 0 ;;
        esac
        return 1 ;;
    esac
  done <<< "$out"
  return 1
}

nc_occ() {
  # Nextcloud's `occ` must run as UID 33 (www-data) — that's how the
  # image owns its config files. Using `docker exec -u 33` avoids the
  # "Owner id of config.php: 33" warning + permission denial.
  docker exec -u 33 "$NEXTCLOUD_CONTAINER" php occ "$@"
}

# WARP-3513: ensure <mount>/files exists — the ONLY directory of an encrypted
# bay that Nextcloud may see. Created owner 33:33 (Nextcloud's www-data) mode
# 0770 with ext4 project id $BAY_FILES_PROJID (inherited by everything created
# inside, so the household files can be given their own byte limit), and ONLY
# when it is missing: the prepare script already did all of that for every bay,
# and an existing files/ keeps whatever owner/mode/project it has. Never
# recursive — a recursive chown would break the uid-33 files Nextcloud wrote and
# the root-only nvr/ directory. Returns 1 when it cannot be created (read-only
# filesystem, a regular file in the way). The project id is best-effort HERE
# (a warning, not a failure — registering the folder beats refusing it; the
# prepare script, which owns the guarantee, treats the same failure as fatal).
ensure_files_dir() {
  local dir="$1/files"
  [ -d "$dir" ] && return 0
  mkdir -p "$dir" 2>/dev/null || return 1
  chown 33:33 "$dir" 2>/dev/null \
    || log_warn "could not chown $dir to 33:33 — Nextcloud may be unable to write there"
  chmod 0770 "$dir" 2>/dev/null \
    || log_warn "could not chmod 0770 $dir"
  chattr +P -p "$BAY_FILES_PROJID" "$dir" 2>/dev/null \
    || log_warn "could not set project id $BAY_FILES_PROJID on $dir — the household files will not be covered by a project quota until it is set (chattr +P -p $BAY_FILES_PROJID $dir)"
  log "created $dir (33:33, 0770, project $BAY_FILES_PROJID)"
  return 0
}

# nextcloud_add <mount> <name> [scope]
# WARP-3513: scope is `root` (the default — registers /host/<name>, the whole
# drive, which is what every plain/USB drive does) or `files` (registers
# /host/<name>/files — what an encrypted bay does, so nvr/, lost+found and the
# rest of the drive never reach Nextcloud). Idempotent for BOTH forms.
nextcloud_add() {
  local mount="$1"
  local name="$2"
  local scope="${3:-root}"
  local datadir="/host/$name"
  if [ "$scope" = "files" ]; then
    datadir="/host/$name/files"
  fi
  if ! nc_occ app:enable files_external >/dev/null 2>&1; then
    log "failed to enable files_external; is nextcloud running?"
    return 1
  fi
  # WARP-1338: occ's json escapes slashes ("\/host\/x"); the old pattern
  # (`\\?/host/...`) matched a literal `\?` — i.e. NOTHING, in either output
  # shape — so every re-run created a DUPLICATE external mount. Normalize the
  # escaping away, then fixed-string match (the boot reconcile re-runs this
  # on every boot, so the idempotency check must actually work).
  # WARP-3513: the quote that closes `"datadir":"/host/<name>"` means that
  # pattern never matches the files form (`.../files"`), so BOTH forms are
  # looked for explicitly. The listing is captured first and matched in the
  # shell — no `| grep -q` under pipefail, where an early match can turn into a
  # SIGPIPE failure.
  local reg_list has_root=0 has_files=0
  reg_list="$(nc_occ files_external:list --output=json 2>/dev/null | tr -d '\\' || true)"
  case "$reg_list" in
    *"\"datadir\":\"/host/$name\""*) has_root=1 ;;
  esac
  case "$reg_list" in
    *"\"datadir\":\"/host/$name/files\""*) has_files=1 ;;
  esac
  if [ "$scope" = "files" ]; then
    if [ "$has_files" = 1 ]; then
      log "nextcloud: already registered $name"
      return 0
    fi
    if [ "$has_root" = 1 ]; then
      # A drive-ROOT registration of this very name (a bay is only ever
      # registered at files/, so this is not something Droplet made for it). A
      # second registration would be a duplicate in every user's Files root AND
      # a second route to the whole drive — leave it, nothing is re-pointed.
      log "nextcloud: $name is already registered at the drive ROOT (/host/$name) — not creating a files-scope duplicate"
      return 0
    fi
    if ! ensure_files_dir "$mount"; then
      log "nextcloud: cannot create $mount/files — registration of $name skipped"
      return 1
    fi
  elif [ "$has_root" = 1 ] || [ "$has_files" = 1 ]; then
    log "nextcloud: already registered $name"
    return 0
  fi
  local rc
  # WARP-1338: NO files_external:applicable scoping. Browsing acts as each
  # user's OWN Nextcloud account (orchestrator files.ts), so the old
  # `--add-user=admin` scoping made every registration invisible to the whole
  # household except the bootstrap admin. An unscoped external mount is
  # visible to every user — exactly the household-wide posture we want.
  rc=$(nc_occ files_external:create \
        "/$name" local null::null -c datadir="$datadir" 2>&1) || true
  log "nextcloud create: $rc"
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
  # PYNET-009: serialize the read-modify-write of mounts.json. Concurrent
  # automount@ instances (boot coldplug, or a multi-partition drive firing
  # sda1+sda2 together) otherwise race and silently drop a drive's entry — its
  # REMOVE then never unmounts it or closes the LUKS mapper. Lock held only for
  # the state op, not the slow mount/chown.
  (
    flock 9
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
  ) 9>"${STATE_DIR}/.lock"
}

state_remove() {
  local device="$1"
  # Prints, per removed entry, a TAB-separated "<mount>\t<mapper>" line so the
  # remove path can unmount AND close the mapper (mapper empty for plain drives).
  # PYNET-009: same flock as state_add — serialize the mounts.json mutation.
  (
    flock 9
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
  ) 9>"${STATE_DIR}/.lock"
}

case "$ACTION" in
  add)
    # WARP-1361 review: per-device lock around the whole probe+mount+register
    # section. The boot reconcile spawns `add` for an assembled-but-unmounted
    # array while the udev coldplug add for the SAME node may still be inside
    # its settle loop below — both paths are check-then-mount, so without a
    # shared lock the loser can stack a duplicate mount and double-register
    # the drive with Nextcloud (the duplicate class WARP-1338 fixed). Held on
    # an inherited fd until this invocation exits; state_add's fd-9 flock
    # (mounts.json) is unrelated and nests fine. The lock key is the device
    # basename, charset-guarded (udev hands us /dev/%I, but never trust an
    # argument as a path component).
    lock_key="${DEVICE##*/}"
    lock_key="${lock_key//[^A-Za-z0-9._-]/_}"
    exec 8>>"${STATE_DIR}/.lock-dev-${lock_key}"
    flock 8
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
    if [ -z "${TYPE:-}" ] && is_md_node "$DEVICE"; then
      # WARP-1361: at boot the add uevent for an md node can fire while the
      # array is still assembling — blkid sees no filesystem until the array
      # goes active, and nothing re-fires on the later activation change
      # event (the udev rule matches add|remove only). Bailing on probe #1
      # silently lost the live box's pool until manual intervention. Give
      # the array a BOUNDED settle window and re-probe; the boot reconcile
      # is the backstop if it still isn't ready.
      settle_tries="${DROPLET_MD_SETTLE_TRIES:-10}"
      settle_interval="${DROPLET_MD_SETTLE_INTERVAL:-1}"
      settle_i=0
      while [ -z "${TYPE:-}" ] && [ "$settle_i" -lt "$settle_tries" ]; do
        settle_i=$((settle_i + 1))
        sleep "$settle_interval"
        TYPE="$(blkid -o value -s TYPE "$DEVICE" 2>/dev/null || true)"
        TYPE="${TYPE//$'\n'/}"; TYPE="${TYPE//$'\r'/}"
      done
      if [ -n "${TYPE:-}" ]; then
        log "$DEVICE md array became readable after ${settle_i} re-probe(s) (type=$TYPE)"
        LABEL="$(blkid -o value -s LABEL "$DEVICE" 2>/dev/null || true)"
        UUID="$(blkid -o value -s UUID "$DEVICE" 2>/dev/null || true)"
        LABEL="${LABEL//$'\n'/}"; LABEL="${LABEL//$'\r'/}"
        UUID="${UUID//$'\n'/}"; UUID="${UUID//$'\r'/}"
      else
        log "skip $DEVICE (md array: no readable filesystem after ${settle_tries} re-probes — still assembling, or never formatted; the boot reconcile will retry)"
        exit 0
      fi
    fi
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
        # WARP-3513: try_unlock_droplet_luks answers 0 (unlocked), 1 (foreign)
        # or 2 (an encrypted bay that is STILL locked). `|| rc=$?` keeps the
        # three-way answer alive under set -e.
        unlock_rc=0
        try_unlock_droplet_luks "$DEVICE" || unlock_rc=$?
        case "$unlock_rc" in
          0)
            MAPPER_DEVICE="$UNLOCKED_MAPPER"
            DEVICE="$UNLOCKED_MAPPER"           # fall through to the mount path
            TRUST="enrolled"
            if [ "$IS_BAY" = 1 ]; then
              # WARP-3513: a bay is named, registered and recorded from the
              # filesystem INSIDE the container — exactly like creation time
              # (<label>-<fs-uuid8>) — not from the LUKS container's own
              # uuid, which is all the pre-unlock probe above saw. Same
              # newline/CR stripping as the backing probe.
              TYPE="$(blkid -o value -s TYPE "$DEVICE" 2>/dev/null || true)"
              LABEL="$(blkid -o value -s LABEL "$DEVICE" 2>/dev/null || true)"
              UUID="$(blkid -o value -s UUID "$DEVICE" 2>/dev/null || true)"
              TYPE="${TYPE//$'\n'/}"; TYPE="${TYPE//$'\r'/}"
              LABEL="${LABEL//$'\n'/}"; LABEL="${LABEL//$'\r'/}"
              UUID="${UUID//$'\n'/}"; UUID="${UUID//$'\r'/}"
              if [ -z "$TYPE" ]; then
                # e.g. a prepare interrupted between luksFormat and mkfs.
                log "skip $BACKING_DEVICE (bay $BAY_NAME is unlocked but carries no readable filesystem — nothing to mount)"
                exit 0
              fi
            else
              TYPE="$(blkid -o value -s TYPE "$DEVICE" 2>/dev/null || echo ext4)"
            fi
            ;;
          2)
            # WARP-3513: a crypttab bay the TPM could not open (PCR change, a
            # moved box). Not an error and never a blocked boot: say so in
            # words an operator can act on, mount nothing, exit 0. The boot
            # reconcile tries again next boot; the owner's recovery key is
            # the way in meanwhile.
            log "LOCKED $DEVICE ($BAY_NAME): encrypted bay could not be unlocked (${BAY_UNLOCK_DETAIL:-no attach attempted}) — needs the recovery key; not mounted, will retry on the next boot/reconcile"
            exit 0
            ;;
          *)
            log "skip $DEVICE (foreign LUKS container — not droplet-enrolled)"
            exit 0
            ;;
        esac
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
    SHORT_UUID="$(echo "${UUID:-}" | head -c 8)"
    if is_md_node "$BACKING_DEVICE" && [ -z "${LABEL:-}" ] && [ -n "${UUID:-}" ] \
       && [ "$IS_BAY" != 1 ]; then
      # WARP-1361: LEGACY pool. Pre-WARP-1338 pool_format labeled nothing and
      # mounted at /mnt/droplet/<fs-uuid> — the dashboard, the Nextcloud
      # registration and the owner's bookmarks all point at that GUID path,
      # so a reboot must NEVER rename it (the generic derivation below would
      # move it to drive-<short-uuid>). New pools are labeled ("pool") at
      # mkfs time and take the stable <label>-<short-uuid> name.
      # WARP-1361 review: same charset guard as the label path — blkid UUIDs
      # are hex+dashes today (byte-identical through this guard), but blkid
      # output is never trusted as a path component.
      # WARP-3513: never for a BAY — an encrypted pool is new, has no legacy
      # GUID path to preserve, and an unlabeled filesystem inside one takes
      # the generic drive-<fs-uuid8> name below like any other bay.
      NAME="${UUID//[^A-Za-z0-9._-]/-}"
      log "$BACKING_DEVICE is an unlabeled md pool filesystem — keeping its legacy mount name $NAME"
    else
      LABEL="${LABEL:-drive}"
      NAME="$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-\+//;s/-\+$//')"
      # A label of "." or ".." (or any run of only dots) survives the charset
      # filter unchanged — MOUNT="${MOUNT_BASE}/.." would then resolve OUTSIDE
      # the mount base (its parent directory), and WARP-1338's Nextcloud
      # auto-registration would expose that parent as browsable storage.
      case "$NAME" in
        ''|*[!.]*) : ;;
        *) NAME="" ;;
      esac
      [ -z "$NAME" ] && NAME="drive"
      if [ -n "$SHORT_UUID" ]; then
        NAME="${NAME}-${SHORT_UUID}"
      fi
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
      if is_md_node "$BACKING_DEVICE"; then
        # WARP-1361: an md array is trusted only when (a) its fs UUID is on
        # the operator trust list (new pools — pool_format/adopt seed it at
        # creation), or (b) the array carries the droplet raid signature
        # (mdadm homehost — legacy pools made on-box before seeding
        # existed). The old blanket /dev/md* trust was the residual
        # supply-chain gap the WARP-1338 review flagged: mdadm's
        # incremental-assembly udev rules auto-assemble any hot-plugged
        # disk set carrying a crafted superblock, and md nodes match the
        # automount rule — a FOREIGN array must follow the untrusted
        # read-only path like any unknown stick.
        if [ -n "${UUID:-}" ] && [ -f "$TRUSTED_LIST" ] \
           && grep -qxF "$UUID" "$TRUSTED_LIST" 2>/dev/null; then
          TRUST="trusted"
        elif is_droplet_md "$BACKING_DEVICE"; then
          TRUST="trusted"
          # Converge legacy pools onto explicit trust-list membership at
          # mount time (grep-guarded, idempotent, best-effort) — the boot
          # reconcile seeds too, but the udev add path must not depend on
          # it having run.
          if [ -n "${UUID:-}" ] \
             && ! grep -qxF "$UUID" "$TRUSTED_LIST" 2>/dev/null; then
            printf '%s\n' "$UUID" >> "$TRUSTED_LIST" 2>/dev/null \
              && log "seeded trusted.list with droplet md-pool uuid $UUID" \
              || true
          fi
        else
          TRUST="untrusted-ro"
          log "foreign md array $BACKING_DEVICE (no droplet signature, uuid not on trusted.list) — mounting read-only"
        fi
      else
        if [ -n "${UUID:-}" ] && [ -f "$TRUSTED_LIST" ] \
           && grep -qxF "$UUID" "$TRUSTED_LIST" 2>/dev/null; then
          TRUST="trusted"
        else
          TRUST="untrusted-ro"
        fi
      fi
    fi
    # rw for enrolled/trusted drives, ro for untrusted ones.
    if [ "$TRUST" = "untrusted-ro" ]; then
      RW_MODE="ro"
    else
      RW_MODE="rw"
    fi

    # Hostile-media options. This script runs as ROOT out of a udev unit and
    # mounts whatever partition appears, so the media is attacker-supplied by
    # definition on a box anyone can reach a USB port on.
    #
    # `ro` is NOT a mitigation for this: a read-only mount executes setuid-root
    # binaries and honours device nodes exactly like a read-write one. The
    # untrusted-ro branch above picked the right trust model and then handed it
    # to a mount that still trusted the media.
    #
    # nosuid,nodev UNCONDITIONALLY, including trusted and enrolled drives.
    # These are DATA drives (documents, media, the NVR pool); a setuid binary
    # or a device node on one is never legitimate, and "we enrolled it" says
    # the disk is ours, not that its contents are.
    #
    # noexec ONLY on untrusted media. Deliberately not unconditional: the same
    # branch mounts the md RAID pool, and an operator keeping a script on their
    # own pool is a reasonable thing this must not break.
    HARDEN="nosuid,nodev"
    if [ "$TRUST" = "untrusted-ro" ]; then
      HARDEN="${HARDEN},noexec"
    fi

    # WARP-1361: the md array whose read-only state the mount path may have to
    # flip with `mdadm --readwrite`. A plain md pool IS the mounted device.
    # WARP-3513: an encrypted pool mounts the LUKS mapper instead, so there the
    # array is the BACKING device — the same read-only-array recovery must
    # still apply once pools are encrypted.
    MD_NODE=""
    if is_md_node "$DEVICE"; then
      MD_NODE="$DEVICE"
    elif [ "$IS_BAY" = 1 ] && is_md_node "$BACKING_DEVICE"; then
      MD_NODE="$BACKING_DEVICE"
    fi

    # If something already mounted this device at a STALE PATH UNDER OUR OWN
    # BASE (re-enumerated /dev/sdX after a re-plug, a desktop distro's
    # udisks), unmount it so we can reseat it at the derived path — that's
    # the path Nextcloud + the display bridge agree on.
    # WARP-2151: a mount anywhere OUTSIDE $MOUNT_BASE is system-managed —
    # fstab (/boot, /boot/efi, a pool pinned at /mnt/nvr) or an operator
    # action — and stealing it is how the live box lost /boot and the ESP
    # ("already mounted at /boot; unmounting to relocate"). Skip the device
    # entirely instead.
    existing=$(findmnt -n -o TARGET --source "$DEVICE" 2>/dev/null | head -1 || true)
    if [ -n "$existing" ] && [ "$existing" != "$MOUNT" ]; then
      case "$existing" in
        "$MOUNT_BASE"/*)
          log "$DEVICE already mounted at $existing; unmounting to relocate"
          umount "$existing" 2>/dev/null || umount -l "$existing" 2>/dev/null || true
          ;;
        *)
          log "skip $DEVICE (system mount at $existing — not relocating)"
          exit 0
          ;;
      esac
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
      # WARP-1361 review: "already mounted" is not enough — a pool that came
      # up read-only earlier (auto-read-only array mounted ro by a previous
      # boot, or a manual ro mount) would be left ro forever, exactly the
      # state AC2 exists to prevent. If this drive has earned rw, verify the
      # live mount agrees and flip it in place.
      if [ "$RW_MODE" = "rw" ]; then
        cur_opts="$(findmnt -n -o OPTIONS "$MOUNT" 2>/dev/null | head -1 || true)"
        case ",${cur_opts}," in
          *,ro,*)
            log "$MOUNT is mounted read-only but $DEVICE is trusted rw — remounting read-write"
            if [ -n "$MD_NODE" ]; then
              mdadm --readwrite "$MD_NODE" 2>/dev/null \
                || log "mdadm --readwrite $MD_NODE failed (retrying the remount anyway)"
            fi
            mount -o remount,rw "$MOUNT" 2>/dev/null \
              && log "remounted $MOUNT read-write" \
              || log "rw remount failed for $MOUNT — leaving it read-only"
            ;;
        esac
      fi
    else
      # Permissive options for FAT/exFAT/NTFS (common on USB drives).
      # ext4/xfs/btrfs will reject `uid=` options, so branch.
      # WARP-232: $RW_MODE is ro for untrusted plain drives, rw otherwise.
      MOUNT_NOTE=""
      case "$TYPE" in
        vfat|exfat|ntfs|msdos)
          mount -o "${RW_MODE},${HARDEN},noatime,uid=1000,gid=1000,umask=0002,nofail" \
            "$DEVICE" "$MOUNT" \
            || { log "mount failed for $DEVICE ($TYPE) -> $MOUNT"; rmdir "$MOUNT" 2>/dev/null || true; exit 1; }
          ;;
        *)
          MOUNT_OPTS="${RW_MODE},${HARDEN},noatime,nofail"
          # WARP-3513: an ext4 carrying the project-quota feature (every drive
          # prepared since the encrypted-bay work) mounts prjquota so the
          # per-directory limits set later are ENFORCED. ext4 without the
          # feature and every other filesystem mount exactly as before.
          PRJQUOTA_OPT=""
          if [ "$TYPE" = "ext4" ] && fs_has_project_quota "$DEVICE"; then
            PRJQUOTA_OPT=",prjquota"
          fi
          mount_ok=0
          md_retried=0
          if mount -o "${MOUNT_OPTS}${PRJQUOTA_OPT}" "$DEVICE" "$MOUNT"; then
            mount_ok=1
          elif [ "$RW_MODE" = "rw" ] && [ -n "$MD_NODE" ]; then
            # WARP-1361: a healthy-but-read-only array (mdadm auto-read-
            # only after an unclean stop, or an explicit readonly state)
            # refuses the rw mount. Flip it read-write and retry ONCE —
            # never leave a healthy pool filesystem unmounted (or ro).
            # WARP-3513: the retry is the same mount, prjquota included.
            md_retried=1
            log "mount failed for $DEVICE ($TYPE) — array may be read-only; running mdadm --readwrite and retrying"
            mdadm --readwrite "$MD_NODE" 2>/dev/null \
              || log "mdadm --readwrite $MD_NODE failed (retrying the mount anyway)"
            if mount -o "${MOUNT_OPTS}${PRJQUOTA_OPT}" "$DEVICE" "$MOUNT"; then
              mount_ok=1
            fi
          fi
          if [ "$mount_ok" = 0 ] && [ -n "$PRJQUOTA_OPT" ]; then
            # WARP-3513: the prjquota mount was refused (a kernel without
            # project-quota support, a damaged quota inode). Never leave the
            # drive dark over that: retry ONCE without it, and say so loudly —
            # the data is reachable, the limits are not enforced until fixed.
            log_warn "mount of $DEVICE with prjquota failed — retrying ONCE without it so the drive is not left unmounted; project quotas (recording limits) are NOT enforced on it until this is fixed (check dmesg and: tune2fs -l $DEVICE)"
            if mount -o "$MOUNT_OPTS" "$DEVICE" "$MOUNT"; then
              mount_ok=1
            fi
          elif [ "$mount_ok" = 1 ] && [ -n "$PRJQUOTA_OPT" ]; then
            MOUNT_NOTE=", prjquota"
          fi
          if [ "$mount_ok" = 0 ]; then
            if [ "$md_retried" = 1 ]; then
              log "mount failed for $DEVICE ($TYPE) -> $MOUNT even after mdadm --readwrite"
            else
              log "mount failed for $DEVICE ($TYPE) -> $MOUNT"
            fi
            rmdir "$MOUNT" 2>/dev/null || true
            exit 1
          fi
          # WARP-1361 review: NEVER recursive on an md pool — this path is
          # hot on every boot now, and (a) a recursive chown over a
          # terabyte-scale pool exceeds the unit's TimeoutStartSec, so
          # systemd kills the oneshot mid-add (fs mounted, but state_add +
          # registration skipped and the unit fails every boot); (b) it
          # flips the ownership of files Nextcloud wrote as uid 33 through
          # the /mnt/droplet -> /host bind, breaking uploads after reboot.
          # The mount root alone is what the droplet user needs to create
          # top-level entries (pool_format never chowns the fresh fs — this
          # covers the first mount too). Plain drives keep the recursive
          # chown: that path runs on plug events only, and FAT-family media
          # never reaches here (uid= mount options above).
          # WARP-3513: a BAY is never chowned at all, recursive or not. ITS
          # ownership is set at format time — files/ is 33:33 (Nextcloud's
          # www-data), nvr/ is root-only — and a chown here would break the
          # uid-33 files Nextcloud wrote and hand nvr/ to the droplet user.
          if [ "$RW_MODE" = "rw" ] && [ "$IS_BAY" != 1 ]; then
            if is_md_node "$BACKING_DEVICE"; then
              chown 1000:1000 "$MOUNT" 2>/dev/null || true
            else
              chown -R 1000:1000 "$MOUNT" 2>/dev/null || true
            fi
          fi
          ;;
      esac
      log "mounted $DEVICE ($TYPE, label=$LABEL, trust=$TRUST${MOUNT_NOTE}) -> $MOUNT"
    fi

    # Record the BACKING partition as `device` (so udev remove + crypto-shred
    # match the raw LUKS partition, not the plaintext mapper) and the mapper
    # separately (to close on remove). WARP-232 finding 7.
    state_add "$BACKING_DEVICE" "$MOUNT" "$LABEL" "${UUID:-}" "$TRUST" "$MAPPER_DEVICE"
    if [ "$NEXTCLOUD_AUTO_REGISTER" = "1" ]; then
      if [ "$TRUST" = "untrusted-ro" ]; then
        # WARP-1338 trust gate: never expose an untrusted hot-plugged stick
        # to Nextcloud — auto-registering unknown media is the supply-chain
        # vector the opt-in exists for (see NEXTCLOUD_AUTO_REGISTER above).
        # Enrolled/trusted drives and md-pool mounts register normally.
        log "nextcloud registration skipped for untrusted drive $NAME"
      else
        # WARP-3513: a bay exposes ONLY <mount>/files to Nextcloud — never the
        # drive root (nvr/ and lost+found live there). Everything else keeps
        # the root scope it always had.
        reg_scope="root"
        if [ "$IS_BAY" = 1 ]; then
          reg_scope="files"
        fi
        nextcloud_add "$MOUNT" "$NAME" "$reg_scope" || log "nextcloud registration skipped"
      fi
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
        umount -l "$m" && log "unmounted $m" || log "umount failed for $m"
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

  reconcile)
    # WARP-1338 — one-shot boot/upgrade reconcile, run by
    # droplet-automount-reconcile.service (oneshot, after docker): register
    # every ELIGIBLE already-mounted /mnt/droplet/* path with Nextcloud.
    # Pool mounts are created by droplet-storage-pool.sh (not this script),
    # and mounts on a fleet-upgraded box predate registration entirely —
    # this converges them. Since WARP-1361 the md loop below is the ONE
    # mounting exception: assembled-but-unmounted DROPLET pool arrays only —
    # never the install-time whole-drive sweep the installer deliberately
    # avoids, and never foreign/untrusted media.
    # Idempotent: nextcloud_add short-circuits on an existing registration.
    # Eligibility mirrors the add-path trust gate: md-pool filesystems
    # (owner-created via the confirm-gated pool flow), enrolled LUKS mappers,
    # and trusted.list'd plain drives — never an untrusted hot-plugged stick.
    #
    # WARP-1338 review — trust-list convergence for legacy md pools. The
    # add-path blanket-trusts /dev/md* only to cover pools created BEFORE
    # pool_format started seeding trusted.list; that blanket rule is itself
    # a residual supply-chain gap (mdadm's incremental-assembly udev rules
    # will auto-assemble a hot-plugged disk carrying a crafted md
    # superblock, and md nodes match the automount rule — WARP-936). Seed
    # trusted.list from every mounted md source here so live boxes converge
    # onto explicit membership — the prerequisite for a follow-up that
    # tightens md trust to trusted.list/pool-state and drops the blanket
    # rule. Runs BEFORE the Nextcloud opt-in gate below: trust is a
    # mount-time property, not a registration one. Grep-guarded append —
    # idempotent across boots — and best-effort (never a failed unit).
    #
    # WARP-3513 — encrypted BAY late-unlock, before anything else mounts.
    # systemd-cryptsetup normally unlocks every crypttab `droplet-bay-<luks8>`
    # entry BEFORE this unit runs (After=cryptsetup.target, which includes the
    # entries' x-systemd.device-timeout=30s waits), and the udev add for the
    # backing disk then mounts it. This loop is the idempotent safety net for
    # the bays that missed that window — unlocked late, an add event that fired
    # while the container was still locked, a LUKS-over-md pool whose array
    # assembled after the first look. Each crypttab bay whose backing device is
    # present and whose mapper is not mounted goes through the SAME add flow the
    # udev path runs (unlock reuse/attach, prjquota mount, state, registration).
    # An absent drive and a bay that stays locked are logged and left alone:
    # this must NEVER fail the unit or block boot, so every add failure is
    # logged and retried next boot. Not gated on NEXTCLOUD_AUTO_REGISTER —
    # mounting is independent of registration. The crypttab is read on fd 3 so
    # the add flow's own stdin can never swallow the remaining lines.
    if [ -r "$CRYPTTAB" ]; then
      ct_name=""
      while read -r -u 3 ct_name ct_src _ || [ -n "$ct_name" ]; do
        case "$ct_name" in
          droplet-bay-*) ;;
          *) continue ;;                           # comments, /data, anything else
        esac
        if ! [[ "$ct_name" =~ ^droplet-bay-[A-Za-z0-9._-]+$ ]]; then
          log "reconcile: skip a crypttab entry with unexpected characters in its name"
          continue
        fi
        case "$ct_src" in
          UUID=*) ct_uuid="${ct_src#UUID=}" ;;
          *)
            log "reconcile: bay $ct_name: crypttab source is not UUID=<luks-uuid> — cannot locate the drive; nothing to do"
            continue ;;
        esac
        if ! [[ "$ct_uuid" =~ ^[A-Za-z0-9-]+$ ]]; then
          log "reconcile: bay $ct_name: unexpected characters in the crypttab uuid — skipping"
          continue
        fi
        ct_dev="$(blkid -U "$ct_uuid" 2>/dev/null | head -1 || true)"
        ct_dev="${ct_dev//$'\n'/}"
        if [ -z "$ct_dev" ]; then
          log "reconcile: bay $ct_name: backing device (LUKS uuid $ct_uuid) not present — drive unplugged or not visible yet; nothing to do"
          continue
        fi
        if findmnt -n -o TARGET --source "/dev/mapper/${ct_name}" >/dev/null 2>&1; then
          log "reconcile: bay $ct_name already mounted — nothing to do"
          continue
        fi
        log "reconcile: bay $ct_name is present but not mounted — running the add flow for $ct_dev"
        "$BASH" "$0" add "$ct_dev" </dev/null \
          || log "reconcile: add flow failed for bay $ct_name (will retry next boot)"
      done 3< "$CRYPTTAB"
    else
      log "reconcile: no readable $CRYPTTAB — no encrypted bays to late-unlock"
    fi
    # WARP-1361 — but FIRST: mount assembled-but-unmounted droplet pool
    # arrays. The per-device udev add can fire while the array is still
    # assembling (blkid sees no filesystem yet) and nothing re-fires on the
    # later activation change event — the live box rebooted into a healthy
    # md127 mounted NOWHERE and the dashboard lost the pool entirely
    # (drives_snapshot lists mounted filesystems only). This loop is the
    # idempotent safety net: every md array node carrying a supported
    # filesystem AND the droplet trust pedigree (trusted.list uuid, or the
    # on-box mdadm homehost signature) is pushed through the SAME add flow
    # the udev path runs — which also handles auto-read-only arrays, trust
    # seeding and registration. A FOREIGN array is logged and left alone:
    # reconcile never mounts an array this box didn't make (the udev add
    # path is where foreign media gets its untrusted read-only treatment).
    for md_dev in "$DEV_DIR"/md*; do
      [ -e "$md_dev" ] || continue                 # glob miss
      md_base="$(basename "$md_dev")"
      # WARP-1361 review (AC4): every skip says why — these two continues
      # were the only silent ones. log() is printf/logger --, so echoing a
      # crafted name back is safe.
      case "$md_base" in
        *[!a-z0-9]*)                               # never a crafted name
          log "reconcile: skip $md_base (unexpected characters in md node name)"
          continue ;;
      esac
      if ! [[ "$md_base" =~ ^md[0-9]+$ ]]; then    # array nodes only, not mdNpM
        log "reconcile: skip $md_base (md partition node — the parent array owns the mount)"
        continue
      fi
      if findmnt -n -o TARGET --source "$md_dev" >/dev/null 2>&1; then
        log "reconcile: $md_base already mounted — nothing to do"
        continue
      fi
      md_type="$(blkid -o value -s TYPE "$md_dev" 2>/dev/null | head -1 || true)"
      md_type="${md_type//$'\n'/}"
      if [ -z "$md_type" ]; then
        log "reconcile: skip $md_base (no readable filesystem — still assembling, or never formatted)"
        continue
      fi
      case "$md_type" in
        ext4|xfs|btrfs) ;;
        crypto_LUKS)
          # WARP-3513: an encrypted pool (LUKS over the array). The bay
          # late-unlock loop above owns it — it unlocks and mounts the mapper.
          log "reconcile: skip $md_base (LUKS container — an encrypted pool is mounted by the bay late-unlock loop above, not here)"
          continue ;;
        *)
          log "reconcile: skip $md_base (unsupported filesystem type $md_type)"
          continue ;;
      esac
      md_uuid="$(blkid -o value -s UUID "$md_dev" 2>/dev/null | head -1 || true)"
      md_uuid="${md_uuid//$'\n'/}"
      if { [ -n "$md_uuid" ] \
           && grep -qxF "$md_uuid" "${STATE_DIR}/trusted.list" 2>/dev/null; } \
         || is_droplet_md "$md_dev"; then
        log "reconcile: mounting assembled-but-unmounted droplet pool array $md_base"
        "$BASH" "$0" add "$md_dev" \
          || log "reconcile: add flow failed for $md_base (will retry next boot)"
      else
        log "reconcile: skip foreign md array $md_base (no droplet signature, uuid not on trusted.list) — not auto-mounting"
      fi
    done
    for m in "$MOUNT_BASE"/*; do
      [ -d "$m" ] || continue
      mountpoint -q "$m" || continue
      src="$(findmnt -n -o SOURCE "$m" 2>/dev/null | head -1 || true)"
      case "$src" in
        /dev/md*)
          # WARP-1361: signature-gated — a mounted-read-only FOREIGN array
          # must never graduate onto trusted.list (that would flip it rw on
          # the next boot, defeating the untrusted posture the add path
          # just enforced).
          if ! is_droplet_md "$src"; then
            log "reconcile: not seeding trusted.list for foreign md array $src"
            continue
          fi
          md_uuid="$(blkid -o value -s UUID "$src" 2>/dev/null | head -1 || true)"
          md_uuid="${md_uuid//$'\n'/}"
          if [ -n "$md_uuid" ] \
             && ! grep -qxF "$md_uuid" "${STATE_DIR}/trusted.list" 2>/dev/null; then
            printf '%s\n' "$md_uuid" >> "${STATE_DIR}/trusted.list" 2>/dev/null \
              && log "reconcile: seeded trusted.list with md-pool uuid $md_uuid" \
              || true
          fi
          ;;
      esac
    done
    if [ "$NEXTCLOUD_AUTO_REGISTER" != "1" ]; then
      log "reconcile: nextcloud auto-register disabled (set NEXTCLOUD_AUTO_REGISTER=1 in /etc/droplet/automount.env)"
      exit 0
    fi
    # Wait out the Nextcloud container on boot: docker.service being up does
    # not mean the container answers occ yet. Bounded, never a failed unit —
    # the next boot (or the next udev add) retries.
    nc_tries="${DROPLET_NC_WAIT_TRIES:-30}"
    nc_interval="${DROPLET_NC_WAIT_INTERVAL:-10}"
    nc_i=0
    until nc_occ status >/dev/null 2>&1; do
      nc_i=$((nc_i + 1))
      if [ "$nc_i" -ge "$nc_tries" ]; then
        log "reconcile: nextcloud ($NEXTCLOUD_CONTAINER) not answering after ${nc_tries} attempts — giving up until the next boot"
        exit 0
      fi
      sleep "$nc_interval"
    done
    for m in "$MOUNT_BASE"/*; do
      [ -d "$m" ] || continue
      mountpoint -q "$m" || continue
      src="$(findmnt -n -o SOURCE "$m" 2>/dev/null | head -1 || true)"
      [ -n "$src" ] || continue
      name="$(basename "$m")"
      eligible=0
      reg_scope="root"
      case "$src" in
        /dev/md*)
          # WARP-1361: signature-gated (same reasoning as the trust-list
          # seeding above) — a foreign array's mount is never exposed to
          # Nextcloud. Droplet pools (uuid on trusted.list, or the on-box
          # homehost signature) register as before.
          md_uuid="$(blkid -o value -s UUID "$src" 2>/dev/null | head -1 || true)"
          md_uuid="${md_uuid//$'\n'/}"
          if { [ -n "$md_uuid" ] \
               && grep -qxF "$md_uuid" "${STATE_DIR}/trusted.list" 2>/dev/null; } \
             || is_droplet_md "$src"; then
            eligible=1
          fi
          ;;
        /dev/mapper/droplet-usb-*) eligible=1 ;;   # droplet-enrolled LUKS
        /dev/mapper/droplet-bay-*)
          # WARP-3513: an encrypted bay — droplet-prepared and TPM-unlocked,
          # trusted like the enrolled LUKS above, but exposed at files/ ONLY.
          eligible=1
          reg_scope="files"
          ;;
        *)
          uuid="$(blkid -o value -s UUID "$src" 2>/dev/null | head -1 || true)"
          uuid="${uuid//$'\n'/}"
          if [ -n "$uuid" ] \
             && grep -qxF "$uuid" "${STATE_DIR}/trusted.list" 2>/dev/null; then
            eligible=1
          fi
          ;;
      esac
      if [ "$eligible" = 1 ]; then
        nextcloud_add "$m" "$name" "$reg_scope" \
          || log "reconcile: nextcloud registration failed for $name"
      else
        log "reconcile: skip untrusted mount $name"
      fi
    done
    # WARP-1338 review — prune dangling /host/<tail> registrations. The udev
    # remove path deregisters only on a LIVE remove event, so a drive
    # unplugged while the box was off — or a legacy pool renamed to the
    # automount <label>-<short-uuid> derivation on its first post-upgrade
    # boot — leaves an unscoped external mount whose datadir no longer
    # exists: a dead GUID-named folder in every user's Files root. An
    # unmounted tail is exactly the state the remove handler would have
    # deregistered, so pruning it here preserves the deregister-on-remove
    # invariant. Only OUR /host/-datadir entries are considered; any other
    # files_external storage is left alone. Runs after the register loop so
    # a renamed pool converges in one pass (new tail registered above, old
    # tail pruned here). occ's json escapes slashes — normalize before the
    # match, same as nextcloud_add's idempotency check.
    { nc_occ files_external:list --output=json 2>/dev/null | tr -d '\\' \
        | grep -oE '"datadir":"/host/[^"]+"' || true; } \
      | while IFS= read -r dd; do
          tail="${dd#*\"datadir\":\"/host/}"
          tail="${tail%\"}"
          [ -n "$tail" ] || continue
          # WARP-3513: a bay's registration is /host/<name>/files — strip the
          # suffix so it is judged by the SAME <name> mount as a root-scoped
          # one (otherwise the nested-path guard below skips it and the
          # registration of an unplugged bay is never pruned).
          tail="${tail%/files}"
          [ -n "$tail" ] || continue
          case "$tail" in */*) continue ;; esac   # defensive: never nested
          if mountpoint -q "$MOUNT_BASE/$tail"; then
            continue
          fi
          log "reconcile: pruning dangling registration $tail (no longer mounted)"
          nextcloud_remove "$tail" || true
        done
    ;;

  *)
    log "unknown action $ACTION"
    exit 1 ;;
esac
