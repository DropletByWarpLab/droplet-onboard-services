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
RUN chmod +x /docker-entrypoint.d/00-fips-profile.sh && \
    # Default the active profile to modern so `nginx -t` and a bare run before
    # the entrypoint has selected are well-formed.
    ln -sf /etc/nginx/cipher-profile.default.conf /etc/nginx/cipher-profile.active.conf

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
    rm -f /tmp/t.key /tmp/t.crt /tmp/test-nginx.conf; \
    echo "WARP-1021 nginx cipher-profile self-test OK — default + fips profiles parse"

# nginx:1.27-bookworm already EXPOSEs 80/443 and ships the stock entrypoint that
# runs /docker-entrypoint.d/*.sh before starting nginx — our profile-selector
# hooks in there. No CMD override needed.
