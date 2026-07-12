#!/bin/sh
# WARP-1061 — select the first-party upstream scheme (plain HTTP vs mTLS)
# from the single DROPLET_INTERNAL_TLS knob. Runs in the stock nginx image's
# /docker-entrypoint.d/ (as 01-internal-scheme.sh) BEFORE nginx starts —
# the exact WARP-1021 cipher-profile selector pattern (00-fips-profile.sh).
# Default (unset/0) = plain http:// proxy_pass, byte-identical to before;
# 1 = https:// + the proxy_ssl_* client-cert block against the
# orchestrator/ai-gateway mTLS listeners.
set -eu

SCHEME_LINK=/etc/nginx/internal-scheme.active.conf

case "${DROPLET_INTERNAL_TLS:-0}" in
  1)
    ln -sf /etc/nginx/internal-scheme.mtls.conf "$SCHEME_LINK"
    echo '{"event":"internal_mtls_upstreams","gateway":"nginx","mtls":true}'
    ;;
  *)
    ln -sf /etc/nginx/internal-scheme.default.conf "$SCHEME_LINK"
    echo '{"event":"internal_mtls_upstreams","gateway":"nginx","mtls":false}'
    ;;
esac
