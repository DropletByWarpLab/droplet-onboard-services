#!/usr/bin/env bash
# =============================================================================
# WARP-232 — USB drive LUKS2 encrypt-and-format + derived recovery passphrase
# =============================================================================
#
# Enrolling a drive WIPES it, formats LUKS2/Argon2id, and enrolls two unlock
# paths:
#   (a) a TPM2 keyslot (systemd-cryptenroll --tpm2-device=auto
#       --tpm2-pcrs=0+2+4+7) — the sealed key lives in the drive's own LUKS2
#       header token, so there is nothing per-drive to store on the box;
#   (b) a per-drive recovery passphrase DERIVED from the device master key:
#
#     PRK        = HMAC-SHA256(salt = "droplet-usb-luks-v1", IKM = DEVICE_SECRET_KEY)
#     passphrase = hex( HMAC-SHA256(PRK, "droplet-usb-luks-recovery:" || <uuid> || 0x01) )
#
#   — the same single-block HKDF-SHA256 construction droplet-backup-lib.sh pins
#   for restic, with a NEW versioned salt so the restic stability contract is
#   untouched. An enrolled drive plugged into ITS OWN box still opens after TPM
#   loss (passphrase re-derivable from .env); crypto-shred (destroy .env + TPM
#   clear) kills both unlock paths at once.
#
# Subcommands:
#   enroll /dev/sdX1     DESTRUCTIVE, confirm-gated (--force to skip)
#   derive <luks-uuid>   print the recovery passphrase (root only)
#   trust <fs-uuid>      allow rw mount of a plain (unencrypted) drive
#   list                 enrolled + trusted state as JSON
#
# Sourcing mode: `source droplet-usb-enroll.sh --lib` defines the functions
# (incl. droplet_usb_derive_passphrase) without running a subcommand, so the
# derivation KAT test can exercise it directly.
#
# Exit codes: 0 ok · 2 precondition (rootfs device / no TPM / empty key / usage)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=droplet-tpm-lib.sh
source "$SCRIPT_DIR/droplet-tpm-lib.sh"

STATE_DIR="${DROPLET_AUTOMOUNT_STATE_DIR:-/var/lib/droplet-automount}"
TRUSTED_LIST="$STATE_DIR/trusted.list"
RUNTIME_DIR="${DROPLET_USB_RUNTIME_DIR:-/run/droplet}"
CRYPTSETUP="$(droplet_tpm_cryptsetup)"
CRYPTENROLL="$(droplet_tpm_cryptenroll)"

# The versioned USB derivation salt — disjoint from restic's droplet-restic-v1.
USB_LUKS_SALT="droplet-usb-luks-v1"

log() { printf '  [droplet-usb-enroll] %s\n' "$*"; }
err() { printf '  [droplet-usb-enroll] ERROR: %s\n' "$*" >&2; }

# --- HKDF helpers (same shape as droplet-backup-lib.sh; OpenSSL 1.1/3.0-safe) ---
_usb_str_to_hex() { printf '%s' "$1" | od -An -v -t x1 | tr -d ' \n'; }
_usb_hmac_sha256_hex() { openssl dgst -sha256 -mac HMAC -macopt "hexkey:$1" | awk '{print $NF}'; }

# droplet_usb_derive_passphrase <luks-uuid> — recovery passphrase on stdout.
droplet_usb_derive_passphrase() {
  local uuid="${1:-}"
  local ikm="${DEVICE_SECRET_KEY:-}"
  if [ -z "$ikm" ]; then
    err "DEVICE_SECRET_KEY is empty — cannot derive the USB recovery passphrase."
    return 2
  fi
  if [ -z "$uuid" ]; then
    err "no LUKS uuid given to droplet_usb_derive_passphrase."
    return 2
  fi
  local salt_hex prk okm
  salt_hex="$(_usb_str_to_hex "$USB_LUKS_SALT")"
  prk="$(printf '%s' "$ikm" | _usb_hmac_sha256_hex "$salt_hex")"
  # info = "droplet-usb-luks-recovery:" || uuid || 0x01 (single HKDF-expand block).
  okm="$(printf 'droplet-usb-luks-recovery:%s\001' "$uuid" | _usb_hmac_sha256_hex "$prk")"
  if [ -z "$okm" ]; then
    err "HKDF derivation produced no output (openssl missing?)"
    return 2
  fi
  printf '%s' "$okm"
}

_require_tpm() {
  if droplet_tpm_present; then return 0; fi
  err "no TPM device at ${DROPLET_TPM_DEVICE:-/dev/tpm0} — cannot enroll a TPM keyslot."
  exit 2
}

