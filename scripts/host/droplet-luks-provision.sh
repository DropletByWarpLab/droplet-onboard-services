#!/usr/bin/env bash
# =============================================================================
# WARP-232 — LUKS2 + Argon2id data partition with TPM2-sealed unlock (host plane)
# =============================================================================
#
# Creates the encrypted data LV from the free VG extents the autoinstall
# storage layout leaves behind (Task 232.1), seals the unlock key to the TPM2
# (systemd-cryptenroll, PCRs default 0+2+4+7 — device-identity parity), enrolls
# an OFFLINE recovery key shown exactly once, wires crypttab/fstab for
# auto-unlock, and gates docker on /data so a PCR mismatch fails closed.
#
#   /dev/ubuntu-vg/droplet-data           LUKS2/Argon2id container
#   /dev/mapper/droplet-data-crypt        unlocked mapper, mounted at /data
#   /etc/crypttab                         tpm2-device=auto,luks,discard
#   /etc/fstab                            /data ext4 (x-systemd.device-timeout)
#   /etc/systemd/system/docker.service.d/droplet-data.conf   RequiresMountsFor=/data
#
# See droplet-tpm-lib.sh for why systemd tooling (systemd-cryptenroll) and not
# clevis / raw tpm2-tools / tpm2-pytss.
#
# Subcommands: provision | status   (see --help)
# Exit codes:  0 ok · 2 precondition (no TPM / no free extents / bad usage)
#
# Crypto-shred: `cryptsetup luksErase` + TPM clear destroys every keyslot →
# the data LV is ciphertext forever (docs/security/crypto-shred.md).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=droplet-tpm-lib.sh
source "$SCRIPT_DIR/droplet-tpm-lib.sh"

VG="${DROPLET_LUKS_VG:-ubuntu-vg}"
LV="${DROPLET_LUKS_LV:-droplet-data}"
MAPPER="${DROPLET_LUKS_MAPPER:-droplet-data-crypt}"
DATA_MOUNT="${DROPLET_DATA_MOUNT:-/data}"
ETC_DIR="${DROPLET_ETC_DIR:-/etc}"
RUNTIME_DIR="${DROPLET_LUKS_RUNTIME_DIR:-/run/droplet}"

# Tool seams (default to production binaries; tests inject PATH stubs).
LVCREATE="${DROPLET_LVCREATE_BIN:-lvcreate}"
VGS="${DROPLET_VGS_BIN:-vgs}"
MKFS="${DROPLET_MKFS_BIN:-mkfs.ext4}"
MOUNT="${DROPLET_MOUNT_BIN:-mount}"
CRYPTSETUP="$(droplet_tpm_cryptsetup)"
CRYPTENROLL="$(droplet_tpm_cryptenroll)"
SYSTEMD_CRYPTSETUP="${DROPLET_SYSTEMD_CRYPTSETUP_BIN:-/usr/lib/systemd/systemd-cryptsetup}"

LV_DEV="/dev/${VG}/${LV}"
MAPPER_DEV="/dev/mapper/${MAPPER}"
CRYPTTAB="$ETC_DIR/crypttab"
FSTAB="$ETC_DIR/fstab"
DOCKER_DROPIN_DIR="$ETC_DIR/systemd/system/docker.service.d"
DOCKER_DROPIN="$DOCKER_DROPIN_DIR/droplet-data.conf"

log() { printf '  [droplet-luks-provision] %s\n' "$*"; }
err() { printf '  [droplet-luks-provision] ERROR: %s\n' "$*" >&2; }

