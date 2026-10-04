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
# Operations (all DATA-DESTROYING, except the three recovery_key_* ops):
#   pool_create     {device, level, members[], confirm_phrase}
#   pool_destroy    {device, confirm_phrase}
#   pool_format     {device, fstype?, confirm_phrase}   (formats AND mounts)
#   pool_set_level  {device, level, confirm_phrase}
#   pool_add_spare  {device, member, confirm_phrase}
#   pool_remove_disk{device, member, confirm_phrase}
#   drive_adopt     {device, fstype?, wipe_method?, label?, confirm_phrase}
#   drive_reclaim   {device, md, fstype?, wipe_method?, label?, confirm_phrase}
#   recovery_key_reveal     {uuid}  (WARP-3513: one-time hand-over of the escrowed key)
#   recovery_key_regenerate {uuid}  (WARP-3513: new recovery keyslot, old one wiped)
#   recovery_key_expire              (WARP-3513: the 7-day sweep, run by its own timer)
#
# WARP-3513 — EVERY filesystem this script creates (drive_adopt, drive_reclaim,
# pool_format) is ALWAYS encrypted at rest: LUKS2 (+ TPM2 token + recovery key,
# the same scheme and PCR policy as /data) with ext4 `-O quota,project` inside,
# mounted `prjquota`, a `files/` directory that is the ONLY path registered in
# Nextcloud, and a crypttab line so the bay unlocks at boot without ever
# blocking it. See the "encrypted bay drives" block below.
#
# Machine-readable refusals (the bridge turns the exit code into HTTP 409 + a
# code; every other failure is a plain 1 + a human message on stderr):
#   75  tpm_required             no usable TPM2 — Prepare needs one; nothing was erased
#   76  encrypted_data_required  /data is not an encrypted volume, so a recovery key
#                                could not be held safely; nothing was changed
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
#   DROPLET_POOL_TEST_MDSLAVE=1   drive_reclaim membership pre-flight: 1 = the
#                                 disk IS a slave of the named md; 0 = it is NOT
#   DROPLET_AUTOMOUNT_STATE=path  override the automount state file the managed
#                                 teardown prunes (WARP-848 unit tests)
#   WARP-3513 seams (the root-only paths this script writes; redirected into a
#   tmp dir by the hermetic tests so a test run can never touch the real ones):
#   DROPLET_CRYPTTAB=path         /etc/crypttab
#   DROPLET_BAY_RECOVERY_DIR=dir  the recovery-key escrow directory
#   DROPLET_LUKS_RUNTIME_DIR=dir  tmpfs dir for the temporary install key
#                                 (same name droplet-luks-provision.sh uses)
#   DROPLET_POOL_TEST_DATA_ENCRYPTED=1|0  force the "is /data encrypted?" probe
#   DROPLET_FILES_PROJID=n        project id of files/ (default 4097)
#   DROPLET_TPM_DEVICE / DROPLET_TPM_PCRS_BIND / DROPLET_CRYPTSETUP_BIN /
#   DROPLET_CRYPTENROLL_BIN — droplet-tpm-lib.sh's own seams, shared with the
#                                 /data provisioning.
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
  # WARP-1048: reclaim a pool-member disk — break it out of its md array
  # (mdadm --fail/--remove + --zero-superblock) THEN run it through the same
  # adopt (wipe + reformat + mount) path so it's usable on its own again. A
  # plain drive_adopt on an md-held member fails EBUSY; the detach must run
  # first. Data-destroying.
  drive_reclaim) ;;
  # WARP-3513: the recovery-key custody ops. reveal hands the owner their
  # escrowed LUKS recovery key exactly once (a read-and-consume of a root-only
  # file); regenerate enrols a new recovery keyslot and wipes the old one;
  # expire is the 7-day sweep. None of them erases a drive, so none carries a
  # device or a typed confirm phrase — the owner-only + confirmation gates
  # (Tier 2 reveal, Tier 3 regenerate) live in the orchestrator, which is the
  # only caller of the first two; expire is run by its own systemd timer.
  recovery_key_reveal|recovery_key_regenerate|recovery_key_expire) ;;
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

# =============================================================================
# WARP-3513 — encrypted-at-rest bay drives: constants + recovery-key escrow
# =============================================================================
# Every filesystem this script creates (drive_adopt, drive_reclaim, pool_format)
# is ALWAYS inside a LUKS2 container, using the SAME scheme as /data
# (scripts/host/droplet-luks-provision.sh — the tool seams and the PCR set come
# from droplet-tpm-lib.sh, so the two can never drift apart):
#   luksFormat LUKS2/Argon2id with a temporary tmpfs key
#   -> recovery keyslot FIRST (WARP-2101: it is enrolled before TPM2), then the
#      TPM2 keyslot, then the temporary slot is removed. If any later step
#      fails, the EXIT cleanup crypto-erases the new LUKS header.
#   -> ext4 `-O quota,project` INSIDE the container (the recordings slice,
#      WARP-3514, is an ext4 PROJECT QUOTA — never a repartition)
#   -> crypttab line (`nofail` + `headless`: a locked or missing bay never
#      blocks boot and never queues an ask-password prompt on a console-less
#      box), mounted `prjquota`, `<mount>/files` created with project id 4097
#      (the ONLY path ever registered in Nextcloud — `<mount>/nvr` is never
#      exposed).
#
# PREPARE REQUIRES A TPM2, as /data's provisioning does, and an ENCRYPTED /data
# (below). Both are checked BEFORE the first destructive step and refused with a
# dedicated exit code the bridge turns into HTTP 409 + a machine code
# (tpm_required / encrypted_data_required): nothing is wiped.
#
# RECOVERY-KEY CUSTODY (storage decision record ADR-070, section 8.2). /data's
# key is printed once on the provisioning console and never written to disk. A
# bay is prepared from the dashboard, where nobody is at a console, so between
# Prepare and the owner's single reveal this root script holds the key in a
# ROOT-ONLY file (0600, directory 0700) on /data — the TPM-sealed LUKS volume,
# NEVER the unencrypted root filesystem (Prepare refuses when /data is not
# encrypted). The reveal is served through the root spool, atomically consumes
# and shreds the file, and answers "already retrieved" ever after; an unrevealed
# key is shredded after 7 days (recovery_key_expire, run daily by
# droplet-bay-recovery-expiry.timer and enforced again at reveal time).
# recovery_key_regenerate enrols a NEW recovery keyslot, wipes the old one, and
# holds the new key the same way. The key is NEVER placed on a command line, in
# a log, in the result of any other operation, in the DB or in .env.
BAY_MAPPER_PREFIX="droplet-bay-"
BAY_CRYPTTAB="${DROPLET_CRYPTTAB:-/etc/crypttab}"
# Same line shape as /data's (droplet-luks-provision.sh _mount_and_wire).
BAY_CRYPTTAB_OPTS="tpm2-device=auto,luks,discard,nofail,headless=true,x-systemd.device-timeout=30s"
BAY_MOUNT_OPTS="rw,nosuid,nodev,noatime,prjquota"
BAY_RUNTIME_DIR="${DROPLET_LUKS_RUNTIME_DIR:-/run/droplet}"
# The ONLY place a recovery key may wait. The hermetic tests redirect it.
BAY_ESCROW_DIR="${DROPLET_BAY_RECOVERY_DIR:-/data/droplet/secrets/bay-recovery}"
# An unrevealed key is shredded after 7 days.
BAY_ESCROW_TTL_MIN=10080
# files/ carries this project id so WARP-3514 can cap it (a slice is a cap, not
# a reservation: files/ gets its own quota so it cannot eat the recordings'
# share). nvr/ uses 4096.
BAY_FILES_PROJID="${DROPLET_FILES_PROJID:-4097}"
# Same tool names droplet-tpm-lib.sh resolves (kept here so the forget/teardown
# paths work without loading the lib).
BAY_CRYPTSETUP="${DROPLET_CRYPTSETUP_BIN:-cryptsetup}"
BAY_CRYPTENROLL="${DROPLET_CRYPTENROLL_BIN:-systemd-cryptenroll}"
# www-data in the Nextcloud image — the literal `docker exec -u 33` already uses.
NEXTCLOUD_UID=33
# Exit codes of the two machine-readable refusals. The bridge maps them to HTTP
# 409 + {"code": ...}; every other failure stays a plain 422 with the message.
EXIT_TPM_REQUIRED=75
EXIT_ENCRYPTED_DATA_REQUIRED=76
# fd emit_ok writes the final JSON line to (1 until the execute step re-points
# stdout at stderr and keeps fd 3 as the JSON channel).
EMIT_FD=1
# Filled in by bay_format_encrypted; read by emit_ok and the EXIT cleanup.
BAY_KEYFILE=""
BAY_OPEN_MAPPER=""
BAY_ESCROW_FILE=""
BAY_CRYPTTAB_LUKS=""
BAY_MOUNTED=""
BAY_FS_UUID=""
BAY_FORMAT_DEVICE=""
BAY_FORMAT_STARTED=0
BAY_DONE=0

