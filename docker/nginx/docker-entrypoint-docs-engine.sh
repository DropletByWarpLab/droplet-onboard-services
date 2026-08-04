#!/bin/sh
# WARP-1686 — select the /docs/ document-engine proxy variant from the single
# DOCS_ENGINE knob. Runs in the stock nginx image's /docker-entrypoint.d/ (as
# 03-docs-engine.sh) BEFORE nginx starts — the exact WARP-1021 / WARP-1061
# selector pattern (00-fips-profile.sh / 01-internal-scheme.sh).
#   collabora (default/unset) → docs-engine.collabora.conf: keep the /docs
#     prefix, proxy to docserver:9980 (coolwsd under net.service_root=/docs).
#   onlyoffice → docs-engine.onlyoffice.conf: strip /docs/ (trailing-slash
#     proxy_pass) to docserver:80 — byte-identical to the WARP-882 leg.
set -eu

ENGINE_LINK=/etc/nginx/docs-engine.active.conf

case "${DOCS_ENGINE:-collabora}" in
  onlyoffice)
    ln -sf /etc/nginx/docs-engine.onlyoffice.conf "$ENGINE_LINK"
    echo '{"event":"docs_engine_proxy","gateway":"nginx","engine":"onlyoffice"}'
    ;;
  *)
    ln -sf /etc/nginx/docs-engine.collabora.conf "$ENGINE_LINK"
    echo '{"event":"docs_engine_proxy","gateway":"nginx","engine":"collabora"}'
    ;;
esac
