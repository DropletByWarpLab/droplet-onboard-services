# WARP-1021 — Bookworm-based nginx with the dormant NIST-validated OpenSSL FIPS
# provider (CMVP #4282), mirroring the WARP-967 service-image pattern. Edge TLS
# termination on validated crypto WHEN DROPLET_FIPS_MODE=1; modern ciphers
# (TLS 1.3) by default. Replaces the old nginx:alpine gateway (Alpine/musl has
# no validated FIPS provider path — same reason WARP-229 moved every service off
# Alpine).
#
# Build context is the repo ROOT (compose sets `context: ..`) so the shared
# docker/fips/** + docker/openssl-fips.cnf COPY paths resolve exactly like the
# service images.
#
# Size delta (measured 2026-07-05, linux/arm64, containerd image store):
# nginx:alpine 92.6 MB → this image 300 MB, of which the nginx:1.27-bookworm
# base is 284 MB — i.e. the FIPS layers (openssl CLI + ca-certificates +
# fips.so + fipsmodule.cnf + profiles) add only ~16 MB; the rest is the
# Alpine→Debian base swap that FIPS validation requires. The fips-builder
# stage is DISCARDED (only fips.so ~4 MB + the Debian nginx base ship) and is
# shared/cached with the five service images (identical first stage), so the
# incremental build cost is near-zero.

# --- FIPS provider build stage (byte-identical to the service images) --------
FROM debian:bookworm-slim AS fips-builder
COPY docker/fips/build-openssl-fips.sh /tmp/build-openssl-fips.sh
RUN sh /tmp/build-openssl-fips.sh /out

# --- Runtime: Debian-packaged nginx (links the SYSTEM OpenSSL 3, so
#     OPENSSL_CONF alone activates FIPS — same as the Python images) ----------
FROM nginx:1.27-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Shared FIPS activation config (COPY, do not activate at baseline).
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf

# Install + build-time self-test (KATs + positive probe @ 3.0.9 + MD5-negative
# probe). Same script + gate as every service image — a KAT or probe failure
# fails this build.
COPY --from=fips-builder /out/fips.so /tmp/fips.so
COPY docker/fips/install-fips-provider.sh /tmp/install-fips-provider.sh
RUN sh /tmp/install-fips-provider.sh /tmp/fips.so && \
    rm -f /tmp/fips.so /tmp/install-fips-provider.sh

# Cipher profiles + the config that `include`s ONE of them. The active profile
# is chosen at container start by the entrypoint below, keyed on
# DROPLET_FIPS_MODE. Default (unset/0) = modern; 1 = FIPS-restricted.
COPY docker/nginx/cipher-profile.default.conf /etc/nginx/cipher-profile.default.conf
COPY docker/nginx/cipher-profile.fips.conf    /etc/nginx/cipher-profile.fips.conf
COPY docker/nginx/nginx.conf                  /etc/nginx/nginx.conf
COPY docker/nginx/docker-entrypoint-fips.sh   /docker-entrypoint.d/00-fips-profile.sh
# WARP-1061: first-party upstream scheme variants + the selector that picks
# one from DROPLET_INTERNAL_TLS at container start (same pattern as the
# cipher profiles above). Default (unset/0) = plain http proxy_pass.
COPY docker/nginx/internal-scheme.default.conf /etc/nginx/internal-scheme.default.conf
COPY docker/nginx/internal-scheme.mtls.conf    /etc/nginx/internal-scheme.mtls.conf
COPY docker/nginx/docker-entrypoint-internal-tls.sh /docker-entrypoint.d/01-internal-scheme.sh
# Warning-free droplet.local: the canonical-host render script (start +
# exec'd by tls-reload.sh on every cert swap), its entrypoint slot, the baked
# OFF default (so `nginx -t` and a bare run are well-formed pre-entrypoint),
# and the plain-HTTP status page the OFF variant serves.
COPY docker/nginx/render-canonical-host.sh            /usr/local/bin/render-canonical-host.sh
COPY docker/nginx/docker-entrypoint-canonical-host.sh /docker-entrypoint.d/02-canonical-host.sh
COPY docker/nginx/canonical-host.off.conf /etc/nginx/canonical-host.active.conf
COPY docker/nginx/tls-status/index.html               /usr/share/nginx/tls-status/index.html
# WARP-1686: document-engine /docs/ proxy variants + the selector that picks
# one from DOCS_ENGINE at container start (same pattern as the cipher profiles
# / internal scheme above). Default (unset) = collabora.
COPY docker/nginx/docs-engine.collabora.conf  /etc/nginx/docs-engine.collabora.conf
COPY docker/nginx/docs-engine.onlyoffice.conf /etc/nginx/docs-engine.onlyoffice.conf
COPY docker/nginx/docker-entrypoint-docs-engine.sh /docker-entrypoint.d/03-docs-engine.sh
RUN chmod +x /docker-entrypoint.d/00-fips-profile.sh /docker-entrypoint.d/01-internal-scheme.sh \
             /docker-entrypoint.d/02-canonical-host.sh /docker-entrypoint.d/03-docs-engine.sh \
             /usr/local/bin/render-canonical-host.sh && \
    # Default the active profile/scheme to the OFF posture so `nginx -t` and
    # a bare run before the entrypoints have selected are well-formed.
    ln -sf /etc/nginx/cipher-profile.default.conf /etc/nginx/cipher-profile.active.conf && \
    ln -sf /etc/nginx/internal-scheme.default.conf /etc/nginx/internal-scheme.active.conf && \
    ln -sf /etc/nginx/docs-engine.collabora.conf /etc/nginx/docs-engine.active.conf