# die_code <exit-code> <message>: a refusal with a machine-readable exit code.
die_code() {
  local rc="$1"
  shift
  err "$*"
  exit "$rc"
}

# bay_shred <file>: overwrite-then-unlink a secret-bearing file, best effort.
bay_shred() {
  if [ -e "$1" ]; then
    shred -u "$1" 2>/dev/null || rm -f "$1"
  fi
  return 0
}

# bay_private_dir <dir>: a root-only (0700) directory for key material. Created
# first, then chmod'ed, so an already-existing one ends up 0700 as well. The
# directory is empty in the instant between the two calls; every file written
# into it is created under umask 077 regardless.
bay_private_dir() {
  mkdir -p "$1"
  chmod 0700 "$1"
}

# bay_load_tpm_lib: the shared TPM seams + PCR set. Sourced lazily so the ops
# that never touch a TPM (pool_set_level, pool_add_spare, …) do not depend on
# it. Installed next to this script by install-device-bridge.sh (and by
# scripts/lib/luks.sh).
bay_load_tpm_lib() {
  local lib
  lib="${DROPLET_TPM_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/droplet-tpm-lib.sh}"
  [ -r "$lib" ] \
    || die "refusing: $lib is missing, so an encrypted drive cannot be handled (setup.sh installs it) — nothing was changed"
  # shellcheck source=droplet-tpm-lib.sh
  source "$lib"
}

# bay_require_tpm: a TPM2 the tss2 userspace can actually drive (the WARP-2101
# class: /dev/tpm0 exists but systemd-cryptenroll fails "TPM2 support is not
# installed"). There is NO override: an encrypted drive that is not TPM-sealed
# would not auto-unlock, and the owner decided Prepare needs one.
bay_require_tpm() {
  droplet_tpm_present \
    || die_code "$EXIT_TPM_REQUIRED" "refusing: this box has no TPM2 device (${DROPLET_TPM_DEVICE:-/dev/tpm0}), so an encrypted drive cannot be prepared — nothing was erased"
  droplet_tpm_userspace_ok \
    || die_code "$EXIT_TPM_REQUIRED" "refusing: the TPM2 userspace is not usable (systemd-cryptenroll --tpm2-device=list failed) — install libtss2-esys-3.0.2-0t64 libtss2-mu-4.0.1-0t64 libtss2-rc0t64 and retry; nothing was erased"
}

# bay_data_is_encrypted: is the filesystem the escrow lives on a dm-crypt volume?
# Probes the tree the escrow directory sits under (/data/droplet/secrets): it
# must exist, and the device holding it (or one beneath it — LUKS under LVM)
# must be TYPE=crypt. The unencrypted root filesystem fails this by design.
# DROPLET_POOL_TEST_DATA_ENCRYPTED=1|0 forces the answer (hermetic tests).
bay_data_is_encrypted() {
  local probe src types
  if [ -n "${DROPLET_POOL_TEST_DATA_ENCRYPTED:-}" ]; then
    [ "$DROPLET_POOL_TEST_DATA_ENCRYPTED" = "1" ]
    return
  fi
  probe="$(dirname "$BAY_ESCROW_DIR")"
  [ -d "$probe" ] || return 1
  src="$(findmnt -rn -o SOURCE --target "$probe" 2>/dev/null | head -n 1 || true)"
  src="${src%%[*}"
  [ -n "$src" ] || return 1
  types="$(lsblk -rsno TYPE "$src" 2>/dev/null || true)"
  case $'\n'"$types"$'\n' in
    *$'\n'crypt$'\n'*) return 0 ;;
  esac
  return 1
}

# bay_require_encrypted_data: refuse unless a recovery key can be held on an
# ENCRYPTED volume (ADR-070 section 8.2: never the unencrypted root filesystem).
bay_require_encrypted_data() {
  bay_data_is_encrypted \
    || die_code "$EXIT_ENCRYPTED_DATA_REQUIRED" "refusing: /data is not on an encrypted volume (looked at $(dirname "$BAY_ESCROW_DIR")), so a recovery key could not be held safely — encrypt /data first (docs/security/at-rest-encryption.md); nothing was changed"
}

# bay_escrow_expired <file>: true when the escrow file is past its 7-day TTL.
bay_escrow_expired() {
  [ -n "$(find "$1" -maxdepth 0 -mmin "+$BAY_ESCROW_TTL_MIN" 2>/dev/null)" ]
}

# bay_escrow_expire_file <key-file>: shred an unrevealed key and leave a
# no-secret `.expired` tombstone, so a later reveal can say what happened.
bay_escrow_expire_file() {
  local tomb="${1%.key}.expired"
  ( umask 077; date -u +%Y-%m-%dT%H:%M:%SZ > "$tomb" ) 2>/dev/null || true
  bay_shred "$1"
}

