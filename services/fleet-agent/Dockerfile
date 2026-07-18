FROM python:3.12-slim

# Build context is the monorepo root (see docker-compose.yml). All COPY
# paths are relative to the repo root — mirrors camera-discovery.

# WARP-229 — openssl + ca-certificates for the FIPS provider config and
# for verifying the portal's TLS chain (this service is outbound-only).
#
# WARP-1025: the same RUN (while curl is still present) vendors the cosign
# binary the update-poll execs for `cosign verify-blob` over OTA release
# manifests (release_verify.py — Python port of the WARP-537 library).
# Version-pinned and checksum-pinned per arch, mirroring
# apps/orchestrator/Dockerfile (same pins — bump them together); the build
# FAILS on any mismatch. curl is pulled in only for this fetch, then purged.
ARG COSIGN_VERSION=2.6.3
ARG COSIGN_SHA256_AMD64=7c78a7f2efc00088bd788a758db6e0928e79f3e0eb83eb5d3c499ed98da4c4f4
ARG COSIGN_SHA256_ARM64=b7c23659a50a59fd8eec44b87188e9062157d0c87796cac7b38727e5390c4917
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates curl && \
    arch="$(dpkg --print-architecture)" && \
    case "$arch" in \
      amd64) cosign_sha="$COSIGN_SHA256_AMD64" ;; \
      arm64) cosign_sha="$COSIGN_SHA256_ARM64" ;; \
      *) echo "unsupported architecture for cosign: $arch" >&2; exit 1 ;; \
    esac && \
    curl --fail -L -o /usr/local/bin/cosign \
      "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${arch}" && \
    echo "${cosign_sha}  /usr/local/bin/cosign" | sha256sum -c - && \
    chmod 0755 /usr/local/bin/cosign && \
    /usr/local/bin/cosign version && \
    apt-get purge -y --auto-remove curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/fleet-agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Ships the update-poll trust anchor too (services/fleet-agent/cosign.pub,
# WARP-1025) — the placeholder fails closed until the key ceremony stamps
# the real key over BOTH copies (scripts/README.md "OTA release signing").
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