_require_tpm() {
  if droplet_tpm_present; then
    return 0
  fi
  if [ "${DROPLET_LUKS_ALLOW_NO_TPM:-0}" = "1" ]; then
    log "WARNING: no TPM at ${DROPLET_TPM_DEVICE:-/dev/tpm0} but DROPLET_LUKS_ALLOW_NO_TPM=1 —"
    log "WARNING: proceeding for DEV ONLY. The data partition will NOT be TPM-sealed."
    return 0
  fi
  err "no TPM device at ${DROPLET_TPM_DEVICE:-/dev/tpm0} — refusing to provision the encrypted data partition."
  err "The data surfaces stay on the unencrypted root. On a real appliance this must be fixed;"
  err "on a dev box set DROPLET_LUKS_ALLOW_NO_TPM=1 to force plain-key provisioning."
  exit 2
}

_mapper_active() {
  # Prefer findmnt on the mount target (test-observable); fall back to the node.
  if findmnt -n -o SOURCE "$DATA_MOUNT" >/dev/null 2>&1; then return 0; fi
  [ -e "$MAPPER_DEV" ]
}

_has_free_extents() {
  local free
  free="$("$VGS" --noheadings -o vg_free_count "$VG" 2>/dev/null | tr -d ' ' || echo 0)"
  [ -n "$free" ] && [ "$free" != "0" ] 2>/dev/null
}

_append_if_absent() { # $1=file $2=match $3=line
  local file="$1" match="$2" line="$3"
  mkdir -p "$(dirname "$file")"
  if [ -f "$file" ] && grep -qF "$match" "$file" 2>/dev/null; then
    return 0
  fi
  printf '%s\n' "$line" >> "$file"
}

cmd_provision() {
  # Production is Linux-only. The hermetic harness sets DROPLET_LUKS_SKIP_OS_GATE=1
  # so the stubbed drill can exercise the full flow on any OS (macOS CI/dev).
  if [ "${DROPLET_LUKS_SKIP_OS_GATE:-0}" != "1" ] && [ "$(uname)" != "Linux" ]; then
    log "not Linux — skipping LUKS data-partition provisioning"
    return 0
  fi
  _require_tpm

  # Idempotency: already unlocked + mounted → no-op.
  if _mapper_active; then
    log "$MAPPER already active / $DATA_MOUNT mounted — nothing to do"
    return 0
  fi

  # If the LUKS LV already exists but is locked, just open + mount it.
  if [ -e "$LV_DEV" ] && "$CRYPTSETUP" isLuks "$LV_DEV" 2>/dev/null; then
    log "existing LUKS container at $LV_DEV — opening (no re-format)"
    "$SYSTEMD_CRYPTSETUP" attach "$MAPPER" "$LV_DEV" - tpm2-device=auto 2>/dev/null \
      || "$CRYPTSETUP" open "$LV_DEV" "$MAPPER" 2>/dev/null || true
    _mount_and_wire
    return 0
  fi

  if ! _has_free_extents; then
    err "volume group $VG has no free extents — cannot create the data LV."
    err "Pre-WARP-232 images used the whole-disk lvm layout; encrypted-at-rest for such"
    err "boxes arrives via reflash/migration (docs/security/at-rest-encryption.md)."
    exit 2
  fi

  mkdir -p "$RUNTIME_DIR"; chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
  local keyfile="$RUNTIME_DIR/.luks-key.$$"
  # Temp install keyfile lives in the tmpfs runtime dir only; removed below.
  ( umask 077 && openssl rand 64 > "$keyfile" )

  log "creating data LV from free extents: $LV in $VG"
  "$LVCREATE" -l 100%FREE -n "$LV" "$VG"

  log "formatting LUKS2/Argon2id on $LV_DEV"
  "$CRYPTSETUP" luksFormat --type luks2 --pbkdf argon2id --batch-mode \
    --key-file "$keyfile" "$LV_DEV"

  log "enrolling TPM2 keyslot (PCRs $(droplet_tpm_pcrs))"
  "$CRYPTENROLL" --unlock-key-file="$keyfile" --tpm2-device=auto \
    --tpm2-pcrs="$(droplet_tpm_pcrs)" "$LV_DEV"

  log "enrolling recovery keyslot — the key is shown ONCE below"
  local recovery
  recovery="$("$CRYPTENROLL" --unlock-key-file="$keyfile" --recovery-key "$LV_DEV")"
  printf '\n=== STORE THIS RECOVERY KEY OFFLINE — IT IS SHOWN ONCE ===\n'
  printf '%s\n' "$recovery"
  printf '=== (never written to disk; see docs/security/at-rest-encryption.md) ===\n\n'

  log "removing the temporary install keyslot"
  "$CRYPTSETUP" luksRemoveKey "$LV_DEV" "$keyfile"
  rm -f "$keyfile"

  log "opening $MAPPER and formatting the filesystem"
  "$SYSTEMD_CRYPTSETUP" attach "$MAPPER" "$LV_DEV" - tpm2-device=auto 2>/dev/null \
    || "$CRYPTSETUP" open "$LV_DEV" "$MAPPER" 2>/dev/null || true
  if ! blkid -o value -s TYPE "$MAPPER_DEV" 2>/dev/null | grep -q ext4; then
    "$MKFS" -L droplet-data "$MAPPER_DEV"
  fi
  _mount_and_wire
  _maybe_write_docker_data_root
  log "provisioned encrypted data partition at $DATA_MOUNT"
}

