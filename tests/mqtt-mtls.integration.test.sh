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

# A present-but-stopped Docker Desktop leaves `docker info` blocking on the
# named pipe for minutes instead of failing fast (seen on Windows during the
# WARP-2154 QA pass) — probe under a timeout where one exists (GNU coreutils;
# absent on stock macOS, where a downed daemon already fails fast).
_docker_probe() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 10 docker info >/dev/null 2>&1
  else
    docker info >/dev/null 2>&1
  fi
}
if ! command -v docker >/dev/null 2>&1 || ! _docker_probe; then
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
# CLIENT containers read their keys via plain bind mounts under a non-root
# uid, so those need to be world-readable in this scratch tree. The BROKER
# key is DELIBERATELY left 0600 and owned by the test user — the exact
# post-relocation state that crash-looped a fresh install (WARP-2154). The
# broker staying up below is the regression proof that the staging wrapper
# repairs ownership in-container.
chmod 644 "$WORK"/data/secrets/service-tls/orchestrator/key.pem \
          "$WORK"/data/secrets/service-tls/file-indexer/key.pem

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
#
# WARP-2154: run the broker EXACTLY the way compose does — bundle + ACL on
# staging mounts (/certs-src, /acl-src), re-owned for the mosquitto uid by
# the wrapper before the stock entrypoint execs. This wrapper mirrors
# docker-compose.yml's broker command; every staging stanza of BOTH copies
# is pinned by tests/mosquitto-conf.test.sh, so they cannot drift apart
# silently.
docker run -d --name "$BROKER" --network "$NET" --network-alias broker \
  -v "$REPO_ROOT/docker/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
  -v "$REPO_ROOT/docker/mosquitto.acl:/acl-src/droplet.acl:ro" \
  -v "$WORK/data/secrets/service-tls/broker:/certs-src:ro" \
  eclipse-mosquitto:2 sh -c \
  'install -d -o mosquitto -g mosquitto -m 700 /mosquitto/config/tls && install -o mosquitto -g mosquitto -m 644 /certs-src/ca.pem /mosquitto/config/tls/ca.pem && install -o mosquitto -g mosquitto -m 644 /certs-src/cert.pem /mosquitto/config/tls/cert.pem && install -o mosquitto -g mosquitto -m 600 /certs-src/key.pem /mosquitto/config/tls/key.pem && install -o mosquitto -g mosquitto -m 640 /acl-src/droplet.acl /mosquitto/config/droplet.acl && exec /docker-entrypoint.sh mosquitto -c /mosquitto/config/mosquitto.conf' \
  >/dev/null
sleep 2
docker ps --format '{{.Names}}' | grep -q "$BROKER" || {
  docker logs "$BROKER" >&2 || true
  fail "scratch broker did not stay up despite a 0600 test-user-owned host key (WARP-2154 staging wrapper broken?)"
}

# WARP-2154: staged material must be mosquitto-owned with tight modes —
# key 0600, ACL 0640 (not world-readable → no mosquitto acl_file warning).
docker exec "$BROKER" stat -c '%u %a %n' \
  /mosquitto/config/tls/key.pem /mosquitto/config/droplet.acl > "$WORK/staged.txt"
grep -q '^1883 600 /mosquitto/config/tls/key.pem$' "$WORK/staged.txt" \
  || fail "staged key.pem not mosquitto-owned 0600: $(cat "$WORK/staged.txt")"
grep -q '^1883 640 /mosquitto/config/droplet.acl$' "$WORK/staged.txt" \
  || fail "staged droplet.acl not mosquitto-owned 0640: $(cat "$WORK/staged.txt")"

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