# bay_escrow_put <luks-uuid> <fs-uuid> <key>: root-only (dir 0700, file 0600)
# escrow for the one-time reveal, written via a temp name + atomic rename. Any
# previous file or tombstone for that filesystem is dropped first. The key
# reaches printf as a builtin argument — never an exec'd argv. Sets
# BAY_ESCROW_FILE (so a failed prepare can shred it again).
bay_escrow_put() {
  local luks="$1" fs="$2" key="$3" old final tmp
  bay_private_dir "$BAY_ESCROW_DIR"
  final="$BAY_ESCROW_DIR/${luks}__${fs}.key"
  tmp="$final.tmp.$$"
  # Stage and validate the replacement before touching the current key or its
  # lookup tombstone. Regeneration has already enrolled a new LUKS slot here;
  # if the write/rename fails, retaining the old record lets the owner retry.
  if ! ( umask 077; printf '%s\n' "$key" > "$tmp" ); then
    bay_shred "$tmp"
    die "could not stage the recovery key — nothing was changed"
  fi
  if ! chmod 0600 "$tmp"; then
    bay_shred "$tmp"
    die "could not secure the staged recovery key — nothing was changed"
  fi
  if ! mv -T "$tmp" "$final"; then
    bay_shred "$tmp"
    die "could not install the recovery key — existing recovery state was preserved; retry"
  fi
  BAY_ESCROW_FILE="$final"
  # The new key is now durably discoverable by filesystem UUID. Retire any old
  # key or tombstone only after that atomic commit; do not remove the new file.
  for old in "$BAY_ESCROW_DIR"/*__"$fs".key "$BAY_ESCROW_DIR"/*__"$fs".retrieved "$BAY_ESCROW_DIR"/*__"$fs".expired; do
    if [ -f "$old" ] && [ "$old" != "$final" ]; then
      bay_shred "$old"
    fi
  done
}

# bay_recovery_key_reveal <fs-uuid>: the one-time hand-over. Consumption is an
# atomically claimed retrieved tombstone so even two racing requests yield the
# key to exactly one caller. Every NORMAL outcome exits 0 with an explicit
# `status` enum — revealed | already_retrieved | expired | not_found (the
# orchestrator maps it to 200 / 410 / 410 / 404); only a malformed request or a
# corrupt escrow file is an error. The key goes to STDOUT only.
bay_recovery_key_reveal() {
  local uuid="$1" f key tomb tomb_tmp
  [[ "$uuid" =~ ^[A-Fa-f0-9-]{8,64}$ ]] \
  || die "invalid uuid for recovery_key_reveal (expected the filesystem UUID)"
  for f in "$BAY_ESCROW_DIR"/*__"$uuid".key; do
    [ -f "$f" ] || continue
    tomb="$(printf '%s' "$f" | sed 's/\.key$/.retrieved/')"
    if [ -f "$tomb" ]; then
      bay_shred "$f"
      printf '{"ok": true, "operation": "recovery_key_reveal", "status": "already_retrieved", "uuid": "%s"}\n' "$uuid"
      return 0
    fi
    if bay_escrow_expired "$f"; then
      # Past its TTL: shredded here and now, never handed out.
      bay_escrow_expire_file "$f"
      printf '{"ok": true, "operation": "recovery_key_reveal", "status": "expired", "uuid": "%s"}\n' "$uuid"
      return 0
    fi
    key=""
    IFS= read -r key < "$f" || true
    if ! [[ "$key" =~ ^[a-z0-9-]{16,}$ ]]; then
      # Never echo the value; leave an expired marker so Regenerate can still
      # find the LUKS UUID after discarding corrupt escrow.
      bay_escrow_expire_file "$f"
      die "the escrowed recovery key for $uuid is malformed and has been discarded — regenerate the recovery key to issue a new one"
    fi
    tomb_tmp="$tomb.tmp.$$"
    if ! ( umask 077; date -u +%Y-%m-%dT%H:%M:%SZ > "$tomb_tmp" ) 2>/dev/null; then
      rm -f "$tomb_tmp"
      die "could not record the one-time retrieval; the key remains escrowed — retry"
    fi
    if ! ln -T "$tomb_tmp" "$tomb" 2>/dev/null; then
      rm -f "$tomb_tmp"
      if [ -f "$tomb" ]; then
        bay_shred "$f"
        printf '{"ok": true, "operation": "recovery_key_reveal", "status": "already_retrieved", "uuid": "%s"}\n' "$uuid"
        return 0
      fi
      die "could not record the one-time retrieval; the key remains escrowed — retry"
    fi
    rm -f "$tomb_tmp"
    bay_shred "$f"
    [ ! -e "$f" ] || die "could not remove the consumed recovery key — regenerate the recovery key to issue a new one"
    printf '{"ok": true, "operation": "recovery_key_reveal", "status": "revealed", "uuid": "%s", "recovery_key": "%s"}\n' \
      "$uuid" "$key"
    return 0
  done
  for f in "$BAY_ESCROW_DIR"/*__"$uuid".retrieved; do
    if [ -f "$f" ]; then
      printf '{"ok": true, "operation": "recovery_key_reveal", "status": "already_retrieved", "uuid": "%s"}\n' "$uuid"
      return 0
    fi
  done
  for f in "$BAY_ESCROW_DIR"/*__"$uuid".expired; do
    if [ -f "$f" ]; then
      printf '{"ok": true, "operation": "recovery_key_reveal", "status": "expired", "uuid": "%s"}\n' "$uuid"
      return 0
    fi
  done
  printf '{"ok": true, "operation": "recovery_key_reveal", "status": "not_found", "uuid": "%s"}\n' "$uuid"
  return 0
}

# bay_recovery_key_expire: the 7-day sweep — shred every unrevealed key past its
# TTL (leaving `.expired` tombstones). Run daily by
# droplet-bay-recovery-expiry.timer; reveal enforces the same TTL on its own.
bay_recovery_key_expire() {
  local f key n=0
  # A crash after creating the one-time marker but before removing the key can
  # leave an orphan escrow file. The marker wins; clear any such copy.
  for f in "$BAY_ESCROW_DIR"/*__*.retrieved; do
    [ -f "$f" ] || continue
    key="${f%.retrieved}.key"
    [ -f "$key" ] && bay_shred "$key"
  done
  for f in "$BAY_ESCROW_DIR"/*.key; do
    [ -f "$f" ] || continue
    if bay_escrow_expired "$f"; then
      bay_escrow_expire_file "$f"
      n=$((n + 1))
    fi
  done
  printf '{"ok": true, "operation": "recovery_key_expire", "expired": %d}\n' "$n"
  return 0
}

# bay_recovery_slots <device>: the keyslot numbers of the container's
# systemd-recovery tokens, one per line (empty only when valid metadata has none;
# unreadable or malformed metadata is a hard failure).
bay_recovery_slots() {
  local metadata
  metadata="$("$BAY_CRYPTSETUP" luksDump --dump-json-metadata "$1" 2>/dev/null)" || return 1
  printf '%s' "$metadata" | python3 -c '
import json, sys
try:
    meta = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(meta, dict) or not isinstance(meta.get("tokens"), dict):
    sys.exit(1)
for tok in meta["tokens"].values():
    if isinstance(tok, dict) and tok.get("type") == "systemd-recovery":
        slots = tok.get("keyslots")
        if not isinstance(slots, list) or not slots:
            sys.exit(1)
        for ks in slots:
            if not str(ks).isdigit():
                sys.exit(1)
            print(ks)
'
}

# bay_recovery_key_regenerate <fs-uuid>: "Regenerate recovery key" — for an owner
# who missed (or let expire) the one-time reveal. Enrols a NEW recovery keyslot
# FIRST (unlocking through the TPM token, so no key is typed), escrows the new
# key, and only then wipes the OLD recovery keyslot(s) by number: a failure
# half-way never leaves the drive without a recovery key. `--wipe-slot=recovery`
# is deliberately NOT used — it would wipe the new slot too. Normal outcomes exit
# 0 with a `status`: regenerated | not_found (no record of this drive) |
# drive_absent (known, but not plugged in / visible). The key is NOT in the reply:
# the owner retrieves it through the same one-time reveal.
bay_recovery_key_regenerate() {
  local uuid="$1" f base luks="" dev raw recovery slot old_slots
  [[ "$uuid" =~ ^[A-Fa-f0-9-]{8,64}$ ]] \
    || die "invalid uuid for recovery_key_regenerate (expected the filesystem UUID)"
  for f in "$BAY_ESCROW_DIR"/*__"$uuid".key "$BAY_ESCROW_DIR"/*__"$uuid".retrieved "$BAY_ESCROW_DIR"/*__"$uuid".expired; do
    if [ -f "$f" ]; then
      base="${f##*/}"
      luks="${base%%__*}"
      break
    fi
  done
  if ! [[ "$luks" =~ ^[A-Fa-f0-9-]{8,64}$ ]]; then
    printf '{"ok": true, "operation": "recovery_key_regenerate", "status": "not_found", "uuid": "%s"}\n' "$uuid"
    return 0
  fi
  bay_load_tpm_lib
  bay_require_tpm
  bay_require_encrypted_data
  dev="$(blkid -U "$luks" 2>/dev/null | head -n 1 || true)"
  if [ -z "$dev" ]; then
    printf '{"ok": true, "operation": "recovery_key_regenerate", "status": "drive_absent", "uuid": "%s"}\n' "$uuid"
    return 0
  fi
  old_slots="$(bay_recovery_slots "$dev")" \
    || die "could not inspect the existing recovery keyslots — nothing was changed"
  raw="$("$BAY_CRYPTENROLL" --unlock-tpm2-device=auto --recovery-key "$dev")"
  recovery="$(printf '%s\n' "$raw" | awk 'NF { l = $0 } END { print l }' | tr -d '[:space:]')"
  raw=""
  [[ "$recovery" =~ ^[a-z0-9-]{16,}$ ]] \
    || die "recovery-key enrolment returned an unexpected value (not shown) — nothing was changed"
  bay_escrow_put "$luks" "$uuid" "$recovery"
  recovery=""
  for slot in $old_slots; do
    "$BAY_CRYPTENROLL" --unlock-tpm2-device=auto --wipe-slot="$slot" "$dev" \
      || die "the new recovery key is escrowed, but the old recovery keyslot $slot could not be wiped — run Regenerate again to retry"
  done
  printf '{"ok": true, "operation": "recovery_key_regenerate", "status": "regenerated", "uuid": "%s", "recovery_key_pending": true}\n' "$uuid"
  return 0
}