_mount_and_wire() {
  # The mountpoint dir + the mount itself are best-effort: on a real box they
  # succeed; the crypttab/fstab wiring below is what makes /data come up on the
  # NEXT boot regardless, and the hermetic harness has no real /data.
  mkdir -p "$DATA_MOUNT" 2>/dev/null || true
  "$MOUNT" "$MAPPER_DEV" "$DATA_MOUNT" 2>/dev/null || true

  # crypttab: auto-unlock via the TPM2 header token.
  _append_if_absent "$CRYPTTAB" "$MAPPER" \
    "$MAPPER $LV_DEV none tpm2-device=auto,luks,discard"
  # fstab: mount /data with a bounded device timeout so a locked LUKS device
  # can't hang the boot forever (it falls to the docker fail-closed gate).
  _append_if_absent "$FSTAB" "$DATA_MOUNT ext4" \
    "$MAPPER_DEV $DATA_MOUNT ext4 defaults,x-systemd.device-timeout=30 0 2"
  # docker fail-closed gate: no /data ⇒ docker (and every data-bearing
  # container) refuses to start = "falls to recovery" on a PCR mismatch.
  mkdir -p "$DOCKER_DROPIN_DIR"
  if [ ! -f "$DOCKER_DROPIN" ]; then
    printf '[Unit]\n# WARP-232: docker must not start without the encrypted /data mount.\nRequiresMountsFor=/data\n' \
      > "$DOCKER_DROPIN"
  fi
}

_maybe_write_docker_data_root() {
  local daemon_json="$ETC_DIR/docker/daemon.json"
  if [ -f "$daemon_json" ]; then
    log "existing $daemon_json — leaving docker data-root alone (see --migrate-data runbook)"
    return 0
  fi
  mkdir -p "$(dirname "$daemon_json")"
  printf '{\n  "data-root": "/data/docker"\n}\n' > "$daemon_json"
  log "wrote $daemon_json (docker data-root on the encrypted /data)"
}

cmd_status() {
  local encrypted=false mounted=false tpm_enrolled=false
  if [ -e "$LV_DEV" ] && "$CRYPTSETUP" isLuks "$LV_DEV" 2>/dev/null; then encrypted=true; fi
  if _mapper_active; then mounted=true; fi
  if [ -e "$LV_DEV" ] && "$CRYPTSETUP" luksDump "$LV_DEV" 2>/dev/null | grep -qi 'systemd-tpm2'; then
    tpm_enrolled=true
  fi
  printf '{"encrypted":%s,"mounted":%s,"tpm_enrolled":%s}\n' "$encrypted" "$mounted" "$tpm_enrolled"
}

case "${1:-}" in
  provision) cmd_provision ;;
  status)    cmd_status ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) err "usage: droplet-luks-provision.sh {provision|status}"; exit 2 ;;
esac
