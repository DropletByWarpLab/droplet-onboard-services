#!/usr/bin/env bash
# scripts/provision-device-identity.sh — WARP-230 first-boot enrollment.
#
# Idempotent: detects /var/lib/droplet/tpm/provisioned.json + exits 0
# if already provisioned. Otherwise prepares the storage directory and
# lets the device-identity-svc sidecar auto-provision on its first
# startup (the Compose service runs with DROPLET_AUTO_PROVISION=1).
#
# Backend selection:
#   DROPLET_TPM_BACKEND=mock (default)  → pure-Python in-memory
#   DROPLET_TPM_BACKEND=real            → tpm2-pytss + /dev/tpm0; currently an
#       UNFINISHED scaffold (IDX-002) that device-identity-svc fails closed on
#       unless DROPLET_TPM_ALLOW_SCAFFOLD is set, so it is never auto-selected.
#
# When DROPLET_TPM_BACKEND=mock + no storage dir exists, this script
# exits 0 cleanly so dev workflows aren't blocked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT  # logging.sh references this for the log file

# shellcheck source=lib/logging.sh
source "$SCRIPT_DIR/lib/logging.sh"
# shellcheck source=lib/device-identity.sh
source "$SCRIPT_DIR/lib/device-identity.sh"

main() {
  local backend="${DROPLET_TPM_BACKEND:-mock}"
  local storage
  storage=$(di_storage_path)
  log_info "Device-identity provisioning (backend=${backend}, storage=${storage})"

  # Dev/CI fast-path: mock backend + no storage dir means nothing to
  # provision yet. The sidecar will provision on first start once
  # docker-compose creates the bind-mount target.
  if [[ "$backend" == "mock" && ! -d "$storage" ]]; then
    log_info "Mock backend + no storage dir present — nothing to provision yet."
    log_info "Sidecar will auto-provision on first start (DROPLET_AUTO_PROVISION=1)."
    return 0
  fi

  if di_is_provisioned "$storage"; then
    log_info "Already provisioned (provisioned.json present at ${storage}) — skipping."
    return 0
  fi

  # Real backend with no /dev/tpm0 (e.g. Mac dev not running mock) —
  # warn but don't fail. The setup.sh wrapper continues; the sidecar
  # itself will surface a structured error on first start.
  if [[ "$backend" == "real" && ! -e /dev/tpm0 ]]; then
    log_warn "DROPLET_TPM_BACKEND=real but /dev/tpm0 missing — sidecar will fail to start."
    log_warn "Set DROPLET_TPM_BACKEND=mock in .env for dev hosts without a TPM."
    return 0
  fi

  # Ensure the storage dir exists so the bind-mount has a target on
  # first compose up. The sidecar's own provisioning happens inside
  # the container — we just guarantee the host directory exists with
  # the right ownership.
  mkdir -p "$storage"
  log_info "Storage dir ready at ${storage}; sidecar will auto-provision on first start."
  return 0
}

main "$@"
