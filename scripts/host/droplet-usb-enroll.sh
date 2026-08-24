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

# Where .env lives — needed so `derive` can fall back to the on-disk
# DEVICE_SECRET_KEY when the process env doesn't carry it (the production case:
# systemd/udev scrub the environment — see droplet_usb_derive_passphrase).
# Precedence:
#   1. DROPLET_ENV_FILE (explicit override / hermetic tests)
#   2. $DROPLET_REPO_ROOT/.env (explicit repo root)
#   3. first existing .env among the well-known install locations — the enroll
#      script is installed to /usr/local/sbin, so $SCRIPT_DIR/../.. is /usr and
#      NOT the repo; probing fixed paths is what makes the automount recovery-
#      slot fallback actually work (finding 4). The relocated path
#      (/data/droplet/env/.env) is listed first: after WARP-232 relocation the
#      canonical .env lives inside the encrypted /data and the repo path is a
#      symlink to it (either resolves, but prefer the real file).
_resolve_env_file() {
  if [ -n "${DROPLET_ENV_FILE:-}" ]; then printf '%s' "$DROPLET_ENV_FILE"; return; fi
  if [ -n "${DROPLET_REPO_ROOT:-}" ]; then printf '%s' "$DROPLET_REPO_ROOT/.env"; return; fi
  local c
  for c in \
    /data/droplet/env/.env \
    /home/droplet/edge-platform/.env \
    /opt/droplet/.env \
    "$SCRIPT_DIR/../../.env"; do
    if [ -f "$c" ]; then printf '%s' "$c"; return; fi
  done
  # Fall back to the repo-relative guess even if it doesn't exist (keeps the
  # error message pointing somewhere sensible).
  printf '%s' "$SCRIPT_DIR/../../.env"
}
ENV_FILE="$(_resolve_env_file)"

# The versioned USB derivation salt — disjoint from restic's droplet-restic-v1.
USB_LUKS_SALT="droplet-usb-luks-v1"

log() { printf '  [droplet-usb-enroll] %s\n' "$*"; }
err() { printf '  [droplet-usb-enroll] ERROR: %s\n' "$*" >&2; }

# --- HKDF helpers (same shape as droplet-backup-lib.sh; OpenSSL 1.1/3.0-safe) ---
_usb_str_to_hex() { printf '%s' "$1" | od -An -v -t x1 | tr -d ' \n'; }
_usb_hmac_sha256_hex() { openssl dgst -sha256 -mac HMAC -macopt "hexkey:$1" | awk '{print $NF}'; }

