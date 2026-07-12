FROM python:3.12-slim

# Build context is the monorepo root (see docker-compose.yml). All COPY
# paths are relative to the repo root. WARP-229.

# wsdiscovery pulls in netifaces, which has no prebuilt wheel for Python 3.12
# and needs a C toolchain to compile from sdist. Install build deps, then
# remove them after pip install to keep the image slim.
# WARP-229 — also installs openssl + ca-certificates for the FIPS provider.
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      gcc libc-dev python3-dev \
      openssl ca-certificates

WORKDIR /app
COPY services/camera-discovery/requirements.txt .
# WARP-1065: persistent pip wheel/http cache (replaces --no-cache-dir; the
# cache lives in the mount, not the image).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt && \
    apt-get purge -y --auto-remove gcc libc-dev python3-dev
COPY services/camera-discovery/ .

# WARP-229: ship the FIPS-provider OpenSSL config + shared self-test
# helper. `OPENSSL_CONF` is intentionally NOT set at image-baseline (see
# services/file-indexer/Dockerfile rationale). Operator flips
# OPENSSL_CONF + DROPLET_FIPS_REQUIRED=true together at runtime once
# the validated FIPS module is layered on.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py
COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py

EXPOSE 8085
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8085"]
