#!/usr/bin/env bash
# =============================================================================
# WARP-254 — shared helpers for the restic backup family
# (droplet-backup.sh / droplet-restore.sh / droplet-restore-drill.sh)
#
# Source this file; do not execute directly. It is installed to
# /usr/local/sbin/droplet-backup-lib.sh alongside the three scripts by
# scripts/lib/backup.sh::install_restic_backup so the sourcing works both from
# a repo checkout and from the installed location.
#
# ── Repository password derivation (STABILITY CONTRACT) ─────────────────────
# The restic repository password is DERIVED from the device identity secret
# DEVICE_SECRET_KEY (the per-device master key setup.sh mints into .env) via
# HKDF-SHA256 (RFC 5869), single-block expand (L=32):
#
#   PRK = HMAC-SHA256(salt = "droplet-restic-v1",                 IKM = DEVICE_SECRET_KEY)
#   OKM = HMAC-SHA256(PRK,   "droplet-restic-repository-password" || 0x01)
#   password = lowercase-hex(OKM)   (64 chars)
#
# DO NOT change the salt, info string, or construction — every restic repo on
# every shipped box is keyed by this exact derivation; drift makes existing
# repos permanently unreadable. tests/restic-backup.test.sh pins it with an
# independent python3 known-answer test.
#
# Deriving (instead of reusing DEVICE_SECRET_KEY directly) keeps the master
# key out of restic's key-derivation surface entirely: what restic sees is a
# one-way image of the master key, rotatable independently in a future
# versioned derivation ("droplet-restic-v2") without touching the master key.
#
# The derived password is never written to a tracked file. It is materialized
# per-invocation into $DROPLET_BACKUP_RUNTIME_DIR (default /run/droplet — a
# root-only tmpfs path that never survives a reboot) at mode 0600 and handed
# to restic via RESTIC_PASSWORD_FILE.
# =============================================================================

# --- Logging (match device-backup.sh convention: repo lib when present) -----
if ! declare -F log_info >/dev/null 2>&1; then
  log_info()    { printf "  [droplet-backup] %s\n" "$*"; }
  log_success() { printf "  [droplet-backup] OK: %s\n" "$*"; }
  log_warn()    { printf "  [droplet-backup] WARN: %s\n" "$*" >&2; }
  log_error()   { printf "  [droplet-backup] ERROR: %s\n" "$*" >&2; }
fi

