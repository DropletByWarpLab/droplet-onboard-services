FROM python:3.12-slim

# Build context is the monorepo root (see docker-compose.yml). All COPY
# paths are relative to the repo root — mirrors camera-discovery.

# WARP-229 — openssl + ca-certificates for the FIPS provider config and
# for verifying the portal's TLS chain (this service is outbound-only).
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/fleet-agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/fleet-agent/ .

# WARP-229: ship the FIPS-provider OpenSSL config + shared self-test
# helper. `OPENSSL_CONF` is intentionally NOT set at image-baseline (see
# services/file-indexer/Dockerfile rationale). Operator flips
# OPENSSL_CONF + DROPLET_FIPS_REQUIRED=true together at runtime once
# the validated FIPS module is layered on.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py

# Runtime state (ingest token + heartbeat spool) lives on the
# fleet-agent-state volume — never in the image, never in git.
VOLUME ["/var/lib/droplet/fleet-agent"]

# No EXPOSE: this service accepts NO inbound connections. Outbound-only.
CMD ["python", "main.py"]
