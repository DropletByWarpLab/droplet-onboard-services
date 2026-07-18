# WARP-230 — device-identity-svc sidecar Dockerfile.
#
# Mirrors the WARP-229 Python FIPS-provider pattern from
# services/file-indexer/Dockerfile and services/ai-gateway/Dockerfile.
#
# Build context is the monorepo root (see docker-compose.yml service
# `context: ..`). All COPY paths here are relative to the repo root.
FROM python:3.12-slim

WORKDIR /app

# System deps:
#  - openssl + ca-certificates: WARP-229 FIPS provider activation
#  - gcc + python3-dev + pkg-config: tpm2-pytss native build
#  - libtss2-dev + tpm2-tools: TPM 2.0 userspace stack (real backend)
# WARP-1065: BuildKit cache mounts — apt archives + lists persist across
# rebuilds, so a layer-busted rebuild re-executes every instruction but skips
# the re-downloads. docker-clean is dropped inside the mount scope so .debs
# are actually retained; the mounts shadow both paths in the layer, so the
# image stays as slim as the old `rm -rf /var/lib/apt/lists/*`. NOTE: a
# blanket `docker build --no-cache` RESETS cache mounts (measured on engine
# 29.5; moby/moby#41715) — the reflash runner must bust layers without that
# flag for these mounts to pay off (see WARP-1065).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl ca-certificates \
      gcc python3-dev pkg-config \
      libtss2-dev tpm2-tools

COPY services/device-identity-svc/requirements.txt .
# WARP-1065: persistent pip wheel/http cache (replaces --no-cache-dir; the
# cache lives in the mount, not the image).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Copy proto + generate gRPC stubs at build time so the image stays in
# sync with proto/ even if the in-tree generated files drift.
COPY proto/ /app/proto/
RUN mkdir -p /app/grpc_generated && \
    touch /app/grpc_generated/__init__.py && \
    python -m grpc_tools.protoc \
      -I/app/proto \
      --python_out=/app/grpc_generated \
      --grpc_python_out=/app/grpc_generated \
      /app/proto/device_identity.proto && \
    sed -i 's/^import device_identity_pb2/from grpc_generated import device_identity_pb2/' \
      /app/grpc_generated/device_identity_pb2_grpc.py

# Service code (after stub generation so the COPY-in tree doesn't shadow
# /app/grpc_generated). Excludes the in-tree grpc_generated/ + tests via
# .dockerignore semantics — we just don't re-copy them here. Use a sub
# COPY so the freshly generated stubs aren't overwritten.
COPY services/device-identity-svc/backends /app/backends
COPY services/device-identity-svc/storage.py /app/storage.py
COPY services/device-identity-svc/grpc_server.py /app/grpc_server.py
COPY services/device-identity-svc/main.py /app/main.py

# WARP-229: ship the FIPS-provider OpenSSL config + shared self-test
# helper. `OPENSSL_CONF` is intentionally NOT set in the image; the
# Compose service flips it at runtime once the operator has layered
# the validated FIPS module on top. Same pattern as file-indexer +
# ai-gateway.
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY services/_shared/__init__.py /app/_shared/__init__.py
COPY services/_shared/fips_selftest.py /app/_shared/fips_selftest.py

ENV PYTHONPATH=/app

# Drop privileges. The Compose file bind-mounts /var/lib/droplet/tpm/
# + /var/run/droplet/ from the host; the droplet user needs to own
# both. /dev/tpm0 access (real backend in production) is granted via the
# `tss` group on the host; runtime grouping wiring is a Compose-side
# concern.
#
# WARP-1248: no USER directive — a bind mount shadows the chown below
# whenever dockerd auto-creates a missing host source (root:root 0755 on
# every fresh CI runner; the EK-cert write then crash-loops the sidecar).
# entrypoint.sh starts as root, fixes ownership of the two mounted dirs,
# and drops to `droplet` via setpriv before exec'ing the service.
RUN groupadd -r droplet && useradd -r -g droplet -d /app droplet && \
    mkdir -p /var/run/droplet /var/lib/droplet/tpm && \
    chown -R droplet:droplet /app /var/run/droplet /var/lib/droplet/tpm

COPY services/device-identity-svc/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "main.py"]
