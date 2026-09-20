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
  #
  # WARP-232 (finding 6): forward DROPLET_LUKS_ALLOW_NO_TPM through the `sudo`
  # boundary. `sudo` scrubs the environment, so without listing the var here the
  # provision script never saw the dev override and its `--tpm2-device=auto`
  # enroll failed hard on a TPM-less box — the flag was inert end to end. We
  # forward the value the caller actually set (default 0), so the two sides
  # agree on whether to skip the TPM enroll. Also forward DROPLET_TPM_PCRS_BIND
  # so a non-default PCR set stays consistent across the sudo boundary, and
  # DROPLET_LUKS_UNLOCK_TIMEOUT (WARP-2100) so a tuned unlock bound isn't
  # silently scrubbed back to the default.
  if sudo DROPLET_REPO_ROOT="$REPO_ROOT" \
       DROPLET_LUKS_ALLOW_NO_TPM="${DROPLET_LUKS_ALLOW_NO_TPM:-0}" \
       DROPLET_TPM_PCRS_BIND="${DROPLET_TPM_PCRS_BIND:-0+2+4+7}" \
       DROPLET_LUKS_UNLOCK_TIMEOUT="${DROPLET_LUKS_UNLOCK_TIMEOUT:-30}" \
       /usr/local/sbin/droplet-luks-provision.sh provision; then
    log_success "Encrypted data partition provisioned (LUKS2/Argon2id, TPM PCRs 0+2+4+7)"
  else
    log_warn "LUKS data-partition provisioning had issues (continuing) — see output above"
  fi
}

# relocate_secrets_to_data — move .env + data/secrets onto the encrypted /data
# and leave symlinks at the original paths. No-op unless /data is a real
# encrypted mount (backed by /dev/mapper/droplet-data-crypt). Idempotent.
#
# Ownership/permissions contract (WARP-232 review — finding 2):
#   setup.sh runs NON-ROOT (preflight refuses root; the autoinstall first-boot
#   runs `setup.sh --single-box --systemd` as the `droplet` user). configure_
#   single_box_env / apply_fips_mode then `stat`/read the relocated .env AFTER
#   relocation — so the install user MUST be able to traverse the container
#   dirs and read the files, or `set -euo pipefail` aborts first boot. And the
#   compose stack reads `../.env` (env_file) + `../data/secrets` (bind) as the
#   docker-group (possibly non-sudo) user, so those must stay readable too.
#   We therefore own the /data/droplet tree by the INSTALL USER (dirs 0750 so
#   the owner can traverse; the copied files keep their original 0600/0640
#   modes via `cp -a`), rather than root:root 0700 which locked out both.
relocate_secrets_to_data() {
  # Linux-only in production. The hermetic harness sets
  # DROPLET_LUKS_SKIP_OS_GATE=1 so the stubbed drill can exercise the real
  # relocation on any OS (macOS CI/dev) — mirrors droplet-luks-provision.sh.
  if [ "${DROPLET_LUKS_SKIP_OS_GATE:-0}" != "1" ] && [ "$(uname)" != "Linux" ]; then
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

  # The user (and its primary group) that setup.sh runs as: it must own the
  # container dirs so the rest of Phase 4 + the docker-group stack can read
  # the relocated .env / secrets. DROPLET_RELOCATE_OWNER is a test seam.
  local owner="${DROPLET_RELOCATE_OWNER:-$(id -un):$(id -gn)}"

  local droplet_dir="$data_mount/droplet"
  sudo mkdir -p "$droplet_dir/env" "$droplet_dir/secrets"
  # Own by the install user, dirs 0750 (owner rwx, group rx, no other): the
  # install user + a shared group can traverse/read; the world cannot. `cp -a`
  # below preserves each file's own mode (0600 audit key, 0600 .env).
  sudo chown "$owner" "$droplet_dir" "$droplet_dir/env" "$droplet_dir/secrets" 2>/dev/null || true
  sudo chmod 0750 "$droplet_dir" "$droplet_dir/env" "$droplet_dir/secrets" 2>/dev/null || true

  _relocate_one "$REPO_ROOT/.env" "$droplet_dir/env/.env" "$owner"
  # NOTE the trailing slash on the SOURCE: `cp -a src/. dest` copies the
  # CONTENTS of data/secrets INTO the existing dest dir, so audit.key lands at
  # $droplet_dir/secrets/audit.key — NOT nested at secrets/secrets/audit.key
  # (finding 1: the pre-created dest dir made `cp -a src dest` nest one level).
  _relocate_one "$REPO_ROOT/data/secrets" "$droplet_dir/secrets" "$owner"

  # Verify the symlinks resolve to real, readable files before declaring
  # success — a broken audit.key symlink means the orchestrator restart-loops
  # (loadAuditKeyFromDisk throws), and a broken .env symlink means the stack
  # starts with NO secrets (compose env_file `required: false`).
  if [ -e "$REPO_ROOT/.env" ] && [ -e "$REPO_ROOT/data/secrets/audit.key" ]; then
    log_success "Relocated .env + data/secrets onto the encrypted $data_mount (symlinks resolve)"
  elif [ -L "$REPO_ROOT/.env" ] && [ ! -e "$REPO_ROOT/.env" ]; then
    log_warn "Secrets relocation: .env symlink does not resolve — check $droplet_dir/env/.env"
  else
    log_success "Relocated crypto-sensitive secrets onto the encrypted $data_mount"
  fi
}

# _relocate_one <src-path> <dest-path> [owner] — copy-verify-shred-symlink.
# Never a bare `mv` across filesystems without verification. For a DIRECTORY
# src the dest is expected to already exist and we copy the CONTENTS in (so we
# never nest src under dest/basename); for a FILE src we copy to the dest path.
_relocate_one() {
  local src="$1" dest="$2" owner="${3:-}"
  # Already a symlink → previously relocated; idempotent no-op.
  if [ -L "$src" ]; then
    return 0
  fi
  if [ ! -e "$src" ]; then
    return 0
  fi
  if [ -d "$src" ]; then
    # Copy the directory CONTENTS into the (pre-created) dest, preserving each
    # file's perms/ownership. `src/.` avoids the extra nesting level.
    sudo mkdir -p "$dest"
    sudo cp -a "$src/." "$dest/"
  else
    # File: copy preserving perms/ownership to the exact dest path.
    sudo cp -a "$src" "$dest"
  fi
  if [ ! -e "$dest" ]; then
    log_warn "Secrets relocation: copy of $src -> $dest failed; leaving original in place"
    return 0
  fi
  # Make the container dir + the copied payload owned by the install user so a
  # non-root reader (rest of setup.sh, docker-group stack) can reach it. Files
  # keep their own restrictive mode from `cp -a`.
  if [ -n "$owner" ]; then
    sudo chown -R "$owner" "$dest" 2>/dev/null || true
  fi
  # shred the plaintext original before removing it, so the DEVICE_SECRET_KEY /
  # audit-key blocks don't linger in root-fs free space for a disk-pull carve
  # (finding 8). shred can't reach already-freed blocks, so this is best-effort
  # residual-reduction, not a guarantee on a COW/journalled fs — see
  # docs/security/at-rest-encryption.md.
  if [ -d "$src" ]; then
    sudo find "$src" -type f -exec shred -u {} \; 2>/dev/null || true
    sudo rm -rf "$src"
  else
    sudo shred -u "$src" 2>/dev/null || sudo rm -f "$src"
  fi
  sudo ln -s "$dest" "$src"
}