# droplet_usb_derive_passphrase <luks-uuid> — recovery passphrase on stdout.
#
# IKM precedence (WARP-232 finding 4): $DEVICE_SECRET_KEY env, else
# DEVICE_SECRET_KEY= from $ENV_FILE. This MIRRORS droplet-backup-lib.sh's
# droplet_backup_derive_password — WITHOUT the .env fallback, the production
# invocation `sudo droplet-usb-enroll.sh enroll` (and `derive`, and the
# automount recovery-slot fallback, all of which run under systemd/udev with a
# scrubbed env) had an EMPTY DEVICE_SECRET_KEY, so every derive failed: enroll
# died under set -e AFTER the TPM slot but BEFORE the recovery slot (stranding a
# half-enrolled drive), `derive` always exited 2, and the automount derived-slot
# fallback was dead code.
droplet_usb_derive_passphrase() {
  local uuid="${1:-}"
  local ikm="${DEVICE_SECRET_KEY:-}"
  if [ -z "$ikm" ] && [ -f "$ENV_FILE" ]; then
    # `|| true` keeps a no-match grep (exit 1) from tripping set -euo pipefail;
    # the empty-check below is the real gate.
    ikm="$( { grep -E '^DEVICE_SECRET_KEY=' "$ENV_FILE" 2>/dev/null || true; } | head -n 1 | cut -d= -f2-)"
  fi
  if [ -z "$ikm" ]; then
    err "DEVICE_SECRET_KEY is empty (env AND $ENV_FILE) — cannot derive the USB recovery passphrase."
    err "Run ./scripts/setup.sh first (it mints the device identity secrets into .env)."
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
# WARP-2151: compare PHYSICAL DISK SETS by walking lsblk's inverse tree —
# one PKNAME hop returns the PV *partition* on an LVM root, so the old
# comparisons never matched the ESP/boot partitions and enroll would have
# luksFormatted the live /boot on request.
_phys_disks_of() { # $1=node
  # `|| true`: under set -e/pipefail an unresolvable node must yield an
  # empty set, not abort — the caller decides what empty means.
  lsblk -rnso NAME,TYPE "$1" 2>/dev/null | awk '$2 == "disk" { print $1 }' | sort -u || true
}

_guard_not_rootfs() { # $1=device
  local dev="$1" boot_src boot_disks dev_disks _d
  boot_src="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
  boot_disks="$(_phys_disks_of "$boot_src")"
  dev_disks="$(_phys_disks_of "$dev")"
  if [ "$dev" = "$boot_src" ]; then
    err "$dev holds / is a sibling of the boot device — refusing to enroll it."
    exit 2
  fi
  if [ -n "$boot_disks" ]; then
    for _d in $dev_disks; do
      if printf '%s\n' "$boot_disks" | grep -qxF "$_d"; then
        err "$dev holds / is a sibling of the boot device — refusing to enroll it."
        exit 2
      fi
    done
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

  # WARP-232 (finding 4): FAIL FAST if the recovery passphrase can't be derived,
  # BEFORE we wipe/format the drive. Deriving needs DEVICE_SECRET_KEY (env or
  # .env); if it's absent the old flow only discovered that AFTER luksFormat +
  # the TPM enroll — leaving a drive with a TPM-only slot and no recoverable
  # unlock path if the TPM is ever lost. We probe derivation here (any uuid — the
  # gate is only "is DEVICE_SECRET_KEY present"): a failure aborts with the drive
  # untouched.
  if ! droplet_usb_derive_passphrase "preflight-probe" >/dev/null 2>&1; then
    err "cannot derive the recovery passphrase (DEVICE_SECRET_KEY absent in env AND $ENV_FILE)."
    err "Refusing to format $dev — a drive with only a TPM keyslot is unrecoverable after TPM loss."
    err "Run ./scripts/setup.sh first, or export DEVICE_SECRET_KEY."
    exit 2
  fi

  if [ "$force" != "1" ]; then
    printf '  This will DESTROY all data on %s and format it LUKS2/Argon2id.\n' "$dev"
    printf '  Type ENROLL to continue: '
    local confirm; read -r confirm
    [ "$confirm" = "ENROLL" ] || { err "aborted (no confirmation)"; exit 2; }
  fi

  mkdir -p "$RUNTIME_DIR"; chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
  local keyfile="$RUNTIME_DIR/.usb-key.$$"
  local passfile="$RUNTIME_DIR/.usb-pass.$$"
  # WARP-232 (finding 4): shred the tmpfs key/pass material on ANY exit path so
  # an interrupted or failed enroll never strands raw key bytes in /run. The
  # trap is scoped to this function's mapper too (closed below on the happy path).
  # shellcheck disable=SC2064  # expand keyfile/passfile now, into the trap body.
  trap "shred -u '$keyfile' '$passfile' 2>/dev/null || rm -f '$keyfile' '$passfile' 2>/dev/null || true" RETURN
  ( umask 077 && openssl rand 64 > "$keyfile" )

  log "wiping existing signatures on $dev"
  wipefs -a "$dev" 2>/dev/null || wipefs "$dev" 2>/dev/null || true

  log "formatting LUKS2/Argon2id on $dev"
  "$CRYPTSETUP" luksFormat --type luks2 --pbkdf argon2id --batch-mode \
    --key-file "$keyfile" "$dev"

  # Order (finding 4): add the DERIVED RECOVERY slot BEFORE the TPM slot. The
  # recovery slot is the durable, TPM-independent unlock path; enrolling it first
  # means an interruption after this point still leaves a fully recoverable drive
  # (the operator can always re-derive the passphrase from .env), whereas the old
  # order (TPM first, recovery second) left a TPM-only drive unrecoverable if the
  # run died between the two enrolls.
  local uuid
  uuid="$(blkid -o value -s UUID "$dev" 2>/dev/null || true)"
  uuid="${uuid//$'\n'/}"
  log "adding the derived recovery keyslot (re-derivable on-box from .env)"
  ( umask 077 && droplet_usb_derive_passphrase "$uuid" > "$passfile" )
  "$CRYPTSETUP" luksAddKey --key-file "$keyfile" "$dev" "$passfile"
  rm -f "$passfile"

  log "enrolling TPM2 keyslot (PCRs $(droplet_tpm_pcrs))"
  "$CRYPTENROLL" --unlock-key-file="$keyfile" --tpm2-device=auto \
    --tpm2-pcrs="$(droplet_tpm_pcrs)" "$dev"

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
