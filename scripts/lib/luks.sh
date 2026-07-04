#!/usr/bin/env bash
# luks.sh — WARP-232 LUKS2 data-partition host integration (install path).
# Source this file; do not execute directly.
#
# Installs + runs the first-boot provisioning:
#   /usr/local/sbin/droplet-tpm-lib.sh           shared TPM seams (sourced)
#   /usr/local/sbin/droplet-luks-provision.sh    provision | status
# then, once /data is a real encrypted mount, relocates the crypto-sensitive
# secrets (.env + data/secrets) onto it and leaves symlinks behind so every
# existing consumer (grep/source, droplet-backup.sh's CONFIG_CANDIDATES, the
# compose ../data/secrets bind) keeps working transparently.
#
# Linux-only; skipped silently elsewhere. Non-fatal (setup.sh continues and a
# re-run self-heals) — matching install_restic_backup's discipline.

install_luks_data_partition() {
  if [ "$(uname)" != "Linux" ]; then
    log_info "LUKS data partition: skipping (not Linux)"
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    log_warn "LUKS data partition: systemctl not found — skipping"
    return 0
  fi
  local host_src="$REPO_ROOT/scripts/host"
  if [ ! -f "$host_src/droplet-luks-provision.sh" ]; then
    log_warn "LUKS data partition: scripts/host/droplet-luks-provision.sh missing — skipping"
    return 0
  fi

  log_info "Installing LUKS2 data-partition provisioning (WARP-232)..."
  sudo install -m 0644 "$host_src/droplet-tpm-lib.sh" /usr/local/sbin/droplet-tpm-lib.sh
  sudo install -m 0755 "$host_src/droplet-luks-provision.sh" /usr/local/sbin/droplet-luks-provision.sh
  # Also install the USB enrollment + crypto-shred helpers when present.
  [ -f "$host_src/droplet-usb-enroll.sh" ] && \
    sudo install -m 0755 "$host_src/droplet-usb-enroll.sh" /usr/local/sbin/droplet-usb-enroll.sh
  [ -f "$host_src/droplet-crypto-shred.sh" ] && \
    sudo install -m 0755 "$host_src/droplet-crypto-shred.sh" /usr/local/sbin/droplet-crypto-shred.sh

  if [ ! -e /dev/tpm0 ] && [ "${DROPLET_LUKS_ALLOW_NO_TPM:-0}" != "1" ]; then
    log_warn "No /dev/tpm0 — the data partition will NOT be encrypted on this box."
    log_warn "  Encrypted-at-rest requires the Vault TPM hardware. Dev override:"
    log_warn "  DROPLET_LUKS_ALLOW_NO_TPM=1 ./scripts/setup.sh (data stays plain, dev-only)."
    return 0
  fi

  # Provision runs before Docker so a fresh appliance's daemon.json data-root
  # lands on /data before any image exists.
  if sudo DROPLET_REPO_ROOT="$REPO_ROOT" /usr/local/sbin/droplet-luks-provision.sh provision; then
    log_success "Encrypted data partition provisioned (LUKS2/Argon2id, TPM PCRs 0+2+4+7)"
  else
    log_warn "LUKS data-partition provisioning had issues (continuing) — see output above"
  fi
}

# relocate_secrets_to_data — move .env + data/secrets onto the encrypted /data
# and leave symlinks at the original paths. No-op unless /data is a real
# encrypted mount (backed by /dev/mapper/droplet-data-crypt). Idempotent.
relocate_secrets_to_data() {
  if [ "$(uname)" != "Linux" ]; then
    return 0
  fi
  local data_mount="${DROPLET_DATA_MOUNT:-/data}"
  local mapper="${DROPLET_LUKS_MAPPER:-droplet-data-crypt}"
  local src
  src="$(findmnt -n -o SOURCE "$data_mount" 2>/dev/null || true)"
  case "$src" in
    *"$mapper"*) : ;;  # /data is the encrypted mapper — proceed
    *)
      log_info "Secrets relocation: $data_mount is not the encrypted mapper — leaving secrets in place"
      return 0 ;;
  esac

  local droplet_dir="$data_mount/droplet"
  sudo mkdir -p "$droplet_dir/env" "$droplet_dir/secrets"
  sudo chmod 700 "$droplet_dir" "$droplet_dir/env" "$droplet_dir/secrets" 2>/dev/null || true

  _relocate_one "$REPO_ROOT/.env" "$droplet_dir/env/.env"
  _relocate_one "$REPO_ROOT/data/secrets" "$droplet_dir/secrets"
  log_success "Relocated .env + data/secrets onto the encrypted $data_mount (symlinks left behind)"
}

# _relocate_one <src-path> <dest-path> — copy-verify-remove-symlink. Never a
# bare `mv` across filesystems without verification.
_relocate_one() {
  local src="$1" dest="$2"
  # Already a symlink → previously relocated; idempotent no-op.
  if [ -L "$src" ]; then
    return 0
  fi
  if [ ! -e "$src" ]; then
    return 0
  fi
  # Copy preserving perms/ownership, verify it landed, then remove + symlink.
  sudo cp -a "$src" "$dest"
  if [ ! -e "$dest" ]; then
    log_warn "Secrets relocation: copy of $src -> $dest failed; leaving original in place"
    return 0
  fi
  sudo rm -rf "$src"
  sudo ln -s "$dest" "$src"
}
