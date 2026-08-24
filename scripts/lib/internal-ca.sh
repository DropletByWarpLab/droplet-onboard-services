# shellcheck shell=bash
# =============================================================================
# WARP-236 — compose-network-scoped internal CA + per-service TLS bundles.
#
# Sourced by scripts/lib/secrets.sh (materialize_artifacts) and by
# scripts/rotate-internal-certs.sh. Pure openssl — runs on macOS (LibreSSL)
# and Linux, no Docker required (unlike the retired mosquitto_passwd path).
#
# Layout (all gitignored):
#   data/secrets/internal-ca/ca.key            0600, NEVER mounted anywhere
#   data/secrets/internal-ca/ca.pem            CA cert, 10 years
#   data/secrets/service-tls/<svc>/cert.pem    90 days, EKU serverAuth+clientAuth
#   data/secrets/service-tls/<svc>/key.pem     0600, install-user-owned — always
#   data/secrets/service-tls/<svc>/ca.pem      copy of CA cert (single-mount bundles)
# =============================================================================

# openssl binary. The Linux appliance ships OpenSSL 3; the default macOS
# /usr/bin/openssl is LibreSSL, whose `x509 -ext` (used only by the unit tests
# for inspection) is missing. Prefer a real OpenSSL 3 when present so the same
# scripts run on a dev Mac and on the box; issuance itself works on either.
# Override with INTERNAL_CA_OPENSSL=/path/to/openssl.
_internal_ca_pick_openssl() {
  if [ -n "${INTERNAL_CA_OPENSSL:-}" ]; then
    printf '%s' "$INTERNAL_CA_OPENSSL"; return
  fi
  local c
  for c in /opt/homebrew/opt/openssl@3/bin/openssl \
           /usr/local/opt/openssl@3/bin/openssl \
           openssl; do
    if command -v "$c" >/dev/null 2>&1; then printf '%s' "$c"; return; fi
  done
  printf 'openssl'
}
OPENSSL="${OPENSSL:-$(_internal_ca_pick_openssl)}"

INTERNAL_CA_DIR="${INTERNAL_CA_DIR:-$REPO_ROOT/data/secrets/internal-ca}"
SERVICE_TLS_DIR="${SERVICE_TLS_DIR:-$REPO_ROOT/data/secrets/service-tls}"
INTERNAL_CA_DAYS="${INTERNAL_CA_DAYS:-3650}"
INTERNAL_CERT_DAYS="${INTERNAL_CERT_DAYS:-90}"
# Renew when less than 30 days of validity remain (2592000 s).
INTERNAL_CERT_RENEW_WINDOW_S=2592000

# Canonical identity list. CN == compose service name. The Postgres/Redis
# workstream appends its services here (db, cache) — nothing else to change.
INTERNAL_CA_SERVICES=(
  orchestrator gateway ai-gateway mcp-server voice-io email-indexer rag-eval
  ops-console file-indexer routing switch oled-display matter-controller
  camera-discovery broker frigate
  # WARP-234: Redis server TLS — the compose `cache` service stages this
  # bundle as its server cert (docker-compose.yml cache.command); nextcloud
  # mounts its bundle for the phpredis CA pin (zz-redis-tls.config.php).
  cache nextcloud
  # WARP-233: Postgres server TLS — the compose `db` service stages this
  # bundle as its server cert (docker-compose.yml db.command).
  db
  # WARP-1061: host-side (non-compose) client identities. These never serve;
  # they present client certs to the orchestrator/routing listeners when
  # DROPLET_INTERNAL_TLS=1. Paths are read straight from the repo's
  # data/secrets/service-tls/<name>/ by the host units/scripts:
  #   egress-audit  → droplet-egress-audit.service (services/egress-audit)
  #   device-bridge → droplet-device-bridge.service (services/oled-display/
  #                   device-bridge.py) + droplet-shutdown-screen.sh
  #   host-admin    → operator CLIs (scripts/lib/device-identity.sh,
  #                   scripts/verify.sh)
  egress-audit device-bridge host-admin
)
# Host-network services are dialled as host.docker.internal (multi-box/dev)
# or the droplet_default bridge-gateway IP (single-box) — extra SANs.
# WARP-1061: camera-discovery joins — it is host-network too and its mesh
# callers (orchestrator cameras.ts, mcp-server) dial it via
# host.docker.internal:8085, so its server cert needs that SAN.
INTERNAL_CA_HOSTNET_SERVICES=(routing switch oled-display matter-controller camera-discovery)

