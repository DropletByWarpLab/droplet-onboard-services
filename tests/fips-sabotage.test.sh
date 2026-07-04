#!/usr/bin/env bash
# =============================================================================
# WARP-316 — deliberate-sabotage proof for the build-time FIPS gate.
# =============================================================================
#
# Proves the build-time FIPS gate (docker/fips/install-fips-provider.sh, RUN in
# every shipped image) is NOT a no-op: with the validated module fips.so removed
# post-install, the FIPS provider cannot load and the FIPS config no longer
# reports it active. If removing fips.so did NOT break provider load, the gate
# would be certifying nothing.
#
# Builds one minimal throwaway image (repo root as context, so the shared
# docker/fips/** + docker/openssl-fips.cnf COPY paths resolve exactly as the
# service images do), installs the provider for real, deletes fips.so, and
# asserts `openssl list -providers` under the FIPS config no longer shows the
# provider. Keeps the sabotage OUT of the shipped Dockerfiles (cleaner than a
# build-arg-guarded rm inside them).
#
# Requires Docker. When Docker is unavailable (local non-Docker runs, the
# static-lint CI leg) it SKIPs with exit 0 so those legs stay green; the
# Docker-gated CI leg (test-fips.yml, docker job) runs it for real.
# =============================================================================
set -uo pipefail  # NOT -e: report + continue (flat harness convention)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -n "${SABOTAGE_ASSUME_NO_DOCKER:-}" ] || ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker unavailable — sabotage proof runs in the Docker-gated CI leg"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/Dockerfile" <<'DOCKER'
# syntax=docker/dockerfile:1
# Build the validated FIPS module exactly as the service images do.
FROM debian:bookworm-slim AS fips-builder
COPY docker/fips/build-openssl-fips.sh /tmp/build-openssl-fips.sh
RUN sh /tmp/build-openssl-fips.sh /out

# Install it, run the real build-time self-test, THEN sabotage: remove the
# module and prove the FIPS provider is no longer loadable.
FROM debian:bookworm-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
COPY --from=fips-builder /out/fips.so /tmp/fips.so
COPY docker/fips/install-fips-provider.sh /tmp/install-fips-provider.sh
RUN sh /tmp/install-fips-provider.sh /tmp/fips.so
# --- SABOTAGE: remove the validated module, then prove the config now errors ---
RUN MOD="$(OPENSSL_CONF=/etc/ssl/openssl.cnf openssl version -m | sed -n 's/^MODULESDIR: "\(.*\)"$/\1/p')" && \
    rm -f "$MOD/fips.so" && \
    if OPENSSL_CONF=/etc/ssl/openssl-fips.cnf openssl list -providers 2>/dev/null | grep -q "OpenSSL FIPS Provider"; then \
      echo "SABOTAGE PROOF FAILED: FIPS provider still loaded after fips.so removed" >&2; exit 1; \
    fi && \
    echo "SABOTAGE PROOF OK: provider gone after fips.so removed"
DOCKER

echo "  building sabotage image (compiles OpenSSL FIPS module — minutes on a cold cache)..."
if DOCKER_BUILDKIT=1 docker build -f "$work/Dockerfile" "$REPO_ROOT" > "$work/log" 2>&1; then
  if grep -q "SABOTAGE PROOF OK" "$work/log"; then
    echo "  ✓ gate depends on fips.so (removing it breaks provider load)"
    exit 0
  fi
  echo "  ✗ build succeeded but the SABOTAGE PROOF OK line is missing" >&2
  cat "$work/log" >&2
  exit 1
else
  echo "  ✗ sabotage build failed unexpectedly (the intact install + sabotage-detect RUN should both succeed)" >&2
  cat "$work/log" >&2
  exit 1
fi
