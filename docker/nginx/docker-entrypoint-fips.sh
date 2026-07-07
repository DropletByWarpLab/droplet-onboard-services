#!/bin/sh
# WARP-1021 — select the edge-TLS cipher profile + FIPS OpenSSL config from the
# single DROPLET_FIPS_MODE knob. Runs in the stock nginx image's
# /docker-entrypoint.d/ (as 00-fips-profile.sh) BEFORE nginx starts. Default
# (unset/0) = modern ciphers; 1 = FIPS-restricted.
#
# The stock nginx entrypoint `exec`s nginx in the same shell after running the
# /docker-entrypoint.d/*.sh hooks, so `export OPENSSL_CONF` here reaches the
# nginx master process. As a belt-and-suspenders the compose `gateway` service
# ALSO passes OPENSSL_CONF via `environment:` (gated on ${OPENSSL_CONF:-}, the
# same var setup.sh --fips writes) — either path activates the provider.
set -eu

PROFILE_LINK=/etc/nginx/cipher-profile.active.conf

case "${DROPLET_FIPS_MODE:-0}" in
  1|true|TRUE|on|yes)
    ln -sf /etc/nginx/cipher-profile.fips.conf "$PROFILE_LINK"
    # Activate the validated provider for nginx's SYSTEM OpenSSL (the Debian
    # nginx links libssl3, so OPENSSL_CONF alone activates FIPS — same as the
    # Python services). Only set it if setup.sh didn't already pass one in.
    export OPENSSL_CONF="${OPENSSL_CONF:-/etc/ssl/openssl-fips.cnf}"
    echo '{"event":"fips_edge_tls","gateway":"nginx","fips":true,"provider":"OpenSSL 3 FIPS"}'
    ;;
  *)
    ln -sf /etc/nginx/cipher-profile.default.conf "$PROFILE_LINK"
    echo '{"event":"fips_edge_tls","gateway":"nginx","fips":false}'
    ;;
esac
