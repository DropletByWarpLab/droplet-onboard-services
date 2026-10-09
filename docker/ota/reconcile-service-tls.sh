#!/usr/bin/env bash
# OTA ships docker/ only. Reuse the installed host issuer to add the four
# newly wired service identities before their containers are recreated.
# Preserve the device CA and every fresh leaf; never mint a replacement CA.
set -euo pipefail
REPO_ROOT="${1:?usage: reconcile-service-tls.sh REPO_ROOT}"
CA_DIR="$REPO_ROOT/data/secrets/internal-ca"

if [ ! -s "$CA_DIR/ca.pem" ] && [ ! -s "$CA_DIR/ca.key" ]; then
  tls_flag="${DROPLET_INTERNAL_TLS:-}"
  if [ -z "$tls_flag" ] && [ -f "$REPO_ROOT/.env" ]; then
    tls_flag=$(awk '/^[[:space:]]*(export[[:space:]]+)?DROPLET_INTERNAL_TLS[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, ""); sub(/[[:space:]]*#.*/, ""); gsub(/[[:space:]\r\047\042]/, ""); flag=$0 } END { print flag }' "$REPO_ROOT/.env")
  fi
  if [ "${tls_flag:-0}" = 1 ]; then
    echo "service TLS reconciliation failed: mTLS is enabled but the device CA is missing" >&2
    exit 1
  fi
  echo "service TLS reconciliation: no installed CA; plaintext profile remains unchanged" >&2
  exit 0
fi
if [ ! -s "$CA_DIR/ca.pem" ] || [ ! -s "$CA_DIR/ca.key" ] || [ ! -r "$REPO_ROOT/scripts/lib/internal-ca.sh" ]; then
  echo "service TLS reconciliation failed: incomplete CA or installed issuer" >&2
  exit 1
fi

log_info() { echo "[service-tls] $*" >&2; }
log_warn() { echo "[service-tls] WARN: $*" >&2; }
log_success() { echo "[service-tls] $*" >&2; }
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/internal-ca.sh"
missing=()
for service in media-gen doc-render web-fetch sandbox; do
  # Older issuers treat a fresh cert as complete even if its private key was
  # lost. Repair that partial bundle before any container is swapped.
  if [ ! -s "$SERVICE_TLS_DIR/$service/key.pem" ]; then
    INTERNAL_CA_FORCE=1 internal_ca_issue "$service"
  else
    internal_ca_issue "$service"
  fi
  case " ${INTERNAL_CA_SERVICES[*]} " in
    *" $service "*) ;;
    *) missing+=("$service") ;;
  esac
done

# The installed daily renewal timer sources this host library, which OTA's
# docker-only archive does not replace. Persist just its missing identities
# so these new leaf certificates also renew after the first upgrade.
if [ "${#missing[@]}" -gt 0 ]; then
  issuer="$REPO_ROOT/scripts/lib/internal-ca.sh"
  staged=$(mktemp "${issuer}.service-tls.XXXXXX")
  trap 'rm -f "$staged"' EXIT
  cp -p "$issuer" "$staged"
  {
    printf '\n# Service identities installed by OTA for daily certificate renewal.\nINTERNAL_CA_SERVICES+=('
    printf ' %s' "${missing[@]}"
    printf ' )\n'
  } >> "$staged"
  mv -f "$staged" "$issuer"
  trap - EXIT
  log_success "Added daily renewal identities: ${missing[*]}"
fi
