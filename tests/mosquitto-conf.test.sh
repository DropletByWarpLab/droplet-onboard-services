#!/usr/bin/env bash
# WARP-235 — mosquitto TLS config + ACL guards, and generator/tracked-file parity.
#
# Pins:
#   1. docker/mosquitto.conf is a single mTLS listener (:8883, require_certificate,
#      use_identity_as_username) with the per-CN ACL file — no password file, no
#      plaintext 1883 listener.
#   2. The secrets.sh generators (_write_mosquitto_conf/_write_mosquitto_acl)
#      emit byte-identical copies of the tracked files, so the box's checkout
#      never drifts.
#   3. The ACL grants match the real per-service topic map on main
#      (least-privilege spot checks).
#   4. Compose mounts the ACL + broker TLS bundle on STAGING paths and the
#      broker command re-owns them for the mosquitto uid before exec'ing the
#      stock entrypoint (WARP-2154); ONLY the loopback :8883 is published
#      (host-net camera-discovery); the passwd mount is gone.
#   5. The shared-password machinery is fully retired from secrets.sh/compose.sh,
#      and the issuance lib carries no broker ownership fix-ups (WARP-2154:
#      relocation undid them; the 644 fallback world-read the key).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
CONF="$REPO_ROOT/docker/mosquitto.conf"
ACL="$REPO_ROOT/docker/mosquitto.acl"
C="$REPO_ROOT/docker/docker-compose.yml"

# 1. conf: mTLS listener, identity mapping, no password file, no plaintext listener
grep -q '^listener 8883$' "$CONF"                 || fail "listener 8883"
grep -q '^cafile /mosquitto/config/tls/ca.pem$' "$CONF"      || fail "cafile"
grep -q '^certfile /mosquitto/config/tls/cert.pem$' "$CONF"  || fail "certfile"
grep -q '^keyfile /mosquitto/config/tls/key.pem$' "$CONF"    || fail "keyfile"
grep -q '^require_certificate true$' "$CONF"      || fail "require_certificate"
grep -q '^use_identity_as_username true$' "$CONF" || fail "use_identity_as_username"
grep -q '^acl_file /mosquitto/config/droplet.acl$' "$CONF"   || fail "acl_file"
grep -q '^allow_anonymous false$' "$CONF"         || fail "allow_anonymous"
grep -q 'password_file' "$CONF" && fail "password_file still present"
grep -q '^listener 1883$' "$CONF" && fail "plaintext listener still present"

# 2. generator output is byte-identical to the tracked files (no drift on the box)
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
log_info() { :; }; log_warn() { :; }; log_success() { :; }; log_error() { :; }
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/secrets.sh"
mkdir -p "$WORK/docker"
REPO_ROOT="$WORK" _write_mosquitto_conf
cmp -s "$WORK/docker/mosquitto.conf" "$CONF" || fail "generator drifted from tracked mosquitto.conf"
REPO_ROOT="$WORK" _write_mosquitto_acl
cmp -s "$WORK/docker/mosquitto.acl" "$ACL"   || fail "generator drifted from tracked mosquitto.acl"

# 3. ACL: per-CN grants match the topic map on main (spot checks)
grep -q '^user file-indexer$' "$ACL" || fail "acl: file-indexer block"
grep -q '^topic read droplet/files/brain/uploaded$' "$ACL" || fail "acl: file-indexer read brain/uploaded"
grep -A2 '^user email-indexer$' "$ACL" | grep -q 'topic write email/+/new' || fail "acl: email-indexer"
grep -A2 '^user camera-discovery$' "$ACL" | grep -q 'topic write droplet/cameras/discovered' || fail "acl: camera-discovery"
grep -A2 '^user frigate$' "$ACL" | grep -q 'topic readwrite frigate/#' || fail "acl: frigate"
grep -A3 '^user orchestrator$' "$ACL" | grep -q 'topic readwrite droplet/#' || fail "acl: orchestrator"
# file-indexer must NOT hold a droplet/# grant (least privilege)
awk '/^user file-indexer$/,/^user [^f]/' "$ACL" | grep -q 'droplet/#' && fail "acl: file-indexer over-granted"

