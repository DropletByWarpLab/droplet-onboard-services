#!/bin/sh
# Read install-user-owned TLS secrets as container root, stage a private copy
# in tmpfs, then run the API and its children as the unprivileged service uid.
# Host keys stay 0600 and read-only; no ownership repair reaches the host.
set -eu

if [ "$#" -eq 0 ]; then
  echo "service bootstrap requires a command" >&2
  exit 1
fi
uid=$(id -u)
if [ "$uid" = 1000 ]; then
  # Standalone image runs keep their default unprivileged user. Compose
  # starts this entrypoint as root solely to stage otherwise unreadable keys.
  exec "$@"
fi
if [ "$uid" != 0 ]; then
  echo "service bootstrap requires root or the service uid" >&2
  exit 1
fi

if [ "${DROPLET_INTERNAL_TLS:-0}" = 1 ]; then
  stage=$(mktemp -d "${TMPDIR:-/tmp}/droplet-service-tls.XXXXXX")
  # Set modes while root still owns the copies, then change ownership once.
  # This avoids needing CAP_FOWNER during bootstrap.
  install -m 600 "${DROPLET_TLS_KEY:-/data/service-tls/key.pem}" "$stage/key.pem"
  install -m 644 "${DROPLET_TLS_CERT:-/data/service-tls/cert.pem}" "$stage/cert.pem"
  install -m 644 "${DROPLET_TLS_CA:-/data/service-tls/ca.pem}" "$stage/ca.pem"
  chown 1000:1000 "$stage" "$stage/key.pem" "$stage/cert.pem" "$stage/ca.pem"
  export DROPLET_TLS_KEY="$stage/key.pem" DROPLET_TLS_CERT="$stage/cert.pem" DROPLET_TLS_CA="$stage/ca.pem"
fi

exec setpriv --reuid 1000 --regid 1000 --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs "$@"