# These ops are dispatched BEFORE the generic device / confirm-phrase gates: they
# have neither (see the allow-list note above) — the owner-only + confirmation
# gates (Tier 2 reveal, Tier 3 regenerate) live in the orchestrator, which is the
# only caller; recovery_key_expire is run by its own systemd timer.
case "$OP" in
  recovery_key_reveal)     bay_recovery_key_reveal "$(json_field uuid)"; exit 0 ;;
  recovery_key_regenerate) bay_recovery_key_regenerate "$(json_field uuid)"; exit 0 ;;
  recovery_key_expire)     bay_recovery_key_expire; exit 0 ;;
esac

DEVICE="$(json_field device)"
LEVEL="$(json_field level)"
FSTYPE="$(json_field fstype)"
MEMBER="$(json_field member)"
CONFIRM="$(json_field confirm_phrase)"
WIPE_METHOD="$(json_field wipe_method)"   # WARP-662 drive_adopt: quick|secure
LABEL="$(json_field label)"               # WARP-662 drive_adopt: optional fs label
RECLAIM_MD="$(json_field md)"             # WARP-1048 drive_reclaim: owning md array
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

# WARP-3513: every bay is encrypted ext4 with project quotas (the recordings
# slice, WARP-3514, is an ext4 project quota). xfs/btrfs have no equivalent
# here, so refuse them up front — before anything is unmounted or erased.
case "$OP" in
  drive_adopt|drive_reclaim|pool_format)
    case "${FSTYPE:-ext4}" in
      ext4) ;;
      *) die "unsupported filesystem '${FSTYPE}': encrypted drives are always ext4 (project quotas) — nothing was erased" ;;
    esac
    ;;
esac

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

# ancestor_disks <node>: the physical disk(s) at the BOTTOM of <node>'s full
# dependency chain — one short kernel name per line (every lsblk TYPE=disk leaf).
# `lsblk -s` walks the WHOLE inverse-dependency tree (partition -> dm/LVM/crypt
# -> md -> disk), so a root fs stacked on LVM/LUKS/md still resolves to its
# backing spindle(s); `-r` strips the tree-drawing glyphs so NAME is the bare
# kernel name. Empty output when lsblk can't resolve the node (caller falls back
# to the basename). Never returns non-zero (keeps `set -e` callers safe).
ancestor_disks() {
  { lsblk -s -rn -o NAME,TYPE "$1" 2>/dev/null || true; } | while read -r _name _type; do
    [ "$_type" = "disk" ] && printf '%s\n' "$_name"
  done
  return 0
}

is_os_disk() {
  local dev="$1"
  if [ -n "${DROPLET_POOL_TEST_OSDISK:-}" ]; then
    [ "$dev" = "$DROPLET_POOL_TEST_OSDISK" ] && return 0 || return 1
  fi
  # Real: refuse any candidate that shares a PHYSICAL disk with the / or /boot
  # mount. Resolve BOTH the candidate and each OS mount's backing source all the
  # way down to their TYPE=disk leaves (ancestor_disks walks dm/LVM/crypt/md — a
  # bare `lsblk -ndo PKNAME` stops one level up at the dm node and silently
  # missed an LVM/LUKS-stacked root), and refuse if any backing disk is shared.
  # findmnt reports a btrfs/bind SOURCE as /dev/sdX[/subvol]; strip the [...] so
  # lsblk can resolve it (WARP-857).
  local this_disks os_disks d o src
  this_disks="$(ancestor_disks "$dev")"
  [ -n "$this_disks" ] || this_disks="$(basename "$dev")"
  for mp in / /boot /boot/efi; do
    src="$(findmnt -rn -o SOURCE --target "$mp" 2>/dev/null || true)"
    [ -n "$src" ] || continue
    src="${src%%[*}"
    os_disks="$(ancestor_disks "$src")"
    [ -n "$os_disks" ] || os_disks="$(basename "$src")"
    for o in $os_disks; do
      for d in $this_disks; do
        [ "$o" = "$d" ] && return 0
      done
    done
  done
  return 1
}

# is_md_member <md> <disk>: true iff <disk> (short kernel name) is a current
# member of array <md>, per the kernel sysfs topology
# (/sys/block/<md>/slaves/<disk>). WARP-1048 defense-in-depth on the destructive
# reclaim path: assert membership BEFORE `mdadm --fail`, so a wrong/mismatched
# {disk,md} pair becomes a clean owner-facing refusal instead of a raw mdadm
# error. Membership comes from the kernel topology, never name-pattern guessing.
is_md_member() {
  local md="$1" diskbase="$2"
  if [ -n "${DROPLET_POOL_TEST_MDSLAVE:-}" ]; then
    [ "$DROPLET_POOL_TEST_MDSLAVE" = "1" ] && return 0 || return 1
  fi
  [ -e "/sys/block/$md/slaves/$diskbase" ] && return 0
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

# --- WARP-1338: automount-stable mount names + Nextcloud registration --------
# droplet-automount.sh is the authority for mount tails on REBOOT — it renames
# every filesystem to <label>-<short-uuid>. Creation-time mounts here MUST
# derive the SAME name, or the Nextcloud registration and the dashboard's
# driveContentsHref deep-links dangle after the first reboot. The container
# name comes from the same env file the automount units load
# (/etc/droplet/automount.env, via droplet-storage-pool-apply.service's
# EnvironmentFile=); the default matches the shipping compose project.
NEXTCLOUD_CONTAINER="${NEXTCLOUD_CONTAINER:-droplet-nextcloud-1}"
TRUSTED_LIST="$(dirname "$AUTOMOUNT_STATE")/trusted.list"

# automount_mount_name <label> <uuid> — EXACTLY droplet-automount.sh's
# derivation (sanitize the label, fall back to "drive", append the first 8
# UUID chars). Keep the two in lockstep: the hermetic tests cross-pin the
# "pool-<short-uuid>" literal on both sides
# (test_storage_pool_script.py <-> test_automount_script.py).
automount_mount_name() {
  local label="$1" uuid="$2" name short
  [ -n "$label" ] || label="drive"
  short="$(printf '%s' "${uuid:-}" | head -c 8)"
  name="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-\+//;s/-\+$//')"
  # A label of "." or ".." (or any run of only dots) survives the charset
  # filter unchanged — "/mnt/droplet/.." would resolve OUTSIDE the mount
  # base, and the Nextcloud auto-registration would expose that parent
  # directory as browsable storage.
  case "$name" in
    ''|*[!.]*) : ;;
    *) name="" ;;
  esac
  [ -z "$name" ] && name="drive"
  [ -n "$short" ] && name="${name}-${short}"
  printf '%s\n' "$name"
}

