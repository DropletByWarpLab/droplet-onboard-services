#!/usr/bin/env bash
# =============================================================================
# WARP-3653 -- renew internal CA leaf certificates before the 90-day expiry.
# =============================================================================
#
# Run daily by droplet-internal-cert-renew.timer (a host systemd timer: the CA
# key is never mounted into a container, so the orchestrator cannot do this).
# No loop: one pass per activation.
#
#   1. nothing to do when no internal CA exists on the box;
#   2. a bundle is DUE when its cert is missing or has less than a third of its
#      lifetime left (INTERNAL_CERT_RENEW_WINDOW_S, 30 of 90 days);
#   3. due bundles are re-issued in place by internal_ca_issue_all (no restart
#      yet), each marked .restart-pending;
#   4. only the marked compose services that are RUNNING are restarted, one at a
#      time. None of them can hot-reload: db/cache/broker stage their bundle at
#      container start, and the Node and Python services read keys once at
#      process start. A marker is cleared only after a successful restart, so a
#      failed restart is retried on the next run instead of being forgotten
#      (the cert files are already fresh by then, so "nothing is due" would
#      otherwise hide it).
#
# DROPLET_INTERNAL_TLS (the service-mesh mTLS flag, default 0) only decides
# whether the host-side client identities' units are restarted; the bundles
# themselves are always renewed because db, cache and broker TLS are NOT keyed
# on that flag (docs/security/internal-mtls.md, "Documented exemptions").
#
# Test seams: REPO_ROOT_OVERRIDE (data-tree root), RENEW_NO_RESTART=1.
# =============================================================================
set -euo pipefail
SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="${REPO_ROOT_OVERRIDE:-$SCRIPT_ROOT}"
log_info()    { echo "[renew-internal-certs] $*"; }
log_warn()    { echo "[renew-internal-certs] WARN: $*" >&2; }
log_success() { echo "[renew-internal-certs] OK: $*"; }
# shellcheck disable=SC1091
. "$SCRIPT_ROOT/scripts/lib/internal-ca.sh"

if [ ! -s "$INTERNAL_CA_DIR/ca.pem" ] || [ ! -s "$INTERNAL_CA_DIR/ca.key" ]; then
  log_info "no internal CA on this box (setup has not minted one); nothing to renew"
  exit 0
fi

tls_flag="${DROPLET_INTERNAL_TLS:-}"
if [ -z "$tls_flag" ] && [ -f "$REPO_ROOT/.env" ]; then
  tls_flag="$( { grep -E '^DROPLET_INTERNAL_TLS=' "$REPO_ROOT/.env" || true; } | tail -n 1 | cut -d= -f2- | tr -d "\"'" )"
fi
tls_flag="${tls_flag:-0}"
log_info "service-mesh mTLS (DROPLET_INTERNAL_TLS) is $tls_flag"

pending_marker() { echo "$SERVICE_TLS_DIR/$1/.restart-pending"; }

due=()
for svc in "${INTERNAL_CA_SERVICES[@]}"; do
  cert="$SERVICE_TLS_DIR/$svc/cert.pem"
  if [ ! -s "$cert" ] || ! "$OPENSSL" x509 -in "$cert" -noout -checkend "$INTERNAL_CERT_RENEW_WINDOW_S" >/dev/null 2>&1; then
    due+=("$svc")
  fi
done

if [ "${#due[@]}" -gt 0 ]; then
  log_info "renewing ${#due[@]} bundle(s) inside the renewal window: ${due[*]}"
  internal_ca_issue_all "${DROPLET_BRIDGE_GATEWAY_IP:-}"
  for svc in "${due[@]}"; do
    if ! "$OPENSSL" x509 -in "$SERVICE_TLS_DIR/$svc/cert.pem" -noout -checkend "$INTERNAL_CERT_RENEW_WINDOW_S" >/dev/null 2>&1; then
      log_warn "$svc is still inside the renewal window after issuing"
      exit 1
    fi
    : > "$(pending_marker "$svc")"
  done
fi

pending=()
for svc in "${INTERNAL_CA_SERVICES[@]}"; do
  [ -e "$(pending_marker "$svc")" ] && pending+=("$svc")
done
if [ "${#pending[@]}" -eq 0 ]; then
  log_info "every bundle has more than $((INTERNAL_CERT_RENEW_WINDOW_S / 86400)) days left; nothing to do"
  exit 0
fi

if [ "${RENEW_NO_RESTART:-0}" = "1" ]; then
  log_info "RENEW_NO_RESTART=1: certificates renewed, restart left to the operator for: ${pending[*]}"
  exit 0
fi

rc=0
if command -v docker >/dev/null 2>&1; then
  compose=(docker compose --env-file "$REPO_ROOT/.env" -f "$REPO_ROOT/docker/docker-compose.yml")
  running="$("${compose[@]}" ps --services --status running 2>/dev/null)" || running=""
  for svc in "${pending[@]}"; do
    if printf '%s\n' "$running" | grep -qx "$svc"; then
      log_info "restarting $svc to load its renewed certificate"
      if "${compose[@]}" restart "$svc" >/dev/null; then
        rm -f "$(pending_marker "$svc")"
      else
        log_warn "restart of $svc failed; it will be retried on the next run"
        rc=1
      fi
    elif printf '%s\n' "$running" | grep -q .; then
      # Stack is up and this identity is not one of its running services (a host
      # identity, or a profile that is off): it reads the new files when it next
      # starts. Host units that present a client cert are handled below.
      rm -f "$(pending_marker "$svc")"
    else
      log_warn "no running compose services found; $svc keeps its pending restart"
      rc=1
    fi
  done
else
  log_warn "docker not found; certificates renewed, restart pending for: ${pending[*]}"
  rc=1
fi

# Host-side client identities only present their bundle when the mesh flag is on.
if [ "$tls_flag" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  for pair in egress-audit:droplet-egress-audit.service device-bridge:droplet-device-bridge.service; do
    svc="${pair%%:*}"; unit="${pair#*:}"
    if [ -e "$(pending_marker "$svc")" ]; then
      if systemctl try-restart "$unit"; then rm -f "$(pending_marker "$svc")"
      else log_warn "restart of $unit failed; will retry"; rc=1; fi
    fi
  done
fi

[ "$rc" -eq 0 ] && log_success "internal certificates renewed and loaded" || log_warn "renewed, but some restarts are still pending"
exit "$rc"