# --- Build-time nginx-config self-test: both cipher profiles must parse -------
# The full nginx.conf server block references TLS certs that don't exist in the
# image (they're volume-mounted at runtime), so a plain `nginx -t` on it would
# fail on missing certs — NOT a config-syntax failure. Instead validate each
# cipher profile's directives in a minimal throwaway config so a typo in a
# profile (bad ssl_ciphers / ssl_conf_command) fails THIS build. We generate a
# self-signed cert on the fly purely so the ssl server block can load.
RUN set -eu; \
    openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/t.key -out /tmp/t.crt \
      -subj /CN=localhost -days 1 >/dev/null 2>&1; \
    for prof in default fips; do \
      printf 'events{}\nhttp{\n server{\n  listen 8443 ssl;\n  ssl_certificate /tmp/t.crt;\n  ssl_certificate_key /tmp/t.key;\n  include /etc/nginx/cipher-profile.%s.conf;\n  location / { return 200; }\n }\n}\n' "$prof" > /tmp/test-nginx.conf; \
      nginx -t -c /tmp/test-nginx.conf; \
    done; \
    # WARP-1061: both internal-scheme variants must parse too. The mtls
    # variant's proxy_ssl_certificate paths are runtime volume mounts, so
    # stage the throwaway pair at those paths for the parse check only.
    mkdir -p /etc/nginx/service-tls; \
    cp /tmp/t.crt /etc/nginx/service-tls/cert.pem; \
    cp /tmp/t.key /etc/nginx/service-tls/key.pem; \
    cp /tmp/t.crt /etc/nginx/service-tls/ca.pem; \
    for scheme in default mtls; do \
      printf 'events{}\nhttp{\n include /etc/nginx/internal-scheme.%s.conf;\n server{\n  listen 8080;\n  location / { set $upvar "localhost:1"; proxy_pass $internal_scheme://$upvar; }\n }\n}\n' "$scheme" > /tmp/test-nginx.conf; \
      nginx -t -c /tmp/test-nginx.conf; \
    done; \
    rm -rf /etc/nginx/service-tls; \
    # Warning-free droplet.local: both canonical-host variants must parse.
    # OFF = the baked default; ON = a real render against a mini-CA leaf.
    openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ca.key -out /tmp/ca.crt \
      -subj /CN=TestCA -days 1 >/dev/null 2>&1; \
    openssl req -newkey rsa:2048 -nodes -keyout /tmp/l.key -out /tmp/l.csr \
      -subj /CN=leaf >/dev/null 2>&1; \
    printf 'subjectAltName=DNS:test-box.droplet-us.com\n' > /tmp/san.cnf; \
    openssl x509 -req -in /tmp/l.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key -CAcreateserial \
      -days 1 -extfile /tmp/san.cnf -out /tmp/l.crt >/dev/null 2>&1; \
    DROPLET_LAN_DNS_AUTHORITY=1 DROPLET_CANONICAL_CERT=/tmp/l.crt \
      DROPLET_CANONICAL_OUT=/tmp/ch-on.conf /usr/local/bin/render-canonical-host.sh; \
    grep -q 'test-box.droplet-us.com' /tmp/ch-on.conf; \
    for ch in /etc/nginx/canonical-host.active.conf /tmp/ch-on.conf; do \
      printf 'events{}\nhttp{\n resolver 127.0.0.11 valid=10s ipv6=off;\n include %s;\n}\n' "$ch" > /tmp/test-nginx.conf; \
      nginx -t -c /tmp/test-nginx.conf; \
    done; \
    rm -f /tmp/ca.key /tmp/ca.crt /tmp/ca.srl /tmp/l.key /tmp/l.csr /tmp/l.crt /tmp/san.cnf /tmp/ch-on.conf; \
    echo "canonical-host self-test OK — OFF + ON variants render and parse"; \
    # WARP-1686: both document-engine /docs/ variants must parse. They
    # reference the $connection_upgrade map, so the throwaway config declares
    # it exactly like nginx.conf does.
    for eng in collabora onlyoffice; do \
      printf 'events{}\nhttp{\n map $http_upgrade $connection_upgrade { default upgrade; "" close; }\n server{\n  listen 8080;\n  include /etc/nginx/docs-engine.%s.conf;\n }\n}\n' "$eng" > /tmp/test-nginx.conf; \
      nginx -t -c /tmp/test-nginx.conf; \
    done; \
    # WARP-1688: and finally the REAL /etc/nginx/nginx.conf, end to end.
    # Everything above validates an INCLUDE variant in a throwaway config —
    # nothing validated nginx.conf itself, because its server block loads TLS
    # certs that are runtime volume mounts. So a syntax error added directly to
    # nginx.conf (a location block, say) shipped unparsed and only surfaced when
    # the gateway refused to start on a customer's box. Stage the throwaway pair
    # at the runtime cert path, parse the real config, then remove them — the
    # image still ships with no certs baked in.
    mkdir -p /etc/nginx/certs; \
    cp /tmp/t.crt /etc/nginx/certs/droplet.crt; \
    cp /tmp/t.key /etc/nginx/certs/droplet.key; \
    nginx -t -c /etc/nginx/nginx.conf; \
    rm -rf /etc/nginx/certs; \
    rm -f /tmp/t.key /tmp/t.crt /tmp/test-nginx.conf; \
    echo "WARP-1021 nginx cipher-profile self-test OK — default + fips profiles parse"; \
    echo "WARP-1061 internal-scheme self-test OK — default + mtls variants parse"; \
    echo "WARP-1686 docs-engine self-test OK — collabora + onlyoffice variants parse"; \
    echo "WARP-1688 full-config self-test OK — /etc/nginx/nginx.conf parses"

# nginx:1.27-bookworm already EXPOSEs 80/443 and ships the stock entrypoint that
# runs /docker-entrypoint.d/*.sh before starting nginx — our profile-selector
# hooks in there. No CMD override needed.