# trusted_list_add <uuid> — seed automount's trust list with the freshly-made
# filesystem's UUID so the REBOOT path re-mounts it read-WRITE at the same
# derived name (an unlisted plain filesystem remounts read-only-untrusted
# under WARP-232's supply-chain gate — correct for hot-plugged sticks, wrong
# for a filesystem the owner just created through the confirm-gated flow).
# Same grep-guarded append shape as install.sh's fleet-upgrade seeding.
# Best-effort: a failure here must never fail the pool op itself.
trusted_list_add() {
  local uuid="$1"
  [ -n "$uuid" ] || return 0
  mkdir -p "$(dirname "$TRUSTED_LIST")" 2>/dev/null || return 0
  if ! grep -qxF "$uuid" "$TRUSTED_LIST" 2>/dev/null; then
    printf '%s\n' "$uuid" >> "$TRUSTED_LIST" 2>/dev/null \
      || err "could not seed trusted.list with $uuid (reboot may re-mount read-only)"
  fi
  return 0
}

# nextcloud_register <mount-tail> — register the freshly-mounted filesystem as
# Nextcloud external storage, using the SAME occ invocation shape as
# droplet-automount.sh's nextcloud_add (docker exec -u 33 … php occ …), with
# no applicable scoping (household-wide: browsing acts as each user's OWN
# Nextcloud account). WARP-3513: the registered datadir is `<mount>/files` —
# NEVER the drive root, which also holds lost+found and the recordings folder
# `nvr/` (WARP-3514) that must never be browsable. Best-effort BY DESIGN: a
# warming/absent container must never fail a pool op that already formatted +
# mounted — the boot reconcile (droplet-automount.sh reconcile) converges
# registration later. Idempotent: an existing datadir entry short-circuits (occ
# json escapes slashes, so normalize before the fixed-string match).
nextcloud_register() {
  local name="$1" datadir="/host/$1/files"
  if ! docker exec -u 33 "$NEXTCLOUD_CONTAINER" php occ app:enable files_external \
      >/dev/null 2>&1; then
    err "nextcloud registration deferred for $name (is $NEXTCLOUD_CONTAINER running? the boot reconcile retries)"
    return 0
  fi
  if docker exec -u 33 "$NEXTCLOUD_CONTAINER" php occ files_external:list \
      --output=json 2>/dev/null | tr -d '\\' \
      | grep -qF "\"datadir\":\"$datadir\""; then
    return 0
  fi
  docker exec -u 33 "$NEXTCLOUD_CONTAINER" php occ files_external:create \
    "/$name" local null::null -c "datadir=$datadir" >/dev/null 2>&1 \
    || err "nextcloud files_external:create failed for $name (the boot reconcile retries)"
  return 0
}