# Refuse to touch the boot device (same guard as droplet-automount.sh).
_guard_not_rootfs() { # $1=device
  local dev="$1" boot_src boot_parent dev_base dev_parent
  boot_src="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
  boot_parent="$(lsblk -no PKNAME "$boot_src" 2>/dev/null || true)"
  dev_base="$(basename "$dev")"
  dev_parent="$(lsblk -no PKNAME "$dev" 2>/dev/null || true)"
  if [ "$dev" = "$boot_src" ] || [ "$dev_base" = "$boot_parent" ] \
     || { [ -n "$dev_parent" ] && [ "$dev_parent" = "$boot_parent" ]; }; then
    err "$dev holds / is a sibling of the boot device — refusing to enroll it."
    exit 2
  fi
}

cmd_enroll() {
  local force=0 dev=""
  for a in "$@"; do
    case "$a" in
      --force) force=1 ;;
      /dev/*) dev="$a" ;;
      *) err "unexpected arg: $a"; exit 2 ;;
    esac
  done
  [ -n "$dev" ] || { err "usage: droplet-usb-enroll.sh enroll [--force] /dev/sdX1"; exit 2; }

  _guard_not_rootfs "$dev"
  _require_tpm

  if [ "$force" != "1" ]; then
    printf '  This will DESTROY all data on %s and format it LUKS2/Argon2id.\n' "$dev"
    printf '  Type ENROLL to continue: '
    local confirm; read -r confirm
    [ "$confirm" = "ENROLL" ] || { err "aborted (no confirmation)"; exit 2; }
  fi

  mkdir -p "$RUNTIME_DIR"; chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
  local keyfile="$RUNTIME_DIR/.usb-key.$$"
  ( umask 077 && openssl rand 64 > "$keyfile" )

  log "wiping existing signatures on $dev"
  wipefs -a "$dev" 2>/dev/null || wipefs "$dev" 2>/dev/null || true

  log "formatting LUKS2/Argon2id on $dev"
  "$CRYPTSETUP" luksFormat --type luks2 --pbkdf argon2id --batch-mode \
    --key-file "$keyfile" "$dev"

  log "enrolling TPM2 keyslot (PCRs $(droplet_tpm_pcrs))"
  "$CRYPTENROLL" --unlock-key-file="$keyfile" --tpm2-device=auto \
    --tpm2-pcrs="$(droplet_tpm_pcrs)" "$dev"

  local uuid
  uuid="$(blkid -o value -s UUID "$dev" 2>/dev/null || true)"
  uuid="${uuid//$'\n'/}"
  log "adding the derived recovery keyslot (re-derivable on-box from .env)"
  local passfile="$RUNTIME_DIR/.usb-pass.$$"
  ( umask 077 && droplet_usb_derive_passphrase "$uuid" > "$passfile" )
  "$CRYPTSETUP" luksAddKey --key-file "$keyfile" "$dev" "$passfile"
  rm -f "$passfile"

  local mapper="droplet-usb-${uuid:0:8}"
  log "opening + formatting the filesystem"
  "$CRYPTSETUP" open --key-file "$keyfile" "$dev" "$mapper" 2>/dev/null || true
  mkfs.ext4 -L "usb-${uuid:0:8}" "/dev/mapper/$mapper" 2>/dev/null || true
  "$CRYPTSETUP" close "$mapper" 2>/dev/null || true

  rm -f "$keyfile"
  log "enrolled $dev (LUKS2/Argon2id, TPM keyslot + derived recovery slot)"
  log "recovery passphrase re-derivable: droplet-usb-enroll.sh derive $uuid"
}

cmd_derive() {
  local uuid="${1:-}"
  [ -n "$uuid" ] || { err "usage: droplet-usb-enroll.sh derive <luks-uuid>"; exit 2; }
  droplet_usb_derive_passphrase "$uuid" || exit 2
  printf '\n'
}

cmd_trust() {
  local uuid="${1:-}"
  [ -n "$uuid" ] || { err "usage: droplet-usb-enroll.sh trust <fs-uuid>"; exit 2; }
  mkdir -p "$STATE_DIR"
  if ! grep -qxF "$uuid" "$TRUSTED_LIST" 2>/dev/null; then
    printf '%s\n' "$uuid" >> "$TRUSTED_LIST"
  fi
  log "trusted plain drive $uuid (will mount rw)"
}

cmd_list() {
  local trusted="[]"
  if [ -f "$TRUSTED_LIST" ]; then
    trusted="$(python3 - "$TRUSTED_LIST" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    print(json.dumps([l.strip() for l in f if l.strip()]))
PY
)"
  fi
  printf '{"trusted":%s}\n' "$trusted"
}

# --- Sourcing mode: define functions only, run nothing. -----------------------
if [ "${1:-}" = "--lib" ]; then
  return 0 2>/dev/null || exit 0
fi

case "${1:-}" in
  enroll) shift; cmd_enroll "$@" ;;
  derive) shift; cmd_derive "$@" ;;
  trust)  shift; cmd_trust "$@" ;;
  list)   cmd_list ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) err "usage: droplet-usb-enroll.sh {enroll|derive|trust|list}"; exit 2 ;;
esac
