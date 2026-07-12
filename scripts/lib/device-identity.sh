#!/usr/bin/env bash
# scripts/lib/device-identity.sh — WARP-230 helpers.
# Shared between provision-device-identity.sh and droplet-admin device-identity.
# Source this file; do not execute directly.

DI_DEFAULT_STORAGE="/var/lib/droplet/tpm"
DI_DEFAULT_SOCKET="/var/run/droplet/device-identity.sock"

di_storage_path() {
  echo "${TPM_STORAGE:-${DROPLET_DI_STORAGE:-$DI_DEFAULT_STORAGE}}"
}

di_socket_path() {
  echo "${DROPLET_DI_SOCKET:-$DI_DEFAULT_SOCKET}"
}

di_is_provisioned() {
  local storage="$1"
  [[ -f "${storage}/provisioned.json" ]]
}

di_status_via_grpcurl() {
  # Direct sidecar probe (no orchestrator dependency). Useful when the
  # orchestrator is itself in a degraded state and the operator needs to
  # check provisioning state.
  local sock
  sock=$(di_socket_path)
  if ! command -v grpcurl >/dev/null 2>&1; then
    echo "{\"error\":\"grpcurl_not_installed\"}" >&2
    return 1
  fi
  grpcurl -plaintext -unix "$sock" \
    droplet.device_identity.DeviceIdentityService/GetStatus
}

# CLI helpers — used by scripts/droplet-admin device-identity {status,reseal}.

# WARP-1061 — internal mTLS for the orchestrator API calls below. When the
# repo .env (or the environment) carries DROPLET_INTERNAL_TLS=1, the
# orchestrator's :3000 listener is HTTPS and REQUIRES a CA-signed client
# cert, so the curls present the host-issued `host-admin` bundle and dial
# https://. Flag off/absent keeps the plain-HTTP curls byte-identical.
# Prints the extra curl args; the caller rewrites the scheme via
# di_api_base_url. Env overrides mirror the standard DROPLET_TLS_* contract.
_di_internal_tls_enabled() {
  local flag="${DROPLET_INTERNAL_TLS:-}"
  if [[ -z "$flag" && -n "${REPO_ROOT:-}" && -f "$REPO_ROOT/.env" ]]; then
    flag=$(grep -E '^DROPLET_INTERNAL_TLS=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- || true)
  fi
  [[ "$flag" == "1" ]]
}

di_curl_tls_args() {
  _di_internal_tls_enabled || return 0
  local bundle="${REPO_ROOT:-.}/data/secrets/service-tls/host-admin"
  printf -- '--cacert %s --cert %s --key %s' \
    "${DROPLET_TLS_CA:-$bundle/ca.pem}" \
    "${DROPLET_TLS_CERT:-$bundle/cert.pem}" \
    "${DROPLET_TLS_KEY:-$bundle/key.pem}"
}

di_api_base_url() {
  local url="${DROPLET_API_URL:-http://localhost:3000}"
  if _di_internal_tls_enabled; then
    url="${url/#http:\/\//https://}"
  fi
  printf '%s' "$url"
}

di_cli_dispatch() {
  local sub="${1:-help}"
  shift || true
  case "$sub" in
    status)  di_cli_status "$@" ;;
    reseal)  di_cli_reseal "$@" ;;
    help|--help|-h|"")
      cat <<EOF
Usage: droplet-admin device-identity <subcommand>

Subcommands:
  status     Print device identity status (provisioning state, seal validity,
             PCR snapshot). Requires DROPLET_ADMIN_TOKEN.
  reseal     Re-bind the sealed identity to current PCRs. Requires admin role
             AND a recent MFA re-auth (within 60s). The CLI hits the same
             orchestrator route as the dashboard — same RBAC, same gating.

Environment:
  DROPLET_API_URL        Default: http://localhost:3000
  DROPLET_ADMIN_TOKEN    Bearer token for the admin user (capture from dashboard)
EOF
      ;;
    *)
      echo "Unknown subcommand: $sub" >&2
      echo "Usage: droplet-admin device-identity {status|reseal|help}" >&2
      return 64
      ;;
  esac
}

di_cli_status() {
  local api_url token tls_args
  api_url="$(di_api_base_url)"
  token="${DROPLET_ADMIN_TOKEN:-}"
  tls_args="$(di_curl_tls_args)"
  if [[ -z "$token" ]]; then
    echo "DROPLET_ADMIN_TOKEN not set — capture an admin token via the dashboard first." >&2
    return 2
  fi
  # shellcheck disable=SC2086  # tls_args is a deliberate word-split arg list
  curl -sf $tls_args -H "Authorization: Bearer $token" \
    "$api_url/api/admin/device-identity/status" \
    | { command -v jq >/dev/null && jq . || cat; }
}

di_cli_reseal() {
  local api_url token tls_args
  api_url="$(di_api_base_url)"
  token="${DROPLET_ADMIN_TOKEN:-}"
  tls_args="$(di_curl_tls_args)"
  if [[ -z "$token" ]]; then
    echo "DROPLET_ADMIN_TOKEN not set — capture an admin token via the dashboard first." >&2
    return 2
  fi
  echo "Reseal requires recent MFA re-auth (within 60s)."
  echo "Open the dashboard, complete the MFA challenge, then re-run this command."
  # shellcheck disable=SC2086  # tls_args is a deliberate word-split arg list
  curl -sf $tls_args -X POST -H "Authorization: Bearer $token" \
    "$api_url/api/admin/device-identity/reseal" \
    | { command -v jq >/dev/null && jq . || cat; }
}