# nextcloud_deregister <mount-tail> — WARP-3513: a drive about to be ERASED
# takes its Nextcloud registration with it. Prepare REPLACES a plain drive's
# drive-root registration with the new files/ one; without this the old entry
# would sit in every user's Files root, pointing at a wiped drive, until the next
# boot's reconcile prunes it. It matches on the registered datadir
# (/host/<tail> or /host/<tail>/files) — never a substring — so only OUR /host
# registrations of THAT mount are touched. Best-effort BY DESIGN, like
# nextcloud_register: a warming/absent container never fails the op.
nextcloud_deregister() {
  local name="$1" listing mid
  command -v docker >/dev/null 2>&1 || return 0
  listing="$(docker exec -u 33 "$NEXTCLOUD_CONTAINER" php occ files_external:list --output=json 2>/dev/null || true)"
  [ -n "$listing" ] || return 0
  mid="$(printf '%s' "$listing" | python3 -c '
import json, sys
name = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(data, dict):
    data = list(data.values())
for entry in data if isinstance(data, list) else []:
    if not isinstance(entry, dict):
        continue
    cfg = entry.get("configuration")
    datadir = (cfg.get("datadir") if isinstance(cfg, dict) else None) or entry.get("datadir")
    if datadir in ("/host/" + name, "/host/" + name + "/files") and entry.get("mount_id") is not None:
        print(entry["mount_id"])
        break
' "$name" || true)"
  [[ "$mid" =~ ^[0-9]+$ ]] || return 0
  docker exec -u 33 "$NEXTCLOUD_CONTAINER" php occ files_external:delete -y "$mid" >/dev/null 2>&1 \
    || err "nextcloud files_external:delete failed for $name (the boot reconcile prunes it)"
  return 0
}

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
      # WARP-857: findmnt reports a btrfs-subvolume / bind-mount SOURCE as
      # /dev/sdX1[/subvol]. Strip the [...] suffix so the node-equality and
      # PKNAME-child comparisons (and the automount-state prune keyed on the bare
      # device) match — otherwise the bracketed source matches neither the disk
      # node nor a child and the mount evades teardown, so the wipe hits EBUSY.
      # This covers BOTH the teardown enumeration and the post-teardown re-check,
      # which both flow through this function.
      src="${src%%[*}"
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
    # PYNET-009 parity (WARP-857): the automount handler serialises every
    # mounts.json read-modify-write under flock <STATE_DIR>/.lock
    # (state_add / state_remove). This managed-teardown prune mutates the SAME
    # file, so it takes the SAME lock — otherwise a concurrent automount@
    # instance and this prune interleave and silently drop each other's edits.
    # Guarded on flock's presence: the appliance (and CI) have util-linux flock
    # and share the lock; a flock-less dev/test host has no concurrent automount
    # to race, so it prunes unlocked (still best-effort, as noted above).
    (
      command -v flock >/dev/null 2>&1 && flock 9 || true
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
# WARP-3513: an encrypted bay's entry records the BACKING device in `device`
# and the dm-crypt mapper (the mount's actual source) in `mapper` — match both.
kept = [m for m in mounts
        if m.get("device") != device and m.get("mapper") != device]
if len(kept) != len(mounts):
    state["mounts"] = kept
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)
PY
    ) 9>"$(dirname "$AUTOMOUNT_STATE")/.lock"
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
  # WARP-3513: the drive is about to be erased — take its Nextcloud registration
  # with it (only a drive's OWN single-component mount point under /mnt/droplet).
  case "$tgt" in
    /mnt/droplet/*/*) ;;
    /mnt/droplet/?*) nextcloud_deregister "${tgt#/mnt/droplet/}" ;;
  esac
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

# --- WARP-3513: encrypted bay drives — preflight, forget, format -------------
# (constants + the recovery-key escrow/reveal live near the top of this file)

# host_run <cmd…>: run a command in the HOST mount namespace (WARP-868) so it
# acts on the host's view of the freshly-mounted filesystem. No-op prefix
# off-box (HOSTNS is empty there).
host_run() { "${HOSTNS[@]}" "$@"; }

# bay_cleanup (EXIT trap): never leave key material or a half-built bay behind.
# Runs on success too — the temporary install key is ALWAYS destroyed; the rest
# is undone only when the prepare did not complete (BAY_DONE != 1). The exit
# status of the script is preserved.
bay_cleanup() {
  if [ -n "$BAY_KEYFILE" ]; then
    bay_shred "$BAY_KEYFILE"
  fi
  if [ "$BAY_DONE" != 1 ]; then
    if [ -n "$BAY_MOUNTED" ]; then
      host_umount "$BAY_MOUNTED" 2>/dev/null || true
      rmdir "$BAY_MOUNTED" 2>/dev/null || true
    fi
    if [ -n "$BAY_CRYPTTAB_LUKS" ]; then
      bay_crypttab_remove "$BAY_CRYPTTAB_LUKS" || true
    fi
    if [ -n "$BAY_ESCROW_FILE" ]; then
      bay_shred "$BAY_ESCROW_FILE"
    fi
    if [ -n "$BAY_OPEN_MAPPER" ]; then
      "$BAY_CRYPTSETUP" close "$BAY_OPEN_MAPPER" >/dev/null 2>&1 || true
    fi
    # Prepare has already passed its confirmation gate and wiped this target.
    # If formatting/enrolment/filesystem setup then fails, crypto-erase the new
    # header so an inaccessible recovery slot or partial filesystem is not left
    # behind. `wipefs` alone is insufficient: it leaves the LUKS keyslots.
    if [ "$BAY_FORMAT_STARTED" = 1 ] && [ -n "$BAY_FORMAT_DEVICE" ]; then
      if "$BAY_CRYPTSETUP" luksErase --batch-mode "$BAY_FORMAT_DEVICE" >/dev/null 2>&1; then
        wipefs -a "$BAY_FORMAT_DEVICE" >/dev/null 2>&1 \
          || err "failed prepare cleanup could not remove the erased LUKS signature from $BAY_FORMAT_DEVICE"
      else
        err "failed prepare cleanup could not erase LUKS keyslots on $BAY_FORMAT_DEVICE"
      fi
    fi
  fi
  return 0
}

# bay_preflight: everything that can be checked BEFORE the first destructive
# step. A drive the owner just agreed to erase must never end up wiped with no
# way to finish the job: no usable TPM2 (exit 75 -> HTTP 409 tpm_required), no
# encrypted /data to hold the recovery key (exit 76 -> 409
# encrypted_data_required), or no openssl for the temporary key. There is no
# override for the TPM: Prepare needs one.
bay_preflight() {
  bay_load_tpm_lib
  trap bay_cleanup EXIT
  bay_require_tpm
  bay_require_encrypted_data
  command -v openssl >/dev/null 2>&1 \
    || die "refusing: openssl is required to prepare an encrypted drive — nothing was erased"
}

# bay_crypttab_remove <luks-uuid>: drop OUR crypttab line for that container.
# Rewritten through a temp file and cat'ed back so the file's inode, mode and
# owner survive; every other line (comments, /data's entry) is kept verbatim.
bay_crypttab_remove() {
  local luks="$1" tmp
  [ -f "$BAY_CRYPTTAB" ] || return 0
  tmp="$(mktemp)" || return 0
  if awk -v prefix="$BAY_MAPPER_PREFIX" -v src="UUID=$luks" \
       '!(index($1, prefix) == 1 && $2 == src)' "$BAY_CRYPTTAB" > "$tmp"; then
    cat "$tmp" > "$BAY_CRYPTTAB" || true
  fi
  rm -f "$tmp"
  return 0
}

# bay_crypttab_add <luks-uuid>: idempotently append the bay's crypttab line.
# Same options as /data (WARP-2100: `headless=true` so a failed TPM unseal at
# boot never queues an ask-password prompt nobody can answer; `nofail` so a
# locked bay is just absent and never blocks boot).
bay_crypttab_add() {
  local luks="$1" mapper
  mapper="${BAY_MAPPER_PREFIX}$(printf '%s' "$luks" | head -c 8)"
  if [ -f "$BAY_CRYPTTAB" ] && grep -qE "^${mapper}[[:space:]]" "$BAY_CRYPTTAB"; then
    return 0
  fi
  # A crypttab with no trailing newline would fuse our line onto its last one.
  if [ -s "$BAY_CRYPTTAB" ] && [ "$(tail -c 1 "$BAY_CRYPTTAB" | wc -l)" -eq 0 ]; then
    printf '\n' >> "$BAY_CRYPTTAB"
  fi
  printf '%s UUID=%s none %s\n' "$mapper" "$luks" "$BAY_CRYPTTAB_OPTS" \
    >> "$BAY_CRYPTTAB" \
    || die "could not write the crypttab entry for $mapper — the drive would not unlock at boot"
  BAY_CRYPTTAB_LUKS="$luks"
}

# bay_forget_uuid <luks-uuid>: drop the crypttab line and every escrow /
# tombstone file for a LUKS container that is about to be destroyed.
bay_forget_uuid() {
  local luks="$1" f
  [[ "$luks" =~ ^[A-Fa-f0-9-]{8,64}$ ]] || return 0
  bay_crypttab_remove "$luks"
  for f in "$BAY_ESCROW_DIR/$luks"__*.key "$BAY_ESCROW_DIR/$luks"__*.retrieved "$BAY_ESCROW_DIR/$luks"__*.expired; do
    if [ -f "$f" ]; then
      bay_shred "$f"
    fi
  done
  return 0
}

# bay_close_mappers_on <node>: close every open droplet-bay dm-crypt mapper
# stacked on <node> (the disk/array itself or anything on it). An open mapper
# holds the device exclusively, so without this the wipe/stop would die EBUSY.
# Mounts were already released by teardown_mounts_of; a mapper that will not
# close is a REAL busy device and refuses loudly (same wording the dashboard
# recognises). This is the only failure-prone half of "forgetting" a bay, so
# multi-disk ops run it for EVERY disk before erasing any.
bay_close_mappers_on() {
  local node="$1" name type
  while read -r name type; do
    [ "$type" = "crypt" ] || continue
    case "$name" in
      "$BAY_MAPPER_PREFIX"*)
        "$BAY_CRYPTSETUP" close "$name" >/dev/null 2>&1 \
          || die "refusing: $name is still in use on $node — close open files and retry"
        ;;
    esac
  done < <({ lsblk -rno NAME,TYPE "$node" 2>/dev/null || true; })
  return 0
}

# bay_forget_records_on <node>: drop the crypttab line + recovery escrow of
# every LUKS container on <node> (the node itself or anything stacked on it).
# A stale line or key for a container that no longer exists must not outlive
# it. Never fails; run it right before the node is wiped.
bay_forget_records_on() {
  local node="$1" uuid luks_uuids
  luks_uuids="$({ lsblk -rno FSTYPE,UUID "$node" 2>/dev/null || true; } \
    | awk '$1 == "crypto_LUKS" && $2 != "" { print $2 }')"
  for uuid in $luks_uuids; do
    bay_forget_uuid "$uuid"
  done
  return 0
}

# bay_forget_on <node>: both halves, for the single-disk ops (adopt, reclaim,
# pool_format, pool_destroy).
bay_forget_on() {
  bay_close_mappers_on "$1"
  bay_forget_records_on "$1"
}

# bay_format_encrypted <block-node> <fs-label>: LUKS2 + recovery key + TPM2 +
# ext4(quota,project) + mount(prjquota) + files/ + trust + Nextcloud, in the
# order the tests pin. <block-node> was already unmounted, forgotten and wiped.
# Sets BAY_FS_UUID (the filesystem UUID the API and the recovery-key reveal use).
bay_format_encrypted() {
  local node="$1" label="$2" luks_uuid short mapper mapper_dev raw recovery fs_uuid name mnt

  bay_private_dir "$BAY_RUNTIME_DIR"
  BAY_KEYFILE="$BAY_RUNTIME_DIR/.bay-key.$$"
  ( umask 077 && openssl rand 64 > "$BAY_KEYFILE" )
  [ -s "$BAY_KEYFILE" ] || die "could not create the temporary install key — the drive was NOT prepared"

  err "luksFormat (LUKS2/Argon2id) on $node"
  BAY_FORMAT_DEVICE="$node"
  BAY_FORMAT_STARTED=1
  "$BAY_CRYPTSETUP" luksFormat --type luks2 --pbkdf argon2id --batch-mode \
    --key-file "$BAY_KEYFILE" "$node"

  luks_uuid="$("$BAY_CRYPTSETUP" luksUUID "$node" | head -n 1 | tr -d '[:space:]')"
  [[ "$luks_uuid" =~ ^[A-Fa-f0-9-]{8,64}$ ]] \
    || die "could not read the new LUKS UUID of $node — the drive was NOT prepared"
  short="$(printf '%s' "$luks_uuid" | head -c 8)"
  mapper="${BAY_MAPPER_PREFIX}${short}"
  mapper_dev="/dev/mapper/$mapper"

  "$BAY_CRYPTSETUP" open --key-file "$BAY_KEYFILE" "$node" "$mapper"
  BAY_OPEN_MAPPER="$mapper"

  # Recovery keyslot FIRST (WARP-2101): it is enrolled before the TPM2 slot.
  # On failure, bay_cleanup erases the new header rather than leaving this
  # not-yet-escrowed keyslot inaccessible. The key is read from
  # systemd-cryptenroll's STDOUT into a shell variable — never echoed, never
  # logged.
  err "enrolling the recovery keyslot (escrowed for one-time retrieval)"
  raw="$("$BAY_CRYPTENROLL" --unlock-key-file="$BAY_KEYFILE" --recovery-key "$node")"
  recovery="$(printf '%s\n' "$raw" | awk 'NF { l = $0 } END { print l }' | tr -d '[:space:]')"
  raw=""
  [[ "$recovery" =~ ^[a-z0-9-]{16,}$ ]] \
    || die "recovery-key enrolment returned an unexpected value (not shown) — the drive was NOT prepared"

  err "enrolling the TPM2 keyslot (PCRs $(droplet_tpm_pcrs))"
  "$BAY_CRYPTENROLL" --unlock-key-file="$BAY_KEYFILE" --tpm2-device=auto \
    --tpm2-pcrs="$(droplet_tpm_pcrs)" "$node"

  # The temporary install key was only ever a bootstrap: drop its keyslot, then
  # its tmpfs file. From here the container opens via the TPM token or the
  # recovery key only.
  "$BAY_CRYPTSETUP" luksRemoveKey "$node" "$BAY_KEYFILE"
  bay_shred "$BAY_KEYFILE"
  BAY_KEYFILE=""

  # ext4 INSIDE the container; `-I 256` guarantees the inode size the `project`
  # feature needs even on the small-device profile of mke2fs.conf.
  if [ -n "$label" ]; then
    mkfs.ext4 -I 256 -O quota,project -L "$label" "$mapper_dev"
  else
    mkfs.ext4 -I 256 -O quota,project "$mapper_dev"
  fi
  fs_uuid="$(blkid -o value -s UUID "$mapper_dev" 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)"
  [[ "$fs_uuid" =~ ^[A-Fa-f0-9-]{8,64}$ ]] \
    || die "the new filesystem on $mapper_dev reports no UUID — it cannot be addressed or escrowed; the drive was NOT prepared"

  # Escrow the key BEFORE wiring boot config, then forget the variable.
  bay_escrow_put "$luks_uuid" "$fs_uuid" "$recovery"
  recovery=""
  bay_crypttab_add "$luks_uuid"

  # Mount at the SAME <label>-<fs-uuid8> tail droplet-automount derives on
  # reboot (WARP-1338), in the HOST namespace (WARP-868), prjquota so the
  # recordings slice can be a project quota.
  name="$(automount_mount_name "$label" "$fs_uuid")"
  mnt="/mnt/droplet/$name"
  mkdir -p "$mnt"
  host_mount -o "$BAY_MOUNT_OPTS" "$mapper_dev" "$mnt"
  BAY_MOUNTED="$mnt"
  host_run mkdir -p "$mnt/files"
  host_run chown "$NEXTCLOUD_UID:$NEXTCLOUD_UID" "$mnt/files"
  host_run chmod 0770 "$mnt/files"
  # files/ carries project id 4097 (`+P`: inherited by everything created
  # beneath it) so WARP-3514 can cap it with `setquota -P` and the recordings
  # slice (nvr/, project 4096) keeps its share. Fail CLOSED: a bay whose project
  # quotas cannot be used defeats the point of `-O quota,project` + prjquota.
  host_run chattr +P -p "$BAY_FILES_PROJID" "$mnt/files" \
    || die "could not set project id $BAY_FILES_PROJID on $mnt/files — this filesystem or kernel does not support project quotas; the drive was NOT prepared"

  # Keep the reboot remount rw + make it browsable (best-effort), scoped to
  # files/ only.
  trusted_list_add "$fs_uuid"
  nextcloud_register "$name"

  BAY_FS_UUID="$fs_uuid"
  BAY_DONE=1
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
  drive_reclaim)
    # WARP-1048: reclaim a pool-member disk into standalone use. The disk is a
    # linux_raid_member held by an md array, so a plain adopt would EBUSY on
    # wipefs — the execute step first detaches it (mdadm --fail/--remove +
    # --zero-superblock) then runs the adopt flow. Same OS-disk refusal as
    # adopt (never trust the client), and the owning array MUST be named — we
    # never guess which array to break the disk out of. As with adopt, has_data
    # is NOT a refusal (erasing is the point; the typed confirm_phrase naming
    # this disk is the consent).
    [ -n "$RECLAIM_MD" ] || die "drive_reclaim requires the owning 'md' array"
    [[ "$RECLAIM_MD" =~ ^md[0-9]+$ ]] \
      || die "invalid md '$RECLAIM_MD': must match md[0-9]+"
    if is_os_disk "/dev/$DEVICE"; then
      die "refusing: /dev/$DEVICE is (or backs) the OS/boot/system disk — never reclaimable"
    fi
    # WARP-1048 hardening: the disk MUST actually be a member of the named array
    # (kernel sysfs topology) before we ever `mdadm --fail` it. A wrong {disk,md}
    # pair — a stale dashboard view, a disk that already left the array, or the
    # wrong pool named — otherwise yields a raw "mdadm: cannot find <dev>" the
    # owner can't act on. Fail closed here, in the pre-flight (so it also refuses
    # in dry-run), with an owner-actionable message.
    if ! is_md_member "$RECLAIM_MD" "$(basename "/dev/$DEVICE")"; then
      die "refusing: /dev/$DEVICE is not a member of $RECLAIM_MD — nothing to reclaim from that pool (it may have already left the array, or the wrong pool was named)"
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
      # WARP-3513: LUKS2 over the md array (TPM2 + recovery key), then ext4
      # (labelled "pool" — WARP-1338 automount-stable naming) INSIDE it, then
      # mount under /mnt/droplet (prjquota) + create files/ + register that
      # folder with Nextcloud — mirrors drive_adopt's final step so the
      # dashboard's "Format & mount" promise is kept (WARP-936).
      printf 'unmount -> luksFormat LUKS2 + TPM2 + recovery key %s -> mkfs.ext4 -O quota,project -L pool (inside the container) -> mount /mnt/droplet (prjquota) -> files/ -> register nextcloud' \
        "$MD"
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
      # WARP-3513: luksFormat LUKS2 + TPM2 + recovery key → mkfs.ext4 (quota,
      # project) inside the container → mount under /mnt/droplet (prjquota).
      printf 'adopt %s: unmount -> wipe(%s) -> luksFormat LUKS2 + TPM2 + recovery key -> mkfs.ext4 -O quota,project%s (inside the container) -> mount /mnt/droplet (prjquota) -> files/ -> register nextcloud' \
        "$MD" "${WIPE_METHOD:-quick}" \
        "$([ -n "$LABEL" ] && printf ' -L %s' "$LABEL")"
      ;;
    drive_reclaim)
      # detach from the array (fail + remove + zero-superblock) → then the
      # adopt flow (unmount -> wipe -> encrypt -> mkfs -> mount) so the disk is
      # usable standalone.
      printf 'reclaim %s from /dev/%s: mdadm --fail --remove -> --zero-superblock -> wipe(%s) -> luksFormat LUKS2 + TPM2 + recovery key -> mkfs.ext4 -O quota,project%s (inside the container) -> mount /mnt/droplet (prjquota) -> files/ -> register nextcloud' \
        "$MD" "$RECLAIM_MD" "${WIPE_METHOD:-quick}" \
        "$([ -n "$LABEL" ] && printf ' -L %s' "$LABEL")"
      ;;
  esac
}

CMD="$(build_cmd)"

emit_ok() {
  # Single-line JSON the bridge parses with json.loads. WARP-3513: after an
  # encrypted prepare it also names the new filesystem's UUID (what the API and
  # the one-time recovery-key reveal address) and says a key is waiting — never
  # the key itself.
  local extra=""
  if [ -n "$BAY_FS_UUID" ]; then
    extra="$(printf ', "encrypted": true, "uuid": "%s", "recovery_key_pending": true' "$BAY_FS_UUID")"
  fi
  printf '{"ok": true, "device": "%s", "operation": "%s", "dry_run": %s%s}\n' \
    "$DEVICE" "$OP" "$([ -n "$DRY_RUN" ] && echo true || echo false)" "$extra" \
    >&"$EMIT_FD"
}

if [ -n "$DRY_RUN" ]; then
  err "dry-run: would execute: $CMD"
  emit_ok
  exit 0
fi

# --- Execute (real) ----------------------------------------------------------
# WARP-3513: stdout must carry ONLY the final JSON line. mkfs / wipefs /
# systemd-cryptenroll narrate on stdout, and the bridge parses stdout with
# json.loads — one stray line and it falls back to an opaque `message` string,
# losing the new `uuid` / `encrypted` / `recovery_key_pending` fields. So send
# every tool's stdout to stderr (captured separately by the apply wrapper, and
# surfaced only when the op fails) and keep fd 3 as the JSON channel.
exec 3>&1 1>&2
EMIT_FD=3
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
    # WARP-3513: a member that was an encrypted bay still has its dm-crypt
    # mapper open (it holds the disk exclusively, so wipefs would EBUSY).
    # Closing is the failure-prone half, so it joins the "nothing is destroyed
    # until EVERY member has released" phase — before any wipefs below.
    for m in "${MEMBERS[@]}"; do
      bay_close_mappers_on "$m"
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
      # WARP-3513: the crypttab line + escrow of a container about to stop
      # existing (its mapper was closed above, before anything was erased).
      bay_forget_records_on "$m"
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
    # WARP-3513: a prepared pool is md -> LUKS -> ext4. The mount and the open
    # dm-crypt mapper hold the array busy, so `mdadm --stop` would silently
    # fail (it is `|| true` below) and leave a live array behind a "destroyed"
    # pool. Managed, non-lazy teardown first (the typed phrase naming the array
    # is the consent), then close the mapper and drop its crypttab line + escrow.
    teardown_mounts_of "$MD" "refusing to destroy $MD"
    bay_forget_on "$MD"
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
    # WARP-3513: a pool is ALWAYS encrypted — LUKS2 on top of the md device, with
    # the ext4 filesystem inside it. Refuse BEFORE touching anything if the box
    # cannot finish the job (no TPM / tss2 userspace), release any existing
    # mount + mapper (a prepared pool being re-formatted is the normal case),
    # clear the old signatures, then build the encrypted bay.
    bay_preflight
    teardown_mounts_of "$MD" "refusing to format $MD"
    bay_forget_on "$MD"
    wipefs -a "$MD"
    # WARP-1338: label the filesystem so the automount derivation has a
    # stable human-meaningful stem ("pool") — the reboot remount then lands
    # on the SAME pool-<short-uuid> tail as this creation-time mount, and the
    # dashboard's machine-tail guard keeps the tile titled "Storage pool",
    # never a GUID. Complete the flow (WARP-936 UX review): a formatted-but-
    # unmounted array is indistinguishable from an unformatted one in the
    # dashboard, so bay_format_encrypted also mounts it under the shared
    # /mnt/droplet namespace (host_mount, WARP-868), seeds trusted.list and
    # registers files/ with Nextcloud (WARP-1338) — all at the name the udev
    # automount re-derives on reboot.
    bay_format_encrypted "$MD" "pool"
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
    #    WARP-3513: refuse BEFORE the teardown if the box cannot finish an
    #    ENCRYPTED prepare (no TPM / tss2 userspace) — an erased drive with no
    #    way to encrypt it would be a pure loss — and close any dm-crypt mapper
    #    left on the disk (it would EBUSY the wipe) while forgetting its stale
    #    crypttab line + recovery escrow.
    bay_preflight
    teardown_mounts_of "$MD" "refusing to adopt $MD"
    bay_forget_on "$MD"
    # 2) Wipe. quick = clear fs/partition signatures (wipefs); secure = discard
    #    the whole device first (TRIM-based erase for flash), then wipefs.
    case "${WIPE_METHOD:-quick}" in
      secure) blkdiscard -f "$MD" 2>/dev/null || true; wipefs -a "$MD" ;;
      *)      wipefs -a "$MD" ;;
    esac
    # 3+4) WARP-3513: fresh whole-device LUKS2 container (no partition table —
    #    matches how the automount enumerates by-uuid) with the ext4 filesystem
    #    inside it (optional owner-chosen label), mounted under the shared
    #    /mnt/droplet namespace so it's usable now and the device-bridge
    #    surfaces it. Reboot persistence comes from the crypttab line (unlock)
    #    plus the udev automount rule, which matches WHOLE-DISK nodes as of
    #    WARP-936. WARP-868: the mount lands in the HOST namespace, not this
    #    unit's private slave-propagation namespace (which is destroyed on unit
    #    exit). WARP-1338: the tail is automount's own <label>-<short-uuid>
    #    derivation, so the reboot remount lands on the SAME name (a bare
    #    <label> tail changed names on the first reboot, dangling the
    #    Nextcloud registration + dashboard deep-links).
    bay_format_encrypted "$MD" "$LABEL"
    ;;
  drive_reclaim)
    # WARP-1048: reclaim a pool-member disk into standalone use. It is held by
    # an md array (linux_raid_member), so a plain wipefs would EBUSY.
    # 0) DETACH from the array first. --fail marks the member faulty, --remove
    #    detaches it, --zero-superblock erases its md metadata so no array
    #    re-assembles it on the next boot. mdadm --fail on an auto-read-only /
    #    resync=PENDING array (the live md127 shape) succeeds; the array keeps
    #    running degraded on its remaining members (or is the owner's to destroy
    #    separately). We do NOT stop the whole array — reclaiming ONE disk must
    #    not tear down a pool the owner may still want.
    #    WARP-3513: preflight FIRST — the array detach below is destructive, so
    #    a box that cannot finish the encrypted prepare must refuse before it.
    bay_preflight
    RECLAIM_MD_DEV="/dev/$RECLAIM_MD"
    # Membership was asserted in the pre-flight (is_md_member) before we reached
    # here, so --fail can't hit a "cannot find <dev>" on a mismatched {disk,md}.
    mdadm "$RECLAIM_MD_DEV" --fail "$MD" --remove "$MD"
    mdadm --zero-superblock "$MD"
    # 1) Now the disk is free — release any of its mounts (parity with adopt;
    #    a pool member normally isn't mounted, but be safe + non-lazy).
    teardown_mounts_of "$MD" "refusing to reclaim $MD"
    bay_forget_on "$MD"
    # 2) Wipe (quick: wipefs / secure: blkdiscard then wipefs) — same as adopt.
    case "${WIPE_METHOD:-quick}" in
      secure) blkdiscard -f "$MD" 2>/dev/null || true; wipefs -a "$MD" ;;
      *)      wipefs -a "$MD" ;;
    esac
    # 3+4) Encrypted whole-device filesystem, optional owner label, mounted
    #    under the shared /mnt/droplet namespace (host_mount, WARP-868) — same
    #    as adopt; reboot persistence via the crypttab line + the udev
    #    whole-disk automount, at the SAME automount-derived tail (WARP-1338,
    #    see drive_adopt).
    bay_format_encrypted "$MD" "$LABEL"
    ;;
esac

emit_ok