# 4. compose: broker mounts tls+acl on STAGING paths, publishes loopback 8883,
#    passwd mount gone. WARP-2154: neither the bundle nor the ACL may be
#    mounted directly at the paths mosquitto.conf names — mosquitto drops to
#    uid 1883 before loading TLS material and the host-side bundle is
#    install-user-owned 0600 (relocate_secrets_to_data re-owns the whole
#    relocated secrets tree), so a direct mount crash-loops a fresh install.
grep -q '127.0.0.1:8883:8883' "$C" || fail "compose: loopback 8883 publish"
grep -q './mosquitto.acl:/acl-src/droplet.acl:ro' "$C" || fail "compose: acl staging mount"
grep -q 'service-tls/broker:/certs-src:ro' "$C" || fail "compose: broker tls staging mount"
grep -q ':/mosquitto/config/tls' "$C" && fail "compose: broker bundle mounted directly at the config path (WARP-2154)"
grep -q 'mosquitto.acl:/mosquitto/config/droplet.acl' "$C" && fail "compose: ACL mounted directly at the config path (WARP-2154)"
grep -q 'mosquitto_passwd_dir' "$C" && fail "compose: passwd_dir mount still present"

# 4c. WARP-2154: the broker command stages the bundle + ACL with mosquitto-uid
#     ownership as container-root, then execs the stock entrypoint (the
#     WARP-233 db / WARP-234 cache pattern) — and the issuance lib carries no
#     broker ownership fix-ups (relocation undid them) nor the world-readable
#     key fallback.
grep -q 'install -o mosquitto -g mosquitto -m 600 /certs-src/key.pem /mosquitto/config/tls/key.pem' "$C" \
  || fail "compose: broker does not stage key.pem 0600 mosquitto-owned"
grep -q 'install -o mosquitto -g mosquitto -m 640 /acl-src/droplet.acl /mosquitto/config/droplet.acl' "$C" \
  || fail "compose: broker does not stage droplet.acl 0640 mosquitto-owned"
grep -q 'exec /docker-entrypoint.sh mosquitto -c /mosquitto/config/mosquitto.conf' "$C" \
  || fail "compose: broker staging wrapper must exec the stock entrypoint"
grep -q 'chmod 644 "$key"' "$REPO_ROOT/scripts/lib/internal-ca.sh" \
  && fail "internal-ca.sh: world-readable key fallback is back (WARP-2154)"
grep -q '1883' "$REPO_ROOT/scripts/lib/internal-ca.sh" \
  && fail "internal-ca.sh: broker uid special-case is back (WARP-2154 — ownership is staged in-container by compose)"

# 4b. compose: every MQTT client mounts its own bundle (CN = service name)
for svc in orchestrator file-indexer email-indexer camera-discovery frigate; do
  grep -q "service-tls/$svc:/data/service-tls:ro" "$C" || fail "compose: $svc bundle mount"
done

# 5. secrets.sh/compose.sh: passwd generator retired, mqtts URLs written
grep -q '_generate_mosquitto_passwd' "$REPO_ROOT/scripts/lib/secrets.sh" && fail "passwd generator still present"
grep -q 'MQTT_BROKER=mqtts://broker:8883' "$REPO_ROOT/scripts/lib/secrets.sh" || fail "mqtts .env writer"
grep -q 'MQTT_BROKER_LOCAL=mqtts://localhost:8883' "$REPO_ROOT/scripts/lib/secrets.sh" || fail "mqtts local .env writer"
# MQTT_PASSWORD must not be a REQUIRED_ENV_VARS element (bare list entry);
# a comment explaining the retirement is fine.
grep -qE '^\s*MQTT_PASSWORD\s*$' "$REPO_ROOT/scripts/lib/compose.sh" && fail "compose.sh still requires MQTT_PASSWORD"
grep -q 'mkdir -p "$REPO_ROOT/docker/mosquitto_passwd_dir"' "$REPO_ROOT/scripts/lib/compose.sh" && fail "compose.sh still creates mosquitto_passwd_dir"

# 6. frigate speaks mTLS to the broker
F="$REPO_ROOT/docker/frigate/config.yml"
grep -q 'port: 8883' "$F" || fail "frigate mqtt port"
grep -q 'tls_ca_certs: /data/service-tls/ca.pem' "$F" || fail "frigate tls_ca_certs"
grep -q 'tls_client_cert: /data/service-tls/cert.pem' "$F" || fail "frigate tls_client_cert"
grep -q 'tls_client_key: /data/service-tls/key.pem' "$F" || fail "frigate tls_client_key"
grep -q 'FRIGATE_MQTT_PASSWORD' "$F" && fail "frigate still uses password auth"

echo "PASS tests/mosquitto-conf.test.sh"
