#!/usr/bin/env bash
# =============================================================================
# WARP-235 acceptance (docker-gated):
#   (1) a certless client cannot connect (TLS handshake refused);
#   (2) publishing to a topic outside the client's ACL grant is NOT delivered;
#   (3) allowed flows work end-to-end (file-indexer → orchestrator);
#   (4) removing a service's cert kills its next connection, and a cert minted
#       by a ROGUE CA is rejected (revocation = CA trust, not file presence).
#
# Spins a scratch eclipse-mosquitto:2 with the REAL tracked conf + ACL and
# certs minted by the REAL issuance lib (scripts/lib/internal-ca.sh). Needs
# Docker only; skips (exit 0) when no usable daemon is present so CI lanes
# without Docker stay green.
# =============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker unavailable — run on a machine with a Docker daemon"
  exit 0
fi

WORK="$(mktemp -d)"
NET="warp235-net-$$"
BROKER="warp235-broker-$$"
cleanup() {
  docker rm -f "$BROKER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

log_info() { :; }; log_warn() { :; }; log_success() { :; }
# shellcheck disable=SC1091
REPO_ROOT="$WORK" . "$REPO_ROOT/scripts/lib/internal-ca.sh"

internal_ca_ensure
for svc in broker orchestrator file-indexer; do internal_ca_issue "$svc"; done
# The scratch broker runs as uid 1883 and the client containers as another
# uid; host-side 0600 keys would be unreadable through the bind mounts.
chmod 644 "$WORK"/data/secrets/service-tls/*/key.pem

# A rogue CA minting a syntactically-valid "file-indexer" cert — must be
# rejected by the broker (trust = OUR CA, not any CA).
INTERNAL_CA_DIR="$WORK/rogue-ca"
SERVICE_TLS_DIR="$WORK/rogue-tls"
internal_ca_ensure
internal_ca_issue file-indexer
chmod 644 "$WORK"/rogue-tls/*/key.pem
INTERNAL_CA_DIR="$WORK/data/secrets/internal-ca"
SERVICE_TLS_DIR="$WORK/data/secrets/service-tls"

docker network create "$NET" >/dev/null
# --network-alias broker keeps the client-side hostname on the cert's SAN
# (DNS:broker) without colliding with a real compose stack's container name.
docker run -d --name "$BROKER" --network "$NET" --network-alias broker \
  -v "$REPO_ROOT/docker/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
  -v "$REPO_ROOT/docker/mosquitto.acl:/mosquitto/config/droplet.acl:ro" \
  -v "$WORK/data/secrets/service-tls/broker:/mosquitto/config/tls:ro" \
  eclipse-mosquitto:2 >/dev/null
sleep 2
docker ps --format '{{.Names}}' | grep -q "$BROKER" || {
  docker logs "$BROKER" >&2 || true
  fail "scratch broker did not stay up (config rejected?)"
}

MOSQ() {
  docker run --rm --network "$NET" \
    -v "$WORK/data/secrets/service-tls:/tls:ro" \
    -v "$WORK/rogue-tls:/rogue:ro" \
    --entrypoint "" eclipse-mosquitto:2 "$@"
}
FI="--cafile /tls/file-indexer/ca.pem --cert /tls/file-indexer/cert.pem --key /tls/file-indexer/key.pem -h broker -p 8883"
ORCH="--cafile /tls/orchestrator/ca.pem --cert /tls/orchestrator/cert.pem --key /tls/orchestrator/key.pem -h broker -p 8883"

# (1) certless connection is refused at the handshake
MOSQ mosquitto_pub --cafile /tls/file-indexer/ca.pem -h broker -p 8883 \
  -t droplet/x -m nope >/dev/null 2>&1 && fail "certless publish accepted"

# (3) allowed flow: file-indexer → droplet/index/u1/indexed reaches an
#     orchestrator subscriber
out="$(MOSQ sh -c "mosquitto_sub $ORCH -t 'droplet/index/+/indexed' -C 1 -W 6 & sleep 1; \
  mosquitto_pub $FI -t droplet/index/u1/indexed -m '{\"ok\":1}'; wait" || true)"
echo "$out" | grep -q '"ok":1' || fail "allowed publish not delivered: $out"

# (2) forbidden topic: file-indexer publishing droplet/notifications/u1 must
#     NOT be delivered (ACL drops it server-side; QoS-0 pub exits 0 regardless)
out="$(MOSQ sh -c "mosquitto_sub $ORCH -t 'droplet/notifications/#' -C 1 -W 4 & sleep 1; \
  mosquitto_pub $FI -t droplet/notifications/u1 -m stolen; wait" || true)"
echo "$out" | grep -q 'stolen' && fail "ACL leak: forbidden publish delivered"

# (4a) a cert signed by a rogue CA (same CN) is rejected at the handshake
MOSQ mosquitto_pub --cafile /tls/file-indexer/ca.pem \
  --cert /rogue/file-indexer/cert.pem --key /rogue/file-indexer/key.pem \
  -h broker -p 8883 -t droplet/index/u1/indexed -m forged >/dev/null 2>&1 \
  && fail "rogue-CA client cert accepted"

# (4b) removing a service's cert kills its next connection
rm "$WORK/data/secrets/service-tls/file-indexer/cert.pem"
MOSQ mosquitto_pub $FI -t droplet/index/u1/indexed -m again >/dev/null 2>&1 \
  && fail "removed-cert client still connects"

echo "PASS tests/mqtt-mtls.integration.test.sh"
