#!/bin/bash
# Post-installation hook: replace default skeleton files with Droplet guide.
# This runs once after the initial Nextcloud auto-install.
php /var/www/html/occ config:system:set skeletondirectory --value="/skeleton"

# ── WARP-882 / WS-4 — OnlyOffice connector (in-browser editing + co-authoring) ──
#
# Enable + configure the Nextcloud `onlyoffice` connector app so it drives the
# Document Server over a WOPI-style handshake. Idempotent: `occ app:enable` and
# `occ config:app:set` are no-ops / overwrites on re-run, and we only configure
# when DOCS_ENABLED is on AND a JWT secret is present (fail-safe: an unconfigured
# box skips the connector rather than wiring it to a non-existent engine).
#
# URLs:
#   DocumentServerUrl         — browser-facing engine path, fronted by the
#                               gateway at /docs/ (see docker/nginx.conf).
#   DocumentServerInternalUrl — compose-network address the connector reaches
#                               the engine on directly (no gateway hop).
#   StorageUrl                — how the engine calls BACK into Nextcloud.
# The shared `jwt_secret` is the same value the engine + orchestrator verify.
#
# LICENSE: built/tested against OnlyOffice Document Server Community Edition
# (AGPLv3); an OnlyOffice OEM/commercial license is required before GA. No
# license enforcement here — the engine is config-driven (engine-agnostic WOPI).
DOCS_ENABLED_NORM="$(printf '%s' "${DOCS_ENABLED:-1}" | tr '[:upper:]' '[:lower:]')"
if { [ "$DOCS_ENABLED_NORM" = "1" ] || [ "$DOCS_ENABLED_NORM" = "true" ]; } \
   && [ -n "${ONLYOFFICE_JWT_SECRET:-}" ]; then
  php /var/www/html/occ app:install onlyoffice 2>/dev/null || true
  php /var/www/html/occ app:enable onlyoffice
  php /var/www/html/occ config:app:set onlyoffice DocumentServerUrl \
    --value="/docs/"
  php /var/www/html/occ config:app:set onlyoffice DocumentServerInternalUrl \
    --value="http://docserver/"
  php /var/www/html/occ config:app:set onlyoffice StorageUrl \
    --value="http://nextcloud/"
  php /var/www/html/occ config:app:set onlyoffice jwt_secret \
    --value="${ONLYOFFICE_JWT_SECRET}"
  php /var/www/html/occ config:app:set onlyoffice jwt_header \
    --value="Authorization"
else
  echo "nextcloud-init: OnlyOffice connector NOT configured (DOCS_ENABLED='${DOCS_ENABLED:-1}', jwt secret $( [ -n "${ONLYOFFICE_JWT_SECRET:-}" ] && echo set || echo empty ))" >&2
fi