# =============================================================================
# droplet_backup_resolve_repo_root — echoes the droplet-onboard-services
# checkout root. Precedence:
#   1. $DROPLET_REPO_ROOT      (the systemd units set this via @REPO_ROOT@
#                               substitution at install time)
#   2. script-relative          (running from a checkout: <root>/scripts/host/)
# Fails loudly otherwise — no magic host-specific default paths.
# =============================================================================
droplet_backup_resolve_repo_root() {
  if [ -n "${DROPLET_REPO_ROOT:-}" ]; then
    printf '%s' "$DROPLET_REPO_ROOT"
    return 0
  fi
  # BASH_SOURCE[0] here is the lib; the sourcing script sits next to it. When
  # both live in scripts/host/ the checkout root is two levels up.
  local lib_dir candidate
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  candidate="$(cd "$lib_dir/../.." 2>/dev/null && pwd || true)"
  if [ -n "$candidate" ] && [ -f "$candidate/docker/docker-compose.yml" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  log_error "cannot resolve the droplet-onboard-services checkout root."
  log_error "Set DROPLET_REPO_ROOT=/path/to/droplet-onboard-services (the systemd units do this automatically)."
  return 2
}

# =============================================================================
# droplet_backup_dotenv_value KEY — echoes KEY's value from <repo-root>/.env
# (empty when the file or key is missing). Lets operators configure the
# backup knobs in .env; a same-named environment variable always wins at the
# call sites (the systemd units only set DROPLET_REPO_ROOT).
# =============================================================================
droplet_backup_dotenv_value() {
  local key="$1" root env_file
  root="$(droplet_backup_resolve_repo_root 2>/dev/null)" || return 0
  env_file="$root/.env"
  [ -f "$env_file" ] || return 0
  # `|| true` keeps a missing key from tripping set -euo pipefail callers.
  { grep -E "^${key}=" "$env_file" 2>/dev/null || true; } | head -n 1 | cut -d= -f2-
}

# hex-encode a string's bytes (portable: od is in coreutils + busybox).
_droplet_backup_str_to_hex() {
  printf '%s' "$1" | od -An -v -t x1 | tr -d ' \n'
}

# HMAC-SHA256 over stdin with a hex key; hex digest on stdout. Uses flags
# compatible with OpenSSL 1.1/3.0 (no 3.2-only options — CI runners ship 3.0).
_droplet_backup_hmac_sha256_hex() {
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:$1" | awk '{print $NF}'
}

# =============================================================================
# droplet_backup_derive_password — derived restic password on stdout.
# IKM precedence: $DEVICE_SECRET_KEY env, else DEVICE_SECRET_KEY= from
# <repo-root>/.env. Refuses an empty key.
# =============================================================================
droplet_backup_derive_password() {
  local ikm="${DEVICE_SECRET_KEY:-}"
  if [ -z "$ikm" ]; then
    local root env_file
    root="$(droplet_backup_resolve_repo_root)" || return 2
    env_file="$root/.env"
    if [ -f "$env_file" ]; then
      # `|| true` keeps a missing key from tripping set -euo pipefail callers
      # (grep exits 1 on no match) — the empty-check below is the real gate.
      ikm="$( { grep -E '^DEVICE_SECRET_KEY=' "$env_file" 2>/dev/null || true; } | head -n 1 | cut -d= -f2-)"
    fi
  fi
  if [ -z "$ikm" ]; then
    log_error "DEVICE_SECRET_KEY is empty — cannot derive the restic repository password."
    log_error "Run ./scripts/setup.sh first (it mints the device identity secrets into .env)."
    return 2
  fi

  # HKDF-SHA256, fixed salt + info (see the stability-contract header above).
  local salt_hex prk okm
  salt_hex="$(_droplet_backup_str_to_hex 'droplet-restic-v1')"
  prk="$(printf '%s' "$ikm" | _droplet_backup_hmac_sha256_hex "$salt_hex")"
  # \001 = the HKDF expand block counter (single block, L=32 <= hash length).
  okm="$(printf 'droplet-restic-repository-password\001' | _droplet_backup_hmac_sha256_hex "$prk")"
  if [ -z "$okm" ]; then
    log_error "HKDF derivation produced no output (openssl missing?)"
    return 2
  fi
  printf '%s' "$okm"
}

# =============================================================================
# droplet_backup_prepare_restic_env — derives the password, materializes it at
# a root-only runtime path, and exports:
#   RESTIC_REPOSITORY     from $DROPLET_BACKUP_TARGET (default
#                         /var/lib/droplet/restic-repo — local path on the
#                         data disk; off-device targets are future work)
#   RESTIC_PASSWORD_FILE  runtime password file (0600)
#   RESTIC_CACHE_DIR      under the state dir so the cache lives on the data
#                         disk, not /root/.cache
# =============================================================================
droplet_backup_prepare_restic_env() {
  local runtime_dir="${DROPLET_BACKUP_RUNTIME_DIR:-/run/droplet}"
  local state_dir="${DROPLET_BACKUP_STATE_DIR:-/var/lib/droplet/backup}"
  local pass target

  pass="$(droplet_backup_derive_password)" || return 2

  mkdir -p "$runtime_dir" "$state_dir"
  chmod 700 "$runtime_dir" 2>/dev/null || true
  chmod 700 "$state_dir" 2>/dev/null || true

  # Atomic 0600 write: create with restrictive umask, then rename — the
  # password bytes are never readable by another user, even mid-write.
  local pass_file="$runtime_dir/restic.pass" tmp
  tmp="$pass_file.tmp.$$"
  ( umask 077 && printf '%s' "$pass" > "$tmp" )
  mv "$tmp" "$pass_file"

  # Target precedence: environment > .env (operator knob) > data-disk default.
  target="${DROPLET_BACKUP_TARGET:-}"
  [ -z "$target" ] && target="$(droplet_backup_dotenv_value DROPLET_BACKUP_TARGET)"
  export RESTIC_REPOSITORY="${target:-/var/lib/droplet/restic-repo}"
  export RESTIC_PASSWORD_FILE="$pass_file"
  export RESTIC_CACHE_DIR="$state_dir/cache"
}

# =============================================================================
# droplet_backup_ensure_repo — initializes the restic repository on first use.
# `restic cat config` distinguishes "repo absent" from "wrong password":
# an existing repo the derived password cannot open makes init fail loudly
# ("already initialized") instead of silently creating a second repo.
# =============================================================================
droplet_backup_ensure_repo() {
  if restic cat config >/dev/null 2>&1; then
    return 0
  fi
  log_info "Initializing restic repository at $RESTIC_REPOSITORY..."
  restic init
}
