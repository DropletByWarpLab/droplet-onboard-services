#!/usr/bin/env bash
# =============================================================================
# WARP-232 — crypto-shred decommissioning (destroy-the-key)
# =============================================================================
#
# Makes every at-rest surface permanently unreadable by destroying the KEYS,
# not the ciphertext. The key-destruction chain (each link orphans a class of
# data):
#
#   cryptsetup luksErase   → data LV + every enrolled USB drive: no keyslot
#                            can ever unlock the LUKS2 container again.
#   tpm2_clear             → the TPM sealing hierarchy: the sealed LUKS/KEK
#                            blobs are undecryptable forever (even the recovery
#                            keyslots on the LUKS headers are already gone).
#   shred .env + secrets   → DEVICE_SECRET_KEY: the HKDF input for the restic
#                            repo password AND the USB per-drive recovery slots
#                            AND the doc-KEK recovery path — so every restic
#                            snapshot is orphaned and no recovery slot survives.
#   factory-reset.sh       → the app-level purge (volumes, data/secrets dir).
#
# After this runs: pulling any disk and mounting it elsewhere yields ciphertext
# only; `restic snapshots` on the backup repo fails auth (password
# unrecoverable). See docs/security/crypto-shred.md.
#
# DESTRUCTIVE AND IRREVERSIBLE. Double-gated: --yes-destroy-everything AND a
# typed CONFIRM prompt.
#
# Exit codes: 0 ok · 2 precondition / not confirmed.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=droplet-tpm-lib.sh
source "$SCRIPT_DIR/droplet-tpm-lib.sh"

REPO_ROOT="${DROPLET_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd || echo /opt/droplet)}"
LUKS_LV="${DROPLET_LUKS_DEV:-/dev/ubuntu-vg/droplet-data}"
AUTOMOUNT_STATE="${DROPLET_AUTOMOUNT_STATE_DIR:-/var/lib/droplet-automount}"
ENV_FILE="${DROPLET_ENV_FILE:-$REPO_ROOT/.env}"
SECRETS_DIR="${DROPLET_SECRETS_DIR:-$REPO_ROOT/data/secrets}"
FACTORY_RESET="${DROPLET_FACTORY_RESET:-$REPO_ROOT/scripts/factory-reset.sh}"
CRYPTSETUP="$(droplet_tpm_cryptsetup)"
CRYPTENROLL="$(droplet_tpm_cryptenroll)"
TPM2_CLEAR="${DROPLET_TPM2_CLEAR_BIN:-tpm2_clear}"

log() { printf '  [droplet-crypto-shred] %s\n' "$*"; }
err() { printf '  [droplet-crypto-shred] ERROR: %s\n' "$*" >&2; }

# --- Double-confirmation gate ------------------------------------------------
CONFIRM_FLAG=0
for a in "$@"; do
  case "$a" in --yes-destroy-everything) CONFIRM_FLAG=1 ;; esac
done
if [ "$CONFIRM_FLAG" != "1" ]; then
  err "refusing: pass --yes-destroy-everything to arm this IRREVERSIBLE operation."
  err "It destroys every unlock key: LUKS keyslots, the TPM hierarchy, and .env"
  err "(orphaning all restic backups). See docs/security/crypto-shred.md."
  exit 2
fi
printf '\n  *** CRYPTO-SHRED: this PERMANENTLY destroys all at-rest keys. ***\n'
printf '  Every LUKS keyslot, the TPM sealing hierarchy, and .env will be erased.\n'
printf '  Backups become unrecoverable (restic password is derived from .env).\n'
printf '  Type CONFIRM to proceed: '
CONFIRM_INPUT=""
if [ "${DROPLET_SHRED_ASSUME_CONFIRM:-0}" = "1" ]; then
  CONFIRM_INPUT="CONFIRM"; printf '(auto-confirmed via DROPLET_SHRED_ASSUME_CONFIRM)\n'
else
  read -r CONFIRM_INPUT
fi
[ "$CONFIRM_INPUT" = "CONFIRM" ] || { err "aborted (typed confirmation did not match)"; exit 2; }

# --- (1) Erase every LUKS keyslot -------------------------------------------
log "erasing LUKS keyslots on the data LV: $LUKS_LV"
"$CRYPTSETUP" luksErase --batch-mode "$LUKS_LV" 2>/dev/null || log "  (data LV not present / already erased)"

# Every enrolled USB drive recorded in the automount state.
if [ -f "$AUTOMOUNT_STATE/mounts.json" ]; then
  while IFS= read -r dev; do
    [ -z "$dev" ] && continue
    log "erasing LUKS keyslots on enrolled USB device: $dev"
    "$CRYPTSETUP" luksErase --batch-mode "$dev" 2>/dev/null || true
  done < <(python3 - "$AUTOMOUNT_STATE/mounts.json" <<'PY'
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    s = {"mounts": []}
for m in s.get("mounts", []):
    if m.get("trust") == "enrolled" and m.get("device"):
        print(m["device"])
PY
)
fi

# --- (2) Clear the TPM sealing hierarchy ------------------------------------
if command -v "$TPM2_CLEAR" >/dev/null 2>&1; then
  log "clearing the TPM (tpm2_clear)"
  "$TPM2_CLEAR" 2>/dev/null || log "  (tpm2_clear failed — clear the TPM from BIOS/UEFI setup)"
else
  log "tpm2_clear not available — wiping the TPM2 keyslot per device instead"
  "$CRYPTENROLL" --wipe-slot=tpm2 "$LUKS_LV" 2>/dev/null || true
  log "  ALSO clear the TPM from BIOS/UEFI setup ('Clear TPM' / 'Security Device')."
fi

# --- (3) Shred the derivation inputs ----------------------------------------
# .env carries DEVICE_SECRET_KEY (restic password + USB recovery + doc-KEK
# recovery all derive from it); data/secrets carries the audit signing key.
# These resolve through the WARP-232 symlinks to the canonical /data paths.
if [ -e "$ENV_FILE" ]; then
  log "shredding $ENV_FILE (DEVICE_SECRET_KEY — orphans every restic snapshot)"
  shred -u "$ENV_FILE" 2>/dev/null || rm -f "$ENV_FILE"
fi
if [ -d "$SECRETS_DIR" ]; then
  log "shredding secrets under $SECRETS_DIR"
  find "$SECRETS_DIR" -type f -exec shred -u {} \; 2>/dev/null || true
fi

# --- (4) App-level purge -----------------------------------------------------
if [ -x "$FACTORY_RESET" ]; then
  log "chaining to factory-reset.sh for the app-level purge (volumes, secrets dir)"
  "$FACTORY_RESET" --force 2>/dev/null || bash "$FACTORY_RESET" 2>/dev/null || \
    log "  (factory-reset returned non-zero — run scripts/factory-reset.sh manually)"
else
  log "factory-reset.sh not executable at $FACTORY_RESET — run it manually to purge app data"
fi

# --- (5) Post-conditions checklist ------------------------------------------
cat <<'DONE'

  ================================================
  CRYPTO-SHRED COMPLETE — verify the post-conditions:
    - cryptsetup luksDump /dev/ubuntu-vg/droplet-data  → no usable keyslots
    - restic -r <repo> snapshots                        → auth failure
    - Clear the TPM from BIOS/UEFI if tpm2_clear was unavailable.
    - The disk is now ciphertext-only: safe to RMA / discard.
  See docs/security/crypto-shred.md for the full verification runbook.
  ================================================

DONE
log "done"
