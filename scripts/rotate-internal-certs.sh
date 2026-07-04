#!/usr/bin/env bash
# WARP-236 — reissue internal service certs; optional CA rebuild (emergency
# revocation) and rolling redeploy. See docs/security/internal-mtls.md.
set -euo pipefail
# SCRIPT_ROOT always points at the real repo (where scripts/lib lives); REPO_ROOT
# is the data-tree root and is overridable for tests (REPO_ROOT_OVERRIDE points
# at a scratch dir that holds only data/secrets, never scripts/).
SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="${REPO_ROOT_OVERRIDE:-$SCRIPT_ROOT}"
log_info()    { echo "[rotate] $*"; }
log_warn()    { echo "[rotate] WARN: $*" >&2; }
log_success() { echo "[rotate] OK: $*"; }
# shellcheck disable=SC1091
. "$SCRIPT_ROOT/scripts/lib/internal-ca.sh"

services=() all=0 rebuild=0 deploy=0 gateway_ip=""
while [ $# -gt 0 ]; do
  case "$1" in
    --service)    services+=("$2"); shift 2 ;;
    --all)        all=1; shift ;;
    --rebuild-ca) rebuild=1; all=1; shift ;;
    --deploy)     deploy=1; shift ;;
    --gateway-ip) gateway_ip="$2"; shift 2 ;;
    *) echo "usage: $0 [--service NAME]... [--all] [--rebuild-ca] [--deploy] [--gateway-ip IP]" >&2; exit 2 ;;
  esac
done
[ "$all" = 1 ] || [ "${#services[@]}" -gt 0 ] || { echo "nothing to do (use --all or --service)" >&2; exit 2; }

if [ "$rebuild" = 1 ]; then
  log_warn "EMERGENCY CA REBUILD — every service bundle will be reissued"
  rm -f "$INTERNAL_CA_DIR/ca.key" "$INTERNAL_CA_DIR/ca.pem" "$INTERNAL_CA_DIR/ca.srl"
  internal_ca_ensure
fi

if [ "$all" = 1 ]; then
  INTERNAL_CA_FORCE=1 internal_ca_issue_all "$gateway_ip"
  services=("${INTERNAL_CA_SERVICES[@]}")
else
  for svc in "${services[@]}"; do
    extra=""
    case " ${INTERNAL_CA_HOSTNET_SERVICES[*]} orchestrator " in
      *" $svc "*) extra="DNS:host.docker.internal${gateway_ip:+,IP:$gateway_ip}" ;;
    esac
    INTERNAL_CA_FORCE=1 internal_ca_issue "$svc" "$extra"
  done
fi

if [ "$deploy" = 1 ]; then
  log_info "Rolling restart of: ${services[*]}"
  docker compose -f "$REPO_ROOT/docker/docker-compose.yml" restart "${services[@]}" \
    || log_warn "compose restart failed — restart the services manually"
fi
log_success "Rotation complete"
