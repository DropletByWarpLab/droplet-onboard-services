FROM python:3.12-slim

# Build context is the monorepo root (see docker-compose.yml). All COPY
# paths are relative to the repo root. WARP-2211.

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/doc-render/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/doc-render/ .

# Sibling shape (web-fetch/routing/camera-discovery): ship the FIPS-provider
# OpenSSL config + shared helpers. doc-render is NOT one of the six
# provider-carrying images — compose pins DROPLET_FIPS_REQUIRED=false / stock
# OPENSSL_CONF for this container, so the boot self-test stays a no-op.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py
COPY services/_shared/internal_tls.py /app/_shared/internal_tls.py
# WARP-1061: shared uvicorn launcher — serves the bundle + requires client
# certs when DROPLET_INTERNAL_TLS=1, byte-identical plaintext when 0.
COPY services/_shared/serve.py /app/_shared/serve.py

EXPOSE 8020
CMD ["python", "-m", "_shared.serve", "main:app", "--host", "0.0.0.0", "--port", "8020"]