internal_ca_ensure() {
  mkdir -p "$INTERNAL_CA_DIR"
  chmod 700 "$REPO_ROOT/data/secrets" "$INTERNAL_CA_DIR" 2>/dev/null || true
  local key="$INTERNAL_CA_DIR/ca.key" crt="$INTERNAL_CA_DIR/ca.pem"
  if [ -s "$key" ] && [ -s "$crt" ]; then
    return 0
  fi
  log_info "Minting internal CA (WARP-236)..."
  "$OPENSSL" ecparam -name prime256v1 -genkey -noout -out "$key.tmp"
  chmod 600 "$key.tmp" && mv "$key.tmp" "$key"
  "$OPENSSL" req -x509 -new -key "$key" -sha256 -days "$INTERNAL_CA_DAYS" \
    -subj "/O=Droplet/CN=droplet-internal-ca" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$crt.tmp" && mv "$crt.tmp" "$crt"
  log_success "Internal CA minted at $crt"
}

# internal_ca_issue <service> [extra_sans]
#   extra_sans: comma-separated additional SAN entries, e.g.
#   "DNS:host.docker.internal,IP:172.18.0.1"
internal_ca_issue() {
  local service="$1" extra_sans="${2:-}"
  internal_ca_ensure
  local dir="$SERVICE_TLS_DIR/$service"
  mkdir -p "$dir"
  local cert="$dir/cert.pem" key="$dir/key.pem"

  # Renew only when missing, expiring soon, or forced — keeps setup.sh
  # idempotent (same discipline as sync_audit_signing_key).
  if [ -s "$cert" ] && [ "${INTERNAL_CA_FORCE:-0}" != "1" ] \
     && "$OPENSSL" x509 -in "$cert" -noout -checkend "$INTERNAL_CERT_RENEW_WINDOW_S" >/dev/null 2>&1; then
    cp "$INTERNAL_CA_DIR/ca.pem" "$dir/ca.pem"   # keep bundle CA fresh post-rebuild
    return 0
  fi

  local san="DNS:$service,DNS:localhost,IP:127.0.0.1"
  [ -n "$extra_sans" ] && san="$san,$extra_sans"

  "$OPENSSL" ecparam -name prime256v1 -genkey -noout -out "$key.tmp"
  chmod 600 "$key.tmp"
  "$OPENSSL" req -new -key "$key.tmp" -subj "/O=Droplet/CN=$service" -out "$dir/csr.pem"
  "$OPENSSL" x509 -req -in "$dir/csr.pem" \
    -CA "$INTERNAL_CA_DIR/ca.pem" -CAkey "$INTERNAL_CA_DIR/ca.key" -CAcreateserial \
    -days "$INTERNAL_CERT_DAYS" -sha256 \
    -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth,clientAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' "$san") \
    -out "$cert.tmp"
  mv "$key.tmp" "$key" && mv "$cert.tmp" "$cert" && rm -f "$dir/csr.pem"
  chmod 644 "$cert"
  cp "$INTERNAL_CA_DIR/ca.pem" "$dir/ca.pem"

  # WARP-2154: NO per-service ownership fix-ups here — every key stays 0600,
  # install-user-owned. The broker (whose in-container mosquitto uid differs
  # from the install user) once got a `chown || sudo -n chown || chmod 644`
  # chain at this point, but relocate_secrets_to_data (scripts/lib/luks.sh)
  # re-owns the whole relocated secrets tree to the install user AFTER
  # issuance — the chown was silently undone and a fresh single-box install
  # crash-looped the broker — and the chmod 644 arm world-read the private
  # key whenever passwordless sudo was absent. Containers whose runtime uid
  # can't read a 0600 install-user file stage their bundle with in-container
  # ownership at start instead (docker-compose.yml broker/db/cache command
  # wrappers), which survives relocation, re-runs, and renewals alike.
  log_success "Issued internal cert for '$service' (${INTERNAL_CERT_DAYS}d, SAN: $san)"
}

# internal_ca_issue_all [gateway_ip]
internal_ca_issue_all() {
  local gateway_ip="${1:-}"
  local svc extra
  for svc in "${INTERNAL_CA_SERVICES[@]}"; do
    extra=""
    case " ${INTERNAL_CA_HOSTNET_SERVICES[*]} " in
      *" $svc "*)
        extra="DNS:host.docker.internal"
        [ -n "$gateway_ip" ] && extra="$extra,IP:$gateway_ip"
        ;;
    esac
    # orchestrator is also dialled from host-net callers in some shapes.
    [ "$svc" = "orchestrator" ] && extra="DNS:host.docker.internal${gateway_ip:+,IP:$gateway_ip}"
    internal_ca_issue "$svc" "$extra"
  done
}
