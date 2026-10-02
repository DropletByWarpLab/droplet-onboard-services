FROM python:3.12-slim

# Build context is the monorepo root (see docker-compose.yml). All COPY
# paths are relative to the repo root. WARP-229.

# WARP-229 — System deps for the FIPS provider.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/device-gateway/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/device-gateway/ .

# WARP-229: ship the FIPS-provider OpenSSL config + shared self-test
# helper. `OPENSSL_CONF` is intentionally NOT set at image-baseline (see
# services/file-indexer/Dockerfile rationale).
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py
COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py
# WARP-1061: shared uvicorn launcher — serves the bundle + requires client
# certs when DROPLET_INTERNAL_TLS=1, byte-identical plaintext when 0.
COPY services/_shared/serve.py /app/_shared/serve.py
COPY services/_shared/healthcheck.py /app/_shared/healthcheck.py

# Registry of devices + points (0600). /data/service-tls is the mTLS bundle
# mount, so the registry lives beside the other host services' state.
VOLUME ["/var/lib/droplet/device-gateway"]

EXPOSE 8084
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD ["python", "-m", "_shared.healthcheck", "8084", "/health"]
CMD ["python", "-m", "_shared.serve", "main:app", "--host", "0.0.0.0", "--port", "8084"]
